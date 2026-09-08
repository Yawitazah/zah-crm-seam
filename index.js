/* =========================================================
   ZAH CRM SEAM

   The door between a ZAH client site and ZAH CRM. Standard on every site,
   switched OFF until the client has a CRM account, so a site ships with the
   plumbing in place and turning the CRM on is a variable change, never a
   rebuild. Extracted from the Already Carriers and New Vision sites on
   2026-09-04.

   ONE ENTRY POINT:

     const zahCrm = require('zah-crm-seam');
     const crm = zahCrm.mount(app, {
       business: 'New Vision Therapy & Wellness',   // default CRM_BUSINESS
       group: 'New Vision',                          // default CRM_GROUP (the lead group)
       leadPath: '/api/lead',                        // the form door, default
     });

   What it registers: POST <leadPath>, accepting JSON or a plain HTML form
   post (name, email, phone, service, message; `website` is a honeypot).
   Every enquiry is logged; when the seam is ON it also becomes a lead in
   the client's CRM. Browser form posts are sent back to the referring page
   with ?sent=1 (or ?sent=0 when a required field is missing).

   OWNER NOTIFICATIONS (1.1): every enquiry can also email and text the
   owner straight from the site, with Mailgun / ZeptoMail / Resend and
   Twilio credentials in the environment. No CRM required; with the CRM,
   both happen. See notify.js. A test endpoint sits at <leadPath>/test
   (POST, needs the site's own token in Authorization: Bearer).

   What it returns, for the other products to read:
     crm.notify()            { email: {provider,on}, sms: {provider,on} } for /healthz
     crm.leadsEnabled()      ZAH_CRM_API_KEY + CRM_LEADS_ENABLED=true
     crm.invoicesEnabled()   ZAH_CRM_API_KEY + CRM_INVOICES_ENABLED=true
     crm.createLead(...)     used by ZAH Pay's onPaid
     crm.createInvoice(...)  tracked ZAH invoice, hosted page URL back
     crm.leadPath            what ZAH Site MCP tells the client's AI

   SECURITY, the whole reason this is on the server: ZAH_CRM_API_KEY is a
   live credential. It is read from the environment here, used here, and
   sent nowhere but the CRM. It is THE CLIENT'S key (minted for their own
   account when they add the CRM), never Zah's developer key.
   ========================================================= */

const notify = require('./notify');

function mount(app, cfg = {}) {
  if (!app || typeof app.post !== 'function') throw new Error('zah-crm-seam: mount(app, cfg) needs an Express app');
  const express = cfg.express || require('express');
  const API_BASE = String(cfg.apiBase || process.env.ZAH_CRM_API_BASE || 'https://zahcrm.com/api').replace(/\/$/, '');
  const apiKey = () => String(cfg.apiKey || process.env.ZAH_CRM_API_KEY || '');
  const business = () => String(process.env.CRM_BUSINESS || cfg.business || 'ZAH client');
  const group = () => String(process.env.CRM_GROUP || cfg.group || business());
  const cashApp = () => String(process.env.CASHAPP_HANDLE || cfg.cashAppHandle || '');
  const leadPath = cfg.leadPath || '/api/lead';
  const doFetch = cfg.fetch || fetch;

  const leadsEnabled = () => process.env.CRM_LEADS_ENABLED === 'true' && !!apiKey();
  const invoicesEnabled = () => process.env.CRM_INVOICES_ENABLED === 'true' && !!apiKey();

  async function call(path, body) {
    const res = await doFetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(text.slice(0, 300) || `HTTP ${res.status}`);
    return text ? JSON.parse(text) : null;
  }

  /** A lead in the client's CRM, with the message as a timeline note so nothing typed is lost. */
  async function createLead({ name, email, phone, service, message, status }) {
    if (!leadsEnabled()) throw new Error('ZAH CRM leads are not enabled on this site');
    const lead = await call('/leads', {
      name, email, phone,
      group: group(),
      status: status || 'new',
      notes: service ? `Service requested: ${service}` : '',
    });
    if (lead && lead.id && message) {
      try { await call('/contactlog', { leadId: lead.id, type: 'note', details: { noteText: message } }); }
      catch (e) { console.warn('[zah-crm] lead created but note failed:', e.message); }
    }
    return lead;
  }

  /** A tracked ZAH invoice; the customer pays on the hosted page, this site never sees card details. */
  async function createInvoice({ customerName, customerEmail, items, dueDate, memo }) {
    if (!invoicesEnabled()) throw new Error('ZAH CRM invoices are not enabled on this site');
    const invoice = await call('/money/zah-invoices', {
      business: business(), customerName, customerEmail, items, dueDate,
      cashAppHandle: cashApp(), paymentNote: `${business()} service`, memo: memo || '',
    });
    return { id: invoice && invoice.id, hostedInvoiceUrl: invoice && invoice.hostedInvoiceUrl };
  }

  const clean = (v, max = 400) => String(v == null ? '' : v).trim().slice(0, max);

  // ---------- the form door ----------
  app.post(leadPath, express.json({ limit: '32kb' }), express.urlencoded({ extended: false, limit: '32kb' }), async (req, res) => {
    const b = req.body || {};
    const wantsHtml = !req.is('application/json') && /text\/html/.test(req.headers.accept || '');
    const back = (req.get('referer') || '/').split('#')[0];
    const bounce = (ok) => res.redirect(303, back + (back.includes('?') ? '&' : '?') + (ok ? 'sent=1' : 'sent=0') + '#form');
    if (clean(b.website)) return wantsHtml ? bounce(true) : res.json({ ok: true }); // honeypot
    const name = clean(b.name, 120), email = clean(b.email, 160), phone = clean(b.phone, 40);
    const service = clean(b.service, 80), message = clean(b.message, 2000);
    if (!name || (!email && !phone)) {
      if (wantsHtml) return bounce(false);
      return res.status(400).json({ error: 'Please include your name and either an email or a phone number.' });
    }
    console.log('[lead]', JSON.stringify({ at: new Date().toISOString(), name, email, phone, service, message }));
    if (leadsEnabled()) {
      try { await createLead({ name, email, phone, service, message }); }
      catch (e) { console.error('[lead] CRM lead failed:', e.message); }
    }
    // The owner hears about it on every channel that is set up, CRM or not.
    notify.notifyLead(doFetch, business(), { name, email, phone, service, message }).catch(() => {});
    if (typeof cfg.onLead === 'function') { try { await cfg.onLead({ name, email, phone, service, message }); } catch (e) { /* the visitor already succeeded */ } }
    if (wantsHtml) return bounce(true);
    res.json({ ok: true });
  });

  // "Send a test" from the account page. Gated on the site's own token
  // (SITE_MCP_TOKEN, the same one that lets the client's AI in), so a
  // stranger cannot make the site text its owner.
  app.post(`${leadPath}/test`, express.json({ limit: '4kb' }), async (req, res) => {
    const token = String(process.env.SITE_MCP_TOKEN || cfg.testToken || '');
    const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    if (!token || !m || m[1].trim() !== token) return res.status(401).json({ error: 'Unauthorized' });
    const channel = req.body && req.body.channel === 'sms' ? 'sms' : 'email';
    try {
      const r = await notify.sendTest(doFetch, business(), channel);
      if (r.skipped) return res.status(400).json({ error: `${channel === 'sms' ? 'Text' : 'Email'} alerts are not set up on this site yet.` });
      if (!r.ok) return res.status(502).json({ error: r.error || 'Send failed.' });
      res.json({ ok: true, channel });
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  const st = notify.status();
  console.log(`[zah-crm] leads ${leadsEnabled() ? 'ON' : 'off'}, invoices ${invoicesEnabled() ? 'ON' : 'off'}, door ${leadPath}, owner email ${st.email.on ? st.email.provider : 'off'}, owner sms ${st.sms.on ? st.sms.provider : 'off'}`);
  return { leadsEnabled, invoicesEnabled, createLead, createInvoice, leadPath, business, group, notify: notify.status };
}

module.exports = { mount };
