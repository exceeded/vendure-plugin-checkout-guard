# Changelog

All notable changes to `@huloglobal/vendure-plugin-checkout-guard` are
documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this project
adheres to [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] — 2026-09-18

### Changed
- **Vendure plugin directory readiness.** The plugin class, every service and the bank-transfer events carry `@category` JSDoc tags (Plugin / Services / Events); the runtime `compatibility` declaration now matches the tested range `>=3.5.0 <4.0.0` instead of `^3.0.0`.
- **README:** npm, download, Vendure and database badges, a four-step *Quick start* at the top (including the admin-UI compile step) and a *Compatibility* section. No functional changes.

## [0.1.1] — 2026-09-11

### Fixed
- **Admin capture / release of a hold on a non-default channel** used the admin request's channel, where the channel's `stripe-hold` method does not exist (`error.payment-method-not-found`). Both now act in the order's own channel, like the cron and webhook paths.
- **Webhook responses:** an unexpected error while recording a hold, or a locked premium tier, now answers 5xx so Stripe retries the delivery instead of the hold being lost; an ops alert (at most hourly) explains the locked case.
- **Duplicate webhook deliveries** for one PaymentIntent are serialised (in-process mutex plus a row lock on the order), so two Authorized payments can no longer be attached to one intent.
- Ops fan-out (Slack / webhooks / SMTP) no longer runs inside the webhook's database transaction.
- Capture / cancel idempotency keys carry a minute bucket, so a failed capture is not replayed as the same error for 24 hours.
- Safety capture releases (never charges) a hold whose order was cancelled.
- Bank-transfer sweep finishes cancelling orders that a failed `cancelOrder` left in PaymentAuthorized with a cancelled payment (`repaired` in the sweep result).
- Admin UI: the Bank transfers, Holds and Funnel tabs read the fields the server actually sends.
- Overview KPIs count holds and transfers by the handler behind each channel's payment method, not by a guessed method code.
- Shop API rate limiter: multipart (file-upload) GraphQL requests are limited too.
- `trustedClientIp.trustCloudflareHeader` (default true) lets deployments reachable without Cloudflare ignore `cf-connecting-ip`.

## [0.1.0] — 2026-09-11

### Added
- **Stripe holds.** A `stripe-hold` payment handler and a signed webhook (`POST /checkout-guard/stripe-webhook`) for `payment_intent.amount_capturable_updated`, so a manual-capture PaymentIntent becomes an *Authorized* Vendure payment and the order is placed (`PaymentAuthorized`). Capture and cancel from the admin (`/checkout-guard/holds`), a safety capture before Stripe's seven-day authorisation window closes, `payment_intent.payment_failed` recorded as a payment event. Per-channel webhook secrets via `STRIPE_CG_WEBHOOK_SECRET_<CHANNELCODE>`.
- **Bank transfer.** A `bank-transfer` payment handler whose account details travel in the payment's public metadata (storefronts render them, nothing hard-coded), an eligibility checker (min / max amount, guests, customer groups), auto-expiry of unpaid orders after N days with a reminder event before that, and admin *received* / *cancel* actions.
- **Guards.** `SessionBoundOrderByCodeAccessStrategy` (anonymous `orderByCode` only from the session that placed the order, via the `cgSessionHash` Order custom field), a trusted client-IP middleware (`x-real-client-ip` honoured only with the `x-checkout-guard-proxy` secret header) with `getClientIp()`, and token-bucket rate limits on Shop API mutations (`applyCouponCode`, `addPaymentToOrder`, `createStripePaymentIntent`, `transitionOrderToState`).
- **Observability.** A payment-event log (webhook failures, storefront-reported declines, orphaned charges, amount drift, expired holds and transfers), `POST /checkout-guard/client-decline`, nightly Stripe ↔ Vendure reconciliation per channel, an amount-drift guard on settlement, checkout funnel events (`POST /checkout-guard/funnel`) with a per-step summary, and ops alerts to Slack, Discord, Teams, Telegram, a signed webhook and email.
- **Admin dashboard** at *Sales → Checkout Guard*: Overview, Holds, Bank transfers, Payment events, Funnel, Settings, plus the Licence & billing card (14-day card-backed trial, buy from the admin, Stripe billing portal).
- Free tier: session-bound order lookup, trusted client IP, rate limits, funnel events, the bank-transfer handler and checker, dashboard. Premium: Stripe holds, bank-transfer expiry and reminders, failed-payment recording, reconciliation, drift guard, ops alerts.
