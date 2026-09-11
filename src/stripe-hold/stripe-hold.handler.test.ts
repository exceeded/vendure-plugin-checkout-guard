import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripeHoldPaymentHandler } from './stripe-hold.handler';
import { configureStripeHold } from './runtime';

/**
 * Exercises the handler with a stubbed TransactionalConnection (only the
 * PaymentMethod lookup is needed) and a stubbed global fetch. Vendure's
 * `PaymentMethodHandler` wraps our functions, so we call through the
 * public `createPayment/settlePayment/cancelPayment/createRefund` API.
 */

const stripeMethod = { code: 'stripe-elite', enabled: true, handler: { code: 'stripe', args: [{ name: 'apiKey', value: 'sk_test_abc' }, { name: 'webhookSecret', value: 'whsec' }] }, channels: [{ id: 1 }] };
const holdMethod = { code: 'stripe-hold', enabled: true, handler: { code: 'stripe-hold', args: [] }, channels: [{ id: 1 }] };
const fakeConnection = { rawConnection: { getRepository: () => ({ find: async () => [stripeMethod, holdMethod] }) } };

const adminCtx: any = { apiType: 'admin', channelId: 1, channel: { code: 'elite', id: 1 } };
const shopCtx: any = { apiType: 'shop', channelId: 1, channel: { code: 'elite', id: 1 } };
const order: any = { id: 10, code: 'ORD1', currencyCode: 'GBP', totalWithTax: 12345 };
const method: any = holdMethod;

let calls: Array<{ url: string; init: any }> = [];
let responder: (url: string, init: any) => { status: number; body: any };

beforeEach(() => {
    calls = [];
    responder = () => ({ status: 200, body: {} });
    (globalThis as any).fetch = vi.fn(async (url: string, init: any) => {
        calls.push({ url, init });
        const r = responder(url, init);
        return { ok: r.status < 300, status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body) };
    });
    stripeHoldPaymentHandler.init({ get: () => fakeConnection } as any);
    configureStripeHold({ getOptions: () => ({ safetyCaptureDays: 6 }), hasPremiumAccess: () => true });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('createPayment', () => {
    it('records an Authorized payment with holdUntil for the webhook (admin) ctx', async () => {
        const before = Date.now();
        const r: any = await stripeHoldPaymentHandler.createPayment(adminCtx, order, 12345, [], { paymentIntentId: 'pi_123', amountCapturable: 12345 }, method);
        expect(r.state).toBe('Authorized');
        expect(r.amount).toBe(12345);
        expect(r.transactionId).toBe('pi_123');
        expect(r.metadata.capture).toBe('manual');
        expect(r.metadata.public.holdUntil).toBe(r.metadata.holdUntil);
        const until = new Date(r.metadata.holdUntil).getTime();
        expect(until).toBeGreaterThanOrEqual(before + 6 * 86_400_000 - 5);
        expect(until).toBeLessThanOrEqual(Date.now() + 6 * 86_400_000 + 5);
    });
    it('uses the Stripe amount_capturable (converted) over the Vendure amount', async () => {
        const r: any = await stripeHoldPaymentHandler.createPayment(adminCtx, { ...order, currencyCode: 'JPY' }, 500000, [], { paymentIntentId: 'pi_1', amountCapturable: 5000 }, method);
        expect(r.amount).toBe(500000);
        const r2: any = await stripeHoldPaymentHandler.createPayment(adminCtx, order, 999, [], { paymentIntentId: 'pi_1' }, method);
        expect(r2.amount).toBe(999);
    });
    it('refuses storefront calls and bad intent ids', async () => {
        await expect(stripeHoldPaymentHandler.createPayment(shopCtx, order, 1, [], { paymentIntentId: 'pi_1' }, method)).rejects.toThrow(/not allowed/);
        const r: any = await stripeHoldPaymentHandler.createPayment(adminCtx, order, 1, [], { paymentIntentId: 'ch_1' }, method);
        expect(r.state).toBe('Error');
    });
});

describe('settlePayment', () => {
    const payment: any = { id: 1, transactionId: 'pi_123', amount: 12345, state: 'Authorized', metadata: {} };
    it('captures at Stripe with the channel key and an idempotency key', async () => {
        responder = () => ({ status: 200, body: { id: 'pi_123', status: 'succeeded', amount_received: 12345 } });
        const r: any = await stripeHoldPaymentHandler.settlePayment(adminCtx, order, payment, [], method);
        expect(r.success).toBe(true);
        expect(r.metadata.amountReceived).toBe(12345);
        expect(calls[0].url).toBe('https://api.stripe.com/v1/payment_intents/pi_123/capture');
        expect(calls[0].init.headers.Authorization).toBe('Bearer sk_test_abc');
        expect(calls[0].init.headers['Idempotency-Key']).toBe('cg-capture-pi_123');
        expect(calls[0].init.body).toBe('amount_to_capture=12345');
    });
    it('treats an already-captured intent as settled', async () => {
        responder = (_url, init) => init.method === 'POST'
            ? { status: 400, body: { error: { code: 'payment_intent_unexpected_state', message: 'already captured' } } }
            : { status: 200, body: { id: 'pi_123', status: 'succeeded', amount_received: 12345 } };
        const r: any = await stripeHoldPaymentHandler.settlePayment(adminCtx, order, payment, [], method);
        expect(r.success).toBe(true);
        expect(r.metadata.capturedExternally).toBe(true);
    });
    it('moves an expired authorisation to Cancelled and keeps other failures Authorized', async () => {
        responder = (_url, init) => init.method === 'POST'
            ? { status: 400, body: { error: { code: 'payment_intent_unexpected_state', message: 'canceled' } } }
            : { status: 200, body: { id: 'pi_123', status: 'canceled' } };
        const r: any = await stripeHoldPaymentHandler.settlePayment(adminCtx, order, payment, [], method);
        expect(r.success).toBe(false);
        expect(r.state).toBe('Cancelled');
        responder = () => ({ status: 402, body: { error: { code: 'card_declined', message: 'Your card was declined.' } } });
        const r2: any = await stripeHoldPaymentHandler.settlePayment(adminCtx, order, payment, [], method);
        expect(r2.success).toBe(false);
        expect(r2.state).toBe('Authorized');
        expect(r2.errorMessage).toMatch(/card_declined/);
    });
    it('fails (still Authorized) when the channel has no Stripe key', async () => {
        stripeHoldPaymentHandler.init({ get: () => ({ rawConnection: { getRepository: () => ({ find: async () => [holdMethod] }) } }) } as any);
        const r: any = await stripeHoldPaymentHandler.settlePayment(adminCtx, order, payment, [], method);
        expect(r.success).toBe(false);
        expect(r.state).toBe('Authorized');
        expect(calls.length).toBe(0);
    });
});

describe('cancelPayment', () => {
    const payment: any = { id: 1, transactionId: 'pi_123', amount: 12345, state: 'Authorized', metadata: {} };
    it('cancels the intent at Stripe', async () => {
        responder = () => ({ status: 200, body: { id: 'pi_123', status: 'canceled' } });
        const r: any = await stripeHoldPaymentHandler.cancelPayment(adminCtx, order, payment, [], method);
        expect(r?.success).toBe(true);
        expect(calls[0].url).toBe('https://api.stripe.com/v1/payment_intents/pi_123/cancel');
        expect(calls[0].init.headers['Idempotency-Key']).toBe('cg-cancel-pi_123');
    });
    it('refuses to cancel a hold that was already captured', async () => {
        responder = (_url, init) => init.method === 'POST'
            ? { status: 400, body: { error: { code: 'payment_intent_unexpected_state', message: 'succeeded' } } }
            : { status: 200, body: { id: 'pi_123', status: 'succeeded' } };
        const r: any = await stripeHoldPaymentHandler.cancelPayment(adminCtx, order, payment, [], method);
        expect(r?.success).toBe(false);
        expect(r?.state).toBe('Authorized');
    });
});

describe('createRefund', () => {
    const payment: any = { id: 1, transactionId: 'pi_123', amount: 12345, state: 'Settled', metadata: {} };
    it('posts to /v1/refunds and maps statuses', async () => {
        responder = () => ({ status: 200, body: { id: 're_1', status: 'succeeded', amount: 500 } });
        const r = await stripeHoldPaymentHandler.createRefund(adminCtx, { lines: [], shipping: 0, adjustment: 0, paymentId: 1 } as any, 500, order, payment, [], method);
        expect(r).toMatchObject({ state: 'Settled', transactionId: 're_1' });
        expect(calls[0].url).toBe('https://api.stripe.com/v1/refunds');
        expect(calls[0].init.body).toBe('payment_intent=pi_123&amount=500');
        responder = () => ({ status: 200, body: { id: 're_2', status: 'pending', amount: 500 } });
        const p: any = await stripeHoldPaymentHandler.createRefund(adminCtx, {} as any, 500, order, payment, [], method);
        expect(p.state).toBe('Pending');
        responder = () => ({ status: 400, body: { error: { code: 'charge_already_refunded', message: 'already refunded' } } });
        const f: any = await stripeHoldPaymentHandler.createRefund(adminCtx, {} as any, 500, order, payment, [], method);
        expect(f.state).toBe('Failed');
        expect(f.metadata.message).toMatch(/already refunded/);
    });
});
