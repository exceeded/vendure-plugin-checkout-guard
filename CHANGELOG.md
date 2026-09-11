# Changelog

All notable changes to `@huloglobal/vendure-plugin-checkout-guard` are
documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this project
adheres to [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-09-11

### Added
- **Stripe holds.** A `stripe-hold` payment handler and a signed webhook (`POST /checkout-guard/stripe-webhook`) for `payment_intent.amount_capturable_updated`, so a manual-capture PaymentIntent becomes an *Authorized* Vendure payment and the order is placed (`PaymentAuthorized`). Capture and cancel from the admin (`/checkout-guard/holds`), a safety capture before Stripe's seven-day authorisation window closes, `payment_intent.payment_failed` recorded as a payment event. Per-channel webhook secrets via `STRIPE_CG_WEBHOOK_SECRET_<CHANNELCODE>`.
- **Bank transfer.** A `bank-transfer` payment handler whose account details travel in the payment's public metadata (storefronts render them, nothing hard-coded), an eligibility checker (min / max amount, guests, customer groups), auto-expiry of unpaid orders after N days with a reminder event before that, and admin *received* / *cancel* actions.
- **Guards.** `SessionBoundOrderByCodeAccessStrategy` (anonymous `orderByCode` only from the session that placed the order, via the `cgSessionHash` Order custom field), a trusted client-IP middleware (`x-real-client-ip` honoured only with the `x-checkout-guard-proxy` secret header) with `getClientIp()`, and token-bucket rate limits on Shop API mutations (`applyCouponCode`, `addPaymentToOrder`, `createStripePaymentIntent`, `transitionOrderToState`).
- **Observability.** A payment-event log (webhook failures, storefront-reported declines, orphaned charges, amount drift, expired holds and transfers), `POST /checkout-guard/client-decline`, nightly Stripe ↔ Vendure reconciliation per channel, an amount-drift guard on settlement, checkout funnel events (`POST /checkout-guard/funnel`) with a per-step summary, and ops alerts to Slack, Discord, Teams, Telegram, a signed webhook and email.
- **Admin dashboard** at *Sales → Checkout Guard*: Overview, Holds, Bank transfers, Payment events, Funnel, Settings, plus the Licence & billing card (14-day card-backed trial, buy from the admin, Stripe billing portal).
- Free tier: session-bound order lookup, trusted client IP, rate limits, funnel events, the bank-transfer handler and checker, dashboard. Premium: Stripe holds, bank-transfer expiry and reminders, failed-payment recording, reconciliation, drift guard, ops alerts.
