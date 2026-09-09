# ZAH CRM Seam

The door between a ZAH client site and ZAH CRM. Standard on every site,
**off until the client has a CRM account**, so switching the CRM on is a
variable change, never a rebuild.

```bash
npm i github:Yawitazah/zah-crm-seam
```

```js
const zahCrm = require('zah-crm-seam');
const crm = zahCrm.mount(app, {
  business: 'New Vision Therapy & Wellness',
  group: 'New Vision',
  leadPath: '/api/lead',
});
```

Mount it before `express.static`. It registers `POST /api/lead` (JSON or a
plain HTML form: `name`, `email`, `phone`, `service`, `message`; `website` is a
honeypot). Browser posts bounce back to the referring page with `?sent=1`.

Delivery and field-service forms can also send `company`, `pickup`,
`dropoff`, `when` (or `timing`) and `details` (an alias of `message`). They
ride into the CRM note and the owner's alert, so nothing typed is lost.

## ZAH Dispatch intake (1.2)

A client on the Dispatch tier has a public **intake key** (ZAH CRM, Dispatch,
settings). Set `DISPATCH_INTAKE_KEY` on the site and the same door becomes an
order intake: the enquiry lands on their Dispatch board as a request, Dispatch
mints the CRM lead itself (so no duplicate), and the JSON answer carries
`trackUrl`, the customer's tracking page. If the board cannot be reached the
enquiry falls back to a CRM lead when leads are on; the visitor always
succeeds. `crm.dispatchEnabled()` for `/healthz`; `crm.createDispatchRequest()`
for anything else on the site that books work.

## What the other products read from it

| | |
|---|---|
| ZAH Site MCP | `crm: { leadPath: crm.leadPath, enabled: crm.leadsEnabled }`, so the client's AI knows whether a form can go to the CRM |
| ZAH Pay | `onPaid: (info) => crm.leadsEnabled() && crm.createLead({...})` |
| the site | `crm.createInvoice(...)` for a pay page, `crm.leadsEnabled()` for `/healthz` |

## Environment

| Variable | Set by | What |
|---|---|---|
| `ZAH_CRM_API_KEY` | ZAH Onboarding when the client adds the CRM | **The client's own key**, minted for their account. Never Zah's developer key. Server-side only. |
| `CRM_LEADS_ENABLED` | same | `true`: enquiries and purchases become leads in the client's CRM |
| `CRM_GROUP` | same | the lead group, default the business name |
| `CRM_BUSINESS` | same | on invoices |
| `CRM_INVOICES_ENABLED`, `CASHAPP_HANDLE` | by hand | tracked ZAH invoices from the site |
| `DISPATCH_INTAKE_KEY` | ZAH Onboarding on the Dispatch tier | the account's public intake key: enquiries become requests on the Dispatch board, visitors get a tracking page |
| `NOTIFY_EMAIL_TO`, `NOTIFY_SMS_TO` | the client, from their account page | where enquiry alerts go |
| `MAILGUN_API_KEY` `MAILGUN_DOMAIN` `MAILGUN_FROM` (`MAILGUN_REGION`) | same | owner email alerts via Mailgun; or `ZEPTOMAIL_TOKEN`+`ZEPTOMAIL_FROM`, or `RESEND_API_KEY`+`RESEND_FROM` |
| `TWILIO_ACCOUNT_SID` `TWILIO_AUTH_TOKEN` `TWILIO_FROM` | same | owner text alerts via Twilio |

With none set: enquiries are logged to the deploy log and nothing else
happens. The visitor always gets a success; a lost lead is the client's money,
a spam message costs nothing.

## Test

`npm test`: off-state, validation, HTML bounce, honeypot, lead + note with a
stubbed CRM, invoice.
