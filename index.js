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
   both happen. See notify.js. A test endpoint sits at POST /zah-crm/test (and
   <leadPath>/test), needing the site's own token in Authorization: Bearer.

   ZAH DISPATCH INTAKE (1.2): a client on the Dispatch tier has a public
   intake key (Dispatch settings in ZAH CRM). With DISPATCH_INTAKE_KEY set,
   the same door becomes an ORDER INTAKE: the enquiry lands on the client's
   Dispatch board as a request, Dispatch mints the CRM lead itself, and the
   visitor is answered with a tracking page (`trackUrl`). The door also reads
   the delivery fields a courier form asks for: company, pickup, dropoff,
   when (or timing), and details as an alias of message. Off, it is a lead
   as before; nothing on the page changes between the two.

   What it returns, for the other products to read:
     crm.notify()            { email: {provider,on}, sms: {provider,on} } for /healthz
     crm.leadsEnabled()      ZAH_CRM_API_KEY + CRM_LEADS_ENABLED=true
     crm.invoicesEnabled()   ZAH_CRM_API_KEY + CRM_INVOICES_ENABLED=true
     crm.dispatchEnabled()   DISPATCH_INTAKE_KEY is set
     crm.createLead(...)     used by ZAH Pay's onPaid
     crm.createInvoice(...)  tracked ZAH invoice, hosted page URL back
     crm.createDispatchRequest(...)  a request on the Dispatch board, tracking URL back
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

  // ZAH Dispatch. The intake key is public by design (it is the address a
  // website posts orders to, like embedCapture's site key), so it needs no
  // API key and works before the client has connected their CRM key.
  const dispatchKey = () => String(cfg.dispatchIntakeKey || process.env.DISPATCH_INTAKE_KEY || '');
  const dispatchEnabled = () => !!dispatchKey();
  const CRM_ORIGIN = API_BASE.replace(/\/api$/, '');

  /** A request on the client's Dispatch board. Dispatch finds or mints the CRM lead itself.
   *  `packageInfo`, `extraStops` and `stops` are the load, in the shape the
   *  calculator reads (see DispatchPackageFields in the CRM); the office's
   *  calculator opens already filled in. */
  async function createDispatchRequest({ name, email, phone, company, service, when, pickup, dropoff, message, packageInfo, extraStops, stops }) {
    if (!dispatchEnabled()) throw new Error('ZAH Dispatch intake is not enabled on this site');
    const res = await doFetch(`${CRM_ORIGIN}/api/dispatch-public/request/${encodeURIComponent(dispatchKey())}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerName: name, customerContact: phone, customerEmail: email,
        pickup, dropoff, serviceType: service, preferredWhen: when,
        notes: [company ? `Company: ${company}` : '', message].filter(Boolean).join('\n'),
        ...(packageInfo ? { packageInfo } : {}),
        ...(extraStops ? { extraStops } : {}),
        ...(stops ? { stops } : {}),
      }),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(text.slice(0, 300) || `HTTP ${res.status}`);
    const data = text ? JSON.parse(text) : {};
    const trackPath = data && data.trackPath ? String(data.trackPath) : null;
    return { trackPath, trackUrl: trackPath ? `${CRM_ORIGIN}${trackPath}` : null };
  }

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
    const service = clean(b.service, 80), message = clean(b.message || b.details || b.notes, 2000);
    // The delivery fields a courier or field-service form asks for. Empty on
    // an ordinary contact form and then simply absent from everything below.
    const company = clean(b.company, 140), pickup = clean(b.pickup, 300), dropoff = clean(b.dropoff, 300);
    const when = clean(b.when || b.timing || b.preferredWhen, 160);
    // The load, for a Dispatch request: what the calculator prices, as the
    // customer could answer it. Flat names so a plain HTML form can send
    // them (packageType, quantityBand, quantityExact, weightBand,
    // weightExact, length, width, height, extraStops, stops); a nested
    // `packageInfo` object is accepted too. Empty on an ordinary contact
    // form and then simply absent from everything below.
    const pk = b.packageInfo && typeof b.packageInfo === 'object' ? b.packageInfo : {};
    const packageInfo = {
      type: clean(pk.type || b.packageType, 60),
      quantityBand: clean(pk.quantityBand || b.quantityBand, 20), quantityExact: clean(pk.quantityExact || b.quantityExact, 10),
      weightBand: clean(pk.weightBand || b.weightBand, 20), weightExact: clean(pk.weightExact || b.weightExact, 12),
      length: clean(pk.length || b.length, 8), width: clean(pk.width || b.width, 8), height: clean(pk.height || b.height, 8),
    };
    const hasPackage = Object.values(packageInfo).some(Boolean);
    const extraStops = clean(b.extraStops, 3), stops = clean(b.stops, 600);
    // The form could not match an address to a real place and the visitor
    // sent it anyway. The office confirms before pricing, and the note says so.
    const addressUnverified = /^(yes|true|1)$/i.test(clean(b.addressUnverified, 8));
    const load = [
      packageInfo.type,
      packageInfo.quantityExact ? `${packageInfo.quantityExact} pcs` : packageInfo.quantityBand ? `qty ${packageInfo.quantityBand}` : '',
      packageInfo.weightExact ? `${packageInfo.weightExact} lb` : packageInfo.weightBand ? `${packageInfo.weightBand} lb` : '',
      packageInfo.length && packageInfo.width && packageInfo.height ? `${packageInfo.length}×${packageInfo.width}×${packageInfo.height} in` : '',
      extraStops && extraStops !== '0' ? `${extraStops} extra stop(s)${stops ? `: ${stops}` : ''}` : '',
    ].filter(Boolean).join(', ');
    if (!name || (!email && !phone)) {
      if (wantsHtml) return bounce(false);
      return res.status(400).json({ error: 'Please include your name and either an email or a phone number.' });
    }
    // One block of text that keeps every field, for the CRM note and the
    // owner's alert. Nothing typed into the form is lost on the way.
    const detail = [
      company ? `Company: ${company}` : '', when ? `When: ${when}` : '',
      pickup ? `Pickup: ${pickup}` : '', dropoff ? `Drop-off: ${dropoff}` : '',
      addressUnverified ? 'ADDRESS NOT VERIFIED: the form could not match it to a real place. Confirm before pricing.' : '',
      load ? `Load: ${load}` : '', message,
    ].filter(Boolean).join('\n');
    console.log('[lead]', JSON.stringify({ at: new Date().toISOString(), name, email, phone, service, company, when, pickup, dropoff, load, message }));

    let trackUrl = null;
    if (dispatchEnabled()) {
      // Dispatch is the record: it minted the lead, so no second lead here.
      // If the board cannot be reached the enquiry still becomes a lead when
      // the CRM is on, and the owner is still told either way.
      try {
        trackUrl = (await createDispatchRequest({
          name, email, phone, company, service, when, pickup, dropoff,
          message: addressUnverified ? `ADDRESS NOT VERIFIED — confirm before pricing.\n${message}`.trim() : message,
          packageInfo: hasPackage ? packageInfo : undefined, extraStops, stops,
        })).trackUrl;
      }
      catch (e) {
        console.error('[lead] Dispatch request failed:', e.message);
        if (leadsEnabled()) { try { await createLead({ name, email, phone, service, message: detail }); } catch (e2) { console.error('[lead] CRM lead failed:', e2.message); } }
      }
    } else if (leadsEnabled()) {
      try { await createLead({ name, email, phone, service, message: detail }); }
      catch (e) { console.error('[lead] CRM lead failed:', e.message); }
    }
    // The owner hears about it on every channel that is set up, CRM or not.
    notify.notifyLead(doFetch, business(), { name, email, phone, service, message: trackUrl ? `${detail}\nTracking: ${trackUrl}`.trim() : detail }).catch(() => {});
    if (typeof cfg.onLead === 'function') { try { await cfg.onLead({ name, email, phone, service, message, company, when, pickup, dropoff, trackUrl }); } catch (e) { /* the visitor already succeeded */ } }
    if (wantsHtml) return bounce(true);
    res.json({ ok: true, trackUrl });
  });

  // "Send a test" from the account page. Gated on the site's own token
  // (SITE_MCP_TOKEN, the same one that lets the client's AI in), so a
  // stranger cannot make the site text its owner.
  const testHandler = async (req, res) => {
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
  };
  // Fixed address for the account page, plus the door's own, whatever the door is called.
  app.post('/zah-crm/test', express.json({ limit: '4kb' }), testHandler);
  app.post(`${leadPath}/test`, express.json({ limit: '4kb' }), testHandler);

  // ---------- address suggestions (1.4) ----------
  // The "pick it as you type" list for any input marked data-address, from the
  // same provider the Dispatch calculator uses for mileage. Proxied here so the
  // browser never learns the intake key's shape or the CRM's host. 503 when
  // Dispatch is not on this site, which the client script reads as "type it".
  const addressJs = require('path').join(__dirname, 'address.js');
  app.get('/zah-crm/address.js', (_req, res) => {
    res.type('application/javascript');
    // Revalidate on every visit (a 304 is nearly free) rather than cache for
    // an hour: a fix to this file should reach a browser on the next load,
    // not sixty minutes later. Same rule the sites use for their own JS.
    res.set('Cache-Control', 'no-cache');
    res.sendFile(addressJs);
  });
  const suggestHandler = async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!dispatchEnabled()) return res.status(503).json({ error: 'not_available' });
    const q = String(req.query.q || '').trim().slice(0, 200);
    if (q.length < 3) return res.json({ ok: true, suggestions: [] });
    try {
      const r = await doFetch(`${CRM_ORIGIN}/api/dispatch-public/address/${encodeURIComponent(dispatchKey())}?q=${encodeURIComponent(q)}`, {
        headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000),
      });
      if (r.status === 503 || r.status === 404) return res.status(503).json({ error: 'not_available' });
      if (!r.ok) return res.status(502).json({ error: 'lookup_failed' });
      const text = await r.text();
      res.type('application/json').send(text);
    } catch (e) {
      res.status(502).json({ error: 'lookup_failed' });
    }
  };
  app.get('/zah-crm/address', suggestHandler);
  app.get(`${leadPath}/address`, suggestHandler);

  const st = notify.status();
  console.log(`[zah-crm] leads ${leadsEnabled() ? 'ON' : 'off'}, invoices ${invoicesEnabled() ? 'ON' : 'off'}, dispatch ${dispatchEnabled() ? 'ON' : 'off'}, door ${leadPath}, owner email ${st.email.on ? st.email.provider : 'off'}, owner sms ${st.sms.on ? st.sms.provider : 'off'}`);
  return { leadsEnabled, invoicesEnabled, dispatchEnabled, createLead, createInvoice, createDispatchRequest, leadPath, business, group, notify: notify.status };
}

module.exports = { mount };
