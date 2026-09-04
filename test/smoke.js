const express = require('express');
const { mount } = require('..');
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } console.log('ok  ', m); };

(async () => {
  // off
  delete process.env.CRM_LEADS_ENABLED; delete process.env.ZAH_CRM_API_KEY;
  let app = express();
  let crm = mount(app, { business: 'Test Co', group: 'Test' });
  let srv = app.listen(0); let base = `http://127.0.0.1:${srv.address().port}`;
  assert(crm.leadsEnabled() === false && crm.leadPath === '/api/lead', 'off by default');
  let r = await fetch(base + '/api/lead', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'A', email: 'a@b.c' }) });
  assert(r.ok && (await r.json()).ok === true, 'json lead accepted while off (logged only)');
  r = await fetch(base + '/api/lead', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'A' }) });
  assert(r.status === 400, 'missing contact -> 400');
  r = await fetch(base + '/api/lead', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html', Referer: base + '/about' }, body: 'name=Form+Person&email=f@p.io' });
  assert(r.status === 303 && r.headers.get('location') === base + '/about?sent=1#form', 'html form post bounces back with ?sent=1');
  r = await fetch(base + '/api/lead', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Bot', email: 'x@y.z', website: 'spam' }) });
  assert(r.ok, 'honeypot swallowed');
  srv.close();

  // on, with a stub CRM
  process.env.CRM_LEADS_ENABLED = 'true'; process.env.ZAH_CRM_API_KEY = 'zah_live_test';
  const calls = [];
  const stub = async (url, init) => { calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization }); return { ok: true, text: async () => JSON.stringify({ id: 'lead_1' }) }; };
  app = express();
  crm = mount(app, { business: 'Test Co', group: 'Test', fetch: stub });
  srv = app.listen(0); base = `http://127.0.0.1:${srv.address().port}`;
  assert(crm.leadsEnabled() === true, 'on with key + flag');
  r = await fetch(base + '/api/lead', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'A', email: 'a@b.c', service: 'Restore', message: 'hi' }) });
  assert(r.ok && calls.length === 2 && calls[0].url.endsWith('/leads') && calls[0].body.group === 'Test' && calls[0].auth === 'Bearer zah_live_test' && calls[1].url.endsWith('/contactlog'), 'lead + note posted to the CRM with the key');
  const inv = await (async () => { process.env.CRM_INVOICES_ENABLED = 'true'; return crm.createInvoice({ customerName: 'A', customerEmail: 'a@b.c', items: [{ description: 'x', amount: 1 }] }); })();
  assert(calls[2].url.endsWith('/money/zah-invoices') && calls[2].body.business === 'Test Co', 'invoice created through the seam');
  srv.close();
  console.log('\nALL PASSED');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
