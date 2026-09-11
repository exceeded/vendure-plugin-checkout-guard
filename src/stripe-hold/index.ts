/**
 * Module A — Stripe holds. Wiring (plugin.ts):
 *
 *   controllers: [StripeHoldController]
 *   providers:   [StripeHoldService, StripeHoldCron]
 *   configuration: config => {
 *       config.paymentOptions.paymentMethodHandlers.push(stripeHoldPaymentHandler);
 *       config.apiOptions.middleware.push(stripeHoldRawBodyMiddlewareRegistration);
 *   }
 *   init()/onApplicationBootstrap: configureStripeHold({
 *       getOptions: () => getOptions().stripe || {},
 *       hasPremiumAccess: () => CheckoutGuardPlugin.hasPremiumAccess(),
 *       notifyOps: ev => opsNotify(...),
 *       recordPaymentEvent: ev => observabilityService.record(...),
 *   });
 */
export { stripeHoldPaymentHandler } from './stripe-hold.handler';
export { StripeHoldController } from './stripe-hold.controller';
export { StripeHoldService, HoldSummary, HoldActionResult, WebhookOutcome, SafetyCaptureReport } from './stripe-hold.service';
export { StripeHoldCron } from './stripe-hold.cron';
export {
    checkoutGuardRawBodyMiddleware, stripeHoldRawBodyMiddlewareRegistration, STRIPE_WEBHOOK_ROUTE, RequestWithRawBody,
} from './raw-body.middleware';
export {
    configureStripeHold, getStripeHoldRuntime, effectiveStripeHoldOptions, STRIPE_HOLD_DEFAULTS,
    StripeHoldOptions, StripeHoldRuntime, StripeHoldOpsEvent, StripeHoldOpsEventName, StripeHoldPaymentEvent, StripeHoldEventKind,
} from './runtime';
export {
    getStripeKeyForChannel, getStripeKeyForChannelId, getHoldPaymentMethodForChannel, getHoldMethodCodes, findMethodsByHandler,
} from './stripe-key';
export {
    verifyStripeSignature, constructStripeEvent, buildStripeSignatureHeader, computeStripeSignature, parseStripeSignatureHeader,
    StripeSignatureError, DEFAULT_SIGNATURE_TOLERANCE_SEC,
} from './stripe-signature';
export {
    stripeRequest, retrievePaymentIntent, capturePaymentIntent, cancelPaymentIntent, createStripeRefund, encodeForm,
    StripeRequestError, isUnexpectedStateError, StripePaymentIntentLike, StripeRefundLike, StripeRequestOptions,
} from './stripe-api';
export {
    STRIPE_HOLD_HANDLER_CODE, STRIPE_API_VERSION, parseVendureMetadata, VendureStripeMetadata, webhookSecretEnvName, resolveWebhookSecret,
    toStripeMinorUnits, fromStripeMinorUnits, currencyHasFractionPart, computeHoldUntil, isHoldDue, holdUntilFromMetadata,
    isPaymentIntentId, captureIdempotencyKey, cancelIdempotencyKey, formatMinor,
} from './hold-utils';
