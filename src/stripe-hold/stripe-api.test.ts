import { describe, expect, it } from 'vitest';
import {
    StripeRequestError, cancelPaymentIntent, capturePaymentIntent, createStripeRefund, encodeForm, isUnexpectedStateError,
    retrievePaymentIntent, stripeRequest,
} from './stripe-api';

interface Call { url: string; init: any }

function fakeFetch(status: number, payload: any, calls: Call[]) {
    return async (url: string, init: any) => {
        calls.push({ url, init });
        return { ok: status >= 200 && status < 300, status, json: async () => payload, text: async () => JSON.stringify(payload) };
    };
}

describe('encodeForm', () => {
    it('encodes flat, nested and array params the Stripe way', () => {
        expect(encodeForm({ amount_to_capture: 1200 })).toBe('amount_to_capture=1200');
        expect(encodeForm({ metadata: { orderCode: 'A B', n: 1 }, expand: ['latest_charge'] }))
            .toBe('metadata%5BorderCode%5D=A%20B&metadata%5Bn%5D=1&expand%5B0%5D=latest_charge');
        expect(encodeForm({ a: undefined, b: null, c: false })).toBe('c=false');
    });
});

describe('stripeRequest', () => {
    it('sends auth, version, idempotency and form body on POST', async () => {
        const calls: Call[] = [];
        const res = await capturePaymentIntent('sk_test_1', 'pi_1', { amount_to_capture: 500 }, { fetchImpl: fakeFetch(200, { id: 'pi_1', status: 'succeeded' }, calls), idempotencyKey: 'cg-capture-pi_1' });
        expect(res.status).toBe('succeeded');
        expect(calls[0].url).toBe('https://api.stripe.com/v1/payment_intents/pi_1/capture');
        expect(calls[0].init.method).toBe('POST');
        expect(calls[0].init.headers.Authorization).toBe('Bearer sk_test_1');
        expect(calls[0].init.headers['Stripe-Version']).toBe('2022-11-15');
        expect(calls[0].init.headers['Idempotency-Key']).toBe('cg-capture-pi_1');
        expect(calls[0].init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
        expect(calls[0].init.body).toBe('amount_to_capture=500');
    });
    it('puts GET params in the query string and never an idempotency key', async () => {
        const calls: Call[] = [];
        await stripeRequest('sk', 'GET', '/v1/payment_intents', { limit: 100, 'created[gte]': 5 }, { fetchImpl: fakeFetch(200, { data: [] }, calls), idempotencyKey: 'x' });
        expect(calls[0].url).toBe('https://api.stripe.com/v1/payment_intents?limit=100&created%5Bgte%5D=5');
        expect(calls[0].init.body).toBeUndefined();
        expect(calls[0].init.headers['Idempotency-Key']).toBeUndefined();
        await retrievePaymentIntent('sk', 'pi_9', { fetchImpl: fakeFetch(200, { id: 'pi_9' }, calls) });
        expect(calls[1].url).toBe('https://api.stripe.com/v1/payment_intents/pi_9');
    });
    it('throws StripeRequestError carrying Stripe error fields', async () => {
        const calls: Call[] = [];
        const err = { type: 'invalid_request_error', code: 'payment_intent_unexpected_state', message: 'This PaymentIntent could not be captured because it has a status of succeeded.' };
        await expect(cancelPaymentIntent('sk', 'pi_1', {}, { fetchImpl: fakeFetch(400, { error: err }, calls) })).rejects.toMatchObject({ status: 400, code: 'payment_intent_unexpected_state' });
        try {
            await cancelPaymentIntent('sk', 'pi_1', {}, { fetchImpl: fakeFetch(400, { error: err }, calls) });
        } catch (e) {
            expect(e).toBeInstanceOf(StripeRequestError);
            expect(isUnexpectedStateError(e)).toBe(true);
        }
        expect(isUnexpectedStateError(new StripeRequestError(402, { code: 'card_declined', message: 'declined' }, 'x'))).toBe(false);
        expect(isUnexpectedStateError(new Error('boom'))).toBe(false);
    });
    it('refuses to run without a key and copes with non-JSON error bodies', async () => {
        await expect(stripeRequest('', 'GET', 'v1/x')).rejects.toThrow(/key missing/);
        const calls: Call[] = [];
        const broken = async (url: string, init: any) => { calls.push({ url, init }); return { ok: false, status: 502, json: async () => { throw new Error('nope'); }, text: async () => 'bad gateway' }; };
        await expect(createStripeRefund('sk', { payment_intent: 'pi_1', amount: 100 }, { fetchImpl: broken })).rejects.toMatchObject({ status: 502 });
    });
});
