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
  // a courier form's extra fields ride along in the note
  r = await fetch(base + '/api/lead', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'B', phone: '555', company: 'Acme', timing: 'Today', pickup: 'Marietta', dropoff: 'Decatur', details: 'two boxes' }) });
  assert(r.ok && calls[4].url.endsWith('/contactlog') && /Company: Acme\nWhen: Today\nPickup: Marietta\nDrop-off: Decatur\ntwo boxes/.test(calls[4].body.details.noteText), 'delivery fields kept in the CRM note');
  srv.close();

  // Dispatch intake: the request goes to the board, no second lead, tracking URL back
  process.env.DISPATCH_INTAKE_KEY = 'intake_test';
  const dcalls = [];
  const dstub = async (url, init) => {
    if (!init || !init.body) { dcalls.push({ url, body: null }); return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, suggestions: [{ label: '1100 Howell Mill Road NW, Atlanta, GA, USA', lat: 33.78, lon: -84.41 }] }) }; }
    dcalls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization }); return { ok: true, text: async () => JSON.stringify({ ok: true, trackPath: '/t/tok123' }) };
  };
  app = express();
  crm = mount(app, { business: 'Test Co', group: 'Test', fetch: dstub });
  srv = app.listen(0); base = `http://127.0.0.1:${srv.address().port}`;
  assert(crm.dispatchEnabled() === true, 'dispatch on with the intake key');
  r = await fetch(base + '/api/lead', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'C', phone: '555', email: 'c@d.e', company: 'Acme', service: 'STAT', timing: 'Today', pickup: 'Marietta', dropoff: 'Decatur', details: 'cold chain' }) });
  const dj = await r.json();
  const post = dcalls.find((c) => c.url.includes('/api/dispatch-public/request/intake_test'));
  assert(r.ok && dj.trackUrl === 'https://zahcrm.com/t/tok123', 'visitor gets the tracking URL');
  assert(post && post.body.customerName === 'C' && post.body.customerContact === '555' && post.body.customerEmail === 'c@d.e' && post.body.serviceType === 'STAT' && post.body.preferredWhen === 'Today' && post.body.pickup === 'Marietta' && post.body.dropoff === 'Decatur' && post.body.notes === 'Company: Acme\ncold chain' && !post.auth, 'request posted to the board with the Dispatch field names, no key');
  assert(!dcalls.some((c) => c.url.endsWith('/leads')), 'no duplicate lead while Dispatch is on');
  // the load: flat form fields become the calculator's packageInfo + stops
  r = await fetch(base + '/api/lead', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'E', phone: '555', packageType: 'Box', quantityBand: '2-5', quantityExact: '3', weightBand: '20-50', length: '12', width: '10', height: '8', extraStops: '2', stops: '1 Main St\n2 Oak Ave' }) });
  const lp = dcalls.filter((c) => c.url.includes('/dispatch-public/request/')).pop();
  assert(r.ok && lp.body.packageInfo && lp.body.packageInfo.type === 'Box' && lp.body.packageInfo.quantityBand === '2-5' && lp.body.packageInfo.quantityExact === '3' && lp.body.packageInfo.weightBand === '20-50' && lp.body.packageInfo.length === '12' && lp.body.extraStops === '2' && /Oak Ave/.test(lp.body.stops), 'load fields reach the Dispatch intake as packageInfo + stops');
  // address suggestions proxy: the script is served, the lookup goes to the CRM with the key
  r = await fetch(base + '/zah-crm/address.js');
  assert(r.ok && /data-address/.test(await r.text()), 'address.js is served from the package');
  r = await fetch(base + '/zah-crm/address?q=1100+howell');
  const sug = await r.json();
  const sq = dcalls.find((c) => c.url.includes('/dispatch-public/address/intake_test?q=1100'));
  assert(r.ok && sq && sug.ok === true, 'suggest proxied to the CRM address endpoint with the intake key');
  r = await fetch(base + '/api/lead', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'G', phone: '555', pickup: '364 Nowhere Cir', addressUnverified: 'yes' }) });
  const up = dcalls.filter((c) => c.url.includes('/dispatch-public/request/')).pop();
  assert(r.ok && /ADDRESS NOT VERIFIED/.test(up.body.notes), 'an unverified address is flagged on the request');
  r = await fetch(base + '/api/lead', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'F', phone: '555' }) });
  const np = dcalls.filter((c) => c.url.includes('/dispatch-public/request/')).pop();
  assert(r.ok && np.body.packageInfo === undefined && np.body.extraStops === undefined, 'a plain enquiry sends no empty load');
  // the board is down: falls back to a CRM lead, visitor still succeeds
  const fcalls = [];
  const fstub = async (url, init) => { fcalls.push({ url }); if (url.includes('/dispatch-public/')) return { ok: false, status: 503, text: async () => 'down' }; return { ok: true, text: async () => JSON.stringify({ id: 'lead_2' }) }; };
  srv.close(); app = express(); crm = mount(app, { business: 'Test Co', group: 'Test', fetch: fstub });
  srv = app.listen(0); base = `http://127.0.0.1:${srv.address().port}`;
  r = await fetch(base + '/api/lead', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'D', phone: '555' }) });
  assert(r.ok && (await r.json()).trackUrl === null && fcalls.some((c) => c.url.endsWith('/leads')), 'board down -> CRM lead, visitor still ok');
  srv.close();
  delete process.env.DISPATCH_INTAKE_KEY;
  console.log('\nALL PASSED');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
