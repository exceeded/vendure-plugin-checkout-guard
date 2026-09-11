import {
    CancelPaymentErrorResult, CancelPaymentResult, CreatePaymentErrorResult, CreatePaymentResult, CreateRefundResult,
    Injector, LanguageCode, Logger, PaymentMethodHandler, SettlePaymentErrorResult, SettlePaymentResult, TransactionalConnection,
} from '@vendure/core';
import { randomBytes } from 'crypto';
import {
    STRIPE_HOLD_HANDLER_CODE, cancelIdempotencyKey, captureIdempotencyKey, computeHoldUntil, fromStripeMinorUnits,
    isPaymentIntentId, refundIdempotencyKey, toStripeMinorUnits,
} from './hold-utils';
import { effectiveStripeHoldOptions } from './runtime';
import { getStripeKeyForChannel } from './stripe-key';
import {
    StripeRequestError, cancelPaymentIntent, capturePaymentIntent, createStripeRefund, isUnexpectedStateError, retrievePaymentIntent,
} from './stripe-api';

const loggerCtx = 'CheckoutGuard:StripeHold';

let connection: TransactionalConnection;

/**
 * `stripe-hold` — manual-capture Stripe payments that actually place the
 * order. The PaymentIntent is created by Vendure's StripePlugin with
 * `capture_method: 'manual'`; when Stripe reports
 * `payment_intent.amount_capturable_updated` the webhook controller adds a
 * payment through this handler, which records it as **Authorized** so the
 * order moves to `PaymentAuthorized`. Settling = capture, cancelling =
 * release. No args: the Stripe secret key comes from the channel's Stripe
 * method (`getStripeKeyForChannel`).
 */
export const stripeHoldPaymentHandler = new PaymentMethodHandler({
    code: STRIPE_HOLD_HANDLER_CODE,
    description: [{ languageCode: LanguageCode.en, value: 'Stripe hold (manual capture)' }],
    args: {},

    init(injector: Injector) {
        connection = injector.get(TransactionalConnection);
    },

    createPayment(ctx, order, amount, _args, metadata): CreatePaymentResult | CreatePaymentErrorResult {
        // Only the webhook (admin ctx) may record a hold — a storefront must
        // never be able to mark an order authorised by naming a PI id.
        if (ctx.apiType !== 'admin') {
            throw new Error(`createPayment is not allowed for apiType '${ctx.apiType}'`);
        }
        const paymentIntentId = metadata?.paymentIntentId;
        if (!isPaymentIntentId(paymentIntentId)) {
            return { amount, state: 'Error', errorMessage: 'stripe-hold: missing or invalid paymentIntentId', metadata };
        }
        const { safetyCaptureDays } = effectiveStripeHoldOptions();
        const authorisedAt = new Date();
        const capturable = Number(metadata?.amountCapturable);
        const recorded = Number.isFinite(capturable) && capturable > 0
            ? fromStripeMinorUnits(capturable, order.currencyCode)
            : amount;
        const holdUntil = computeHoldUntil(authorisedAt, safetyCaptureDays).toISOString();
        return {
            amount: recorded,
            state: 'Authorized',
            transactionId: paymentIntentId,
            metadata: {
                paymentIntentId,
                capture: 'manual',
                amountCapturable: Number.isFinite(capturable) ? capturable : undefined,
                authorisedAt: authorisedAt.toISOString(),
                holdUntil,
                public: { holdUntil, capture: 'manual' },
            },
        };
    },

    async settlePayment(ctx, order, payment): Promise<SettlePaymentResult | SettlePaymentErrorResult> {
        const pi = payment.transactionId;
        if (!isPaymentIntentId(pi)) {
            return { success: false, errorMessage: 'stripe-hold: payment has no PaymentIntent id' };
        }
        const apiKey = await getStripeKeyForChannel(ctx, connection);
        if (!apiKey) {
            return { success: false, state: 'Authorized', errorMessage: `stripe-hold: no Stripe API key on channel ${ctx.channel?.code ?? ctx.channelId}` };
        }
        try {
            const amountToCapture = toStripeMinorUnits(payment.amount, order.currencyCode);
            const result = await capturePaymentIntent(apiKey, pi, { amount_to_capture: amountToCapture }, { idempotencyKey: captureIdempotencyKey(pi) });
            if (result.status === 'succeeded' || result.status === 'processing') {
                Logger.info(`Captured ${pi} for order ${order.code} (${result.amount_received ?? amountToCapture} ${order.currencyCode})`, loggerCtx);
                return { success: true, metadata: { capturedAt: new Date().toISOString(), amountReceived: result.amount_received, stripeStatus: result.status } };
            }
            return { success: false, state: 'Authorized', errorMessage: `stripe-hold: unexpected status '${result.status}' after capture` };
        } catch (e: any) {
            // Captured elsewhere (Stripe dashboard, an earlier retry)? Treat as settled.
            if (isUnexpectedStateError(e)) {
                const current = await retrievePaymentIntent(apiKey, pi).catch(() => null);
                if (current?.status === 'succeeded') {
                    return { success: true, metadata: { capturedAt: new Date().toISOString(), amountReceived: current.amount_received, stripeStatus: 'succeeded', capturedExternally: true } };
                }
                if (current?.status === 'canceled') {
                    return { success: false, state: 'Cancelled', errorMessage: 'stripe-hold: authorisation was cancelled at Stripe (expired or released)' };
                }
            }
            const msg = e instanceof StripeRequestError ? `${e.code || e.type || 'stripe_error'}: ${e.message}` : (e?.message || String(e));
            Logger.error(`Capture of ${pi} for order ${order.code} failed: ${msg}`, loggerCtx);
            // Stay Authorized so the admin can retry; 'Error' would strand the hold.
            return { success: false, state: 'Authorized', errorMessage: `stripe-hold: ${msg}` };
        }
    },

    async cancelPayment(ctx, order, payment): Promise<CancelPaymentResult | CancelPaymentErrorResult> {
        const pi = payment.transactionId;
        if (!isPaymentIntentId(pi)) {
            return { success: true, metadata: { cancelledAt: new Date().toISOString(), note: 'no PaymentIntent id' } };
        }
        const apiKey = await getStripeKeyForChannel(ctx, connection);
        if (!apiKey) {
            return { success: false, state: 'Authorized', errorMessage: `stripe-hold: no Stripe API key on channel ${ctx.channel?.code ?? ctx.channelId}` };
        }
        try {
            const result = await cancelPaymentIntent(apiKey, pi, { cancellation_reason: 'requested_by_customer' }, { idempotencyKey: cancelIdempotencyKey(pi) });
            Logger.info(`Released hold ${pi} for order ${order.code} (status ${result.status})`, loggerCtx);
            return { success: true, metadata: { cancelledAt: new Date().toISOString(), stripeStatus: result.status } };
        } catch (e: any) {
            if (isUnexpectedStateError(e)) {
                const current = await retrievePaymentIntent(apiKey, pi).catch(() => null);
                if (current?.status === 'canceled') {
                    return { success: true, metadata: { cancelledAt: new Date().toISOString(), stripeStatus: 'canceled', cancelledExternally: true } };
                }
                if (current?.status === 'succeeded') {
                    return { success: false, state: 'Authorized', errorMessage: 'stripe-hold: the hold was already captured at Stripe — settle it instead' };
                }
            }
            const msg = e instanceof StripeRequestError ? `${e.code || e.type || 'stripe_error'}: ${e.message}` : (e?.message || String(e));
            Logger.error(`Cancel of ${pi} for order ${order.code} failed: ${msg}`, loggerCtx);
            return { success: false, state: 'Authorized', errorMessage: `stripe-hold: ${msg}` };
        }
    },

    async createRefund(ctx, _input, amount, order, payment): Promise<CreateRefundResult> {
        const pi = payment.transactionId;
        if (!isPaymentIntentId(pi)) {
            return { state: 'Failed', transactionId: pi, metadata: { message: 'stripe-hold: payment has no PaymentIntent id' } };
        }
        const apiKey = await getStripeKeyForChannel(ctx, connection);
        if (!apiKey) {
            return { state: 'Failed', transactionId: pi, metadata: { message: 'stripe-hold: no Stripe API key on channel' } };
        }
        try {
            const stripeAmount = toStripeMinorUnits(amount, order.currencyCode);
            const nonce = randomBytes(4).toString('hex');
            const refund = await createStripeRefund(apiKey, { payment_intent: pi, amount: stripeAmount }, { idempotencyKey: refundIdempotencyKey(pi, stripeAmount, nonce) });
            if (refund.status === 'succeeded') return { state: 'Settled', transactionId: refund.id };
            if (refund.status === 'pending' || refund.status === 'requires_action') return { state: 'Pending', transactionId: refund.id };
            return { state: 'Failed', transactionId: refund.id, metadata: { message: refund.failure_reason || `refund status ${refund.status}` } };
        } catch (e: any) {
            const msg = e instanceof StripeRequestError ? e.message : (e?.message || String(e));
            Logger.error(`Refund on ${pi} for order ${order.code} failed: ${msg}`, loggerCtx);
            return { state: 'Failed', transactionId: pi, metadata: { type: e instanceof StripeRequestError ? e.type : 'error', message: msg } };
        }
    },
});
