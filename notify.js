/* =========================================================
   OWNER NOTIFICATIONS, site-level

   The site tells its owner about every enquiry, by email and by text, with
   nothing but environment variables: no CRM needed. A client with the CRM
   gets both: the lead in the pipeline AND the buzz on the phone. Zah,
   2026-09-08: "if they do not have the CRM services and they're using just
   the website... they want to connect these tools, third party route, so
   be it. This is just where they were plugging in at."

   Variables (all optional; nothing set means nothing sent, never an error):

     NOTIFY_EMAIL_TO        where enquiry emails go
     NOTIFY_SMS_TO          where enquiry texts go (E.164 or 10 digits)

     Email, first one configured wins:
     MAILGUN_API_KEY, MAILGUN_DOMAIN, MAILGUN_FROM, MAILGUN_REGION (us|eu)
     ZEPTOMAIL_TOKEN, ZEPTOMAIL_FROM
     RESEND_API_KEY, RESEND_FROM

     SMS:
     TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM

   Every send is best effort and logged; the visitor's form has already
   succeeded before any of this runs.
   ========================================================= */

const e164 = (v) => {
  const d = String(v || '').replace(/[^\d+]/g, '');
  if (!d) return '';
  if (d.startsWith('+')) return d;
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d.startsWith('1')) return '+' + d;
  return '+' + d;
};
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const env = (k) => String(process.env[k] || '').trim();

function emailProvider() {
  if (env('MAILGUN_API_KEY') && env('MAILGUN_DOMAIN') && env('MAILGUN_FROM')) return 'mailgun';
  if (env('ZEPTOMAIL_TOKEN') && env('ZEPTOMAIL_FROM')) return 'zeptomail';
  if (env('RESEND_API_KEY') && env('RESEND_FROM')) return 'resend';
  return null;
}
function smsProvider() {
  return env('TWILIO_ACCOUNT_SID') && env('TWILIO_AUTH_TOKEN') && env('TWILIO_FROM') ? 'twilio' : null;
}

/** What the site can do right now. Safe to put on /healthz. */
function status() {
  return {
    email: { provider: emailProvider(), to: env('NOTIFY_EMAIL_TO') ? true : false, on: !!(emailProvider() && env('NOTIFY_EMAIL_TO')) },
    sms: { provider: smsProvider(), to: env('NOTIFY_SMS_TO') ? true : false, on: !!(smsProvider() && env('NOTIFY_SMS_TO')) },
  };
}

async function sendEmail(doFetch, { to, subject, html, text }) {
  const p = emailProvider();
  if (!p || !to) return { ok: false, skipped: true };
  if (p === 'mailgun') {
    const host = env('MAILGUN_REGION') === 'eu' ? 'api.eu.mailgun.net' : 'api.mailgun.net';
    const form = new URLSearchParams({ from: env('MAILGUN_FROM'), to, subject, html, text });
    const r = await doFetch(`https://${host}/v3/${encodeURIComponent(env('MAILGUN_DOMAIN'))}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`api:${env('MAILGUN_API_KEY')}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(), signal: AbortSignal.timeout(15000),
    });
    return r.ok ? { ok: true } : { ok: false, error: `Mailgun ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}` };
  }
  if (p === 'zeptomail') {
    const tok = env('ZEPTOMAIL_TOKEN');
    const r = await doFetch('https://api.zeptomail.com/v1.1/email', {
      method: 'POST',
      headers: { Authorization: tok.startsWith('Zoho-enczapikey') ? tok : `Zoho-enczapikey ${tok}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ from: { address: env('ZEPTOMAIL_FROM') }, to: [{ email_address: { address: to } }], subject, htmlbody: html, textbody: text }),
      signal: AbortSignal.timeout(15000),
    });
    return r.ok ? { ok: true } : { ok: false, error: `ZeptoMail ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}` };
  }
  const r = await doFetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env('RESEND_FROM'), to: [to], subject, html, text }),
    signal: AbortSignal.timeout(15000),
  });
  return r.ok ? { ok: true } : { ok: false, error: `Resend ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}` };
}

async function sendSms(doFetch, { to, body }) {
  if (!smsProvider() || !to) return { ok: false, skipped: true };
  const sid = env('TWILIO_ACCOUNT_SID');
  const params = new URLSearchParams({ To: e164(to), From: e164(env('TWILIO_FROM')), Body: String(body).slice(0, 1500) });
  const r = await doFetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${env('TWILIO_AUTH_TOKEN')}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(), signal: AbortSignal.timeout(15000),
  });
  return r.ok ? { ok: true } : { ok: false, error: `Twilio ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}` };
}

/** Tell the owner about one enquiry on every channel that is set up. Never throws. */
async function notifyLead(doFetch, business, lead) {
  const rows = [['Name', lead.name], ['Email', lead.email], ['Phone', lead.phone], ['Service', lead.service], ['Message', lead.message]].filter(([, v]) => v);
  const subject = `New enquiry for ${business}: ${lead.name}`;
  const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n');
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#1F2A44;"><h2 style="margin:0 0 12px;font-size:18px;">New enquiry for ${esc(business)}</h2><table cellpadding="0" cellspacing="0">${rows.map(([k, v]) => `<tr><td style="padding:4px 14px 4px 0;color:#6b7280;vertical-align:top;">${esc(k)}</td><td style="padding:4px 0;white-space:pre-wrap;">${esc(v)}</td></tr>`).join('')}</table><p style="margin-top:16px;font-size:12px;color:#9ca3af;">Sent by your website the moment the form was submitted.</p></div>`;
  const out = {};
  try { out.email = await sendEmail(doFetch, { to: env('NOTIFY_EMAIL_TO'), subject, html, text }); } catch (e) { out.email = { ok: false, error: e.message }; }
  try {
    const sms = [`New enquiry for ${business}`, [lead.name, lead.phone || lead.email].filter(Boolean).join(' · '), lead.service ? `Service: ${lead.service}` : '', (lead.message || '').slice(0, 140)].filter(Boolean).join('\n');
    out.sms = await sendSms(doFetch, { to: env('NOTIFY_SMS_TO'), body: sms });
  } catch (e) { out.sms = { ok: false, error: e.message }; }
  for (const k of Object.keys(out)) if (out[k] && out[k].error) console.warn(`[zah-crm] owner ${k} failed:`, out[k].error);
  return out;
}

/** A one-line test on a channel, for the account page's "Send test". */
async function sendTest(doFetch, business, channel) {
  if (channel === 'sms') return sendSms(doFetch, { to: env('NOTIFY_SMS_TO'), body: `Test from ${business}: text alerts are working.` });
  return sendEmail(doFetch, { to: env('NOTIFY_EMAIL_TO'), subject: `Test from ${business}: email alerts are working`, html: `<p>If you can read this, new enquiries from your website will land here instantly.</p>`, text: 'If you can read this, new enquiries from your website will land here instantly.' });
}

module.exports = { status, notifyLead, sendTest, emailProvider, smsProvider, e164 };
