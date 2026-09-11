# @huloglobal/vendure-plugin-checkout-guard

<p><img src="./logo.svg" width="56" height="56" alt=""></p>

The safety layer around Vendure checkout and payments. Vendure's Stripe
integration settles a payment when the intent succeeds — and nothing else.
Put a manual-capture hold on a large order and the customer sees a
confirmation page while the order never places and the authorisation
silently expires. Enable bank transfer and there is no expiry, no reminder,
no reconciliation. A card declines and no one ever knows. Checkout Guard
closes those gaps server-side and shows you all of it in one admin page.

**Plugin page & pricing:** https://huloglobal.com/vendure-plugins/checkout-guard/

## What it does

| Module | What you get |
|---|---|
| **Stripe holds** | `stripe-hold` payment handler + signed webhook for `payment_intent.amount_capturable_updated` → an *Authorized* payment, order placed as `PaymentAuthorized`. Capture / cancel from the admin, safety capture before Stripe's 7-day window, `payment_failed` recorded. |
| **Bank transfer** | `bank-transfer` handler with the account details in the payment's **public metadata** (storefronts render them), eligibility checker (min / max, guests, customer groups), auto-expiry after N days, reminder event, admin *received* / *cancel*. |
| **Guards** | Session-bound anonymous `orderByCode`; trusted client-IP contract for server-side proxies; token-bucket rate limits on checkout mutations. |
| **Observability** | Payment-event log (failed, client-declined, orphan, amount drift, expired), nightly Stripe reconciliation per channel, amount-drift guard, checkout funnel events with drop-off, ops alerts (Slack / Discord / Teams / Telegram / signed webhook / email). |
| **Admin dashboard** | *Sales → Checkout Guard*: Overview, Holds, Bank transfers, Payment events, Funnel, Settings, Licence & billing. |

## Install

```bash
yarn add @huloglobal/vendure-plugin-checkout-guard
```

```ts
import { CheckoutGuardPlugin, SessionBoundOrderByCodeAccessStrategy } from '@huloglobal/vendure-plugin-checkout-guard';

export const config: VendureConfig = {
    orderOptions: {
        // Anonymous orderByCode only from the session that placed the order.
        orderByCodeAccessStrategy: new SessionBoundOrderByCodeAccessStrategy('2h'),
    },
    plugins: [
        CheckoutGuardPlugin.init({
            publicBaseUrl: 'https://api.example.com',
            licenceKey: process.env.HULO_LICENCE_KEY_CHECKOUT_GUARD,
            stripe: { webhookSecret: process.env.STRIPE_CG_WEBHOOK_SECRET, safetyCaptureDays: 6 },
            bankTransfer: { expiryDays: 7, reminderAfterDays: 3 },
            reconciliation: { enabled: true, lookbackDays: 3 },
            trustedClientIp: { secret: process.env.CHECKOUT_GUARD_PROXY_SECRET },
            ops: { slackWebhookUrl: process.env.OPS_SLACK_WEBHOOK_URL, adminEmail: 'ops@example.com' },
        }),
    ],
};
```

Admin UI: add `CheckoutGuardPlugin.uiExtensions` to your `compileUiExtensions`
list. The plugin adds an Order custom field `cgSessionHash` — run your
migrations (or `synchronize`) after install:

```sql
ALTER TABLE `order` ADD `customFieldsCgsessionhash` varchar(64) NULL;
```

Tables `checkout_guard_payment_event`, `checkout_guard_funnel_event` and
`checkout_guard_bank_transfer` are created on boot (MySQL / MariaDB /
PostgreSQL via the licence SDK's dialect adapter).

## Stripe holds

1. In the Vendure admin create a **payment method per channel** with handler
   *Stripe hold* (`stripe-hold`). It has no arguments: it reads the channel's
   Stripe secret key from the channel's existing Stripe payment method.
2. In Stripe create a webhook endpoint at
   `https://<api>/checkout-guard/stripe-webhook` for
   `payment_intent.amount_capturable_updated`, `payment_intent.payment_failed`
   and `payment_intent.canceled`. Put the signing secret in
   `stripe.webhookSecret`, or per channel in
   `STRIPE_CG_WEBHOOK_SECRET_<CHANNELCODE>` (upper-cased, non-alphanumerics →
   `_`; the default channel is `STRIPE_CG_WEBHOOK_SECRET_DEFAULT_CHANNEL`).
3. Create PaymentIntents with `capture_method: 'manual'` where you want a
   hold (Vendure's `StripePlugin.init({ paymentIntentCreateParams })`).

When the customer confirms, Stripe emits `amount_capturable_updated`; the
plugin verifies the signature (raw body, never a fallback), resolves the
channel from the intent's Vendure metadata, moves the order to
`ArrangingPayment` if needed and adds an **Authorized** payment. The order
is placed. Capture it from *Checkout Guard → Holds* (settles the payment)
or from the order page; cancel releases the hold. The safety cron captures
any hold older than `safetyCaptureDays` (default 6) and alerts you.
Storefronts should treat `PaymentAuthorized` as "payment authorised, under
review".

## Bank transfer

Create a payment method with handler *Bank transfer* (`bank-transfer`) and
fill in account name, number, sort code, IBAN, BIC, instructions and expiry
days; optionally add the *Bank transfer eligibility* checker. When the
storefront calls `addPaymentToOrder(method: 'bank-transfer')` the order
becomes `PaymentAuthorized` and the payment's `metadata.public` carries
`{ accountName, accountNumber, sortCode, iban, bic, reference, amountMinor,
currency, payBy, instructions }` — render that on the payment step and on
the confirmation page while the order is `PaymentAuthorized`. Unpaid orders
expire after `expiryDays` (cancelled, `BankTransferExpiredEvent`); a
`BankTransferReminderEvent` fires once after `reminderAfterDays` — subscribe
to both to email the customer. Mark money received from the dashboard.

## Guards

- **Session-bound order lookup.** Vendure's default lets anyone with an
  order code read a fresh order for two hours. The strategy above allows the
  owner, or an anonymous session whose token hash matches the one stored on
  the order at creation. Pass `{ allowUnboundOrders: true }` to keep the
  default behaviour for orders created before install.
- **Trusted client IP.** Your storefront's server-side proxy forwards the
  real IP in `x-real-client-ip` and proves itself with
  `x-checkout-guard-proxy: <secret>`. Without the secret the header is
  stripped, so nothing downstream (fraud scoring, logs) can be spoofed by a
  browser. Use `getClientIp(req)` in your own code.
- **Rate limits.** Defaults: `applyCouponCode` 10/min, `addPaymentToOrder`
  6/min, `createStripePaymentIntent` 6/min, `transitionOrderToState` 20/min
  per client IP; override with `rateLimits.mutations`. Limited requests get
  `429 { errors: [{ message: 'rate_limited' }] }`.

## Observability

- `POST /checkout-guard/client-decline { orderCode, code, message, paymentIntentId?, amountMinor?, currency? }` —
  the storefront reports synchronous `confirmPayment` failures (Stripe sends
  no webhook for those). Rate limited, always 200.
- `POST /checkout-guard/funnel { step, orderCode?, sessionId?, detail? }` with
  `step` ∈ `cart | address | payment | pay_attempt | pay_failed | coupon_rejected | placed`.
- Reconciliation runs daily at 04:10 on the worker: every succeeded or held
  PaymentIntent in the last `lookbackDays` is matched to a Vendure payment;
  unmatched ones are logged as `orphan` and alerted. `POST /checkout-guard/reconcile/run` runs it now.
- A settled payment whose amount differs from the order total is logged as
  `amount_drift` and alerted.
- `countRecentFailures(ip, minutes)` on `ObservabilityService` is what the
  HULO Fraud Prevention plugin uses for its *failed payments* signal.

## Endpoints

| Method | Path | Who |
|---|---|---|
| POST | `/checkout-guard/stripe-webhook` | Stripe (signed) |
| GET | `/checkout-guard/holds?due=` | Admin |
| POST | `/checkout-guard/holds/:paymentId/capture` · `/cancel` | Admin |
| GET | `/checkout-guard/bank-transfers?status=awaiting|expired|settled|cancelled|all` | Admin |
| POST | `/checkout-guard/bank-transfers/:paymentId/received` · `/cancel` | Admin |
| POST | `/checkout-guard/client-decline` | Public (rate limited) |
| POST | `/checkout-guard/funnel` | Public (rate limited) |
| GET | `/checkout-guard/events?kind=&days=` · `/summary` · `/funnel/summary?days=` | Admin |
| POST | `/checkout-guard/reconcile/run` | Admin |
| GET | `/checkout-guard/meta` · `/settings` | Admin |
| POST | `/checkout-guard/licence/activate` · `/deactivate` · `/purchase-link` · `/portal-link`, GET `/licence/claim-status` | Admin |

## Tiers

**Free:** session-bound order lookup, trusted client IP, rate limits, funnel
events, the bank-transfer handler and checker, the dashboard.
**Licensed (or the 14-day card-backed trial):** Stripe hold handling, bank-transfer
auto-expiry and reminders, failed-payment recording, reconciliation, the
amount-drift guard and ops alerts. Start the trial or buy from the admin
page; the licence installs itself.

## Licence

AGPL-3.0-or-later. Commercial licences: https://huloglobal.com/vendure-plugins/checkout-guard/
