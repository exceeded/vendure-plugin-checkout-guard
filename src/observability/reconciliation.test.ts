import { describe, expect, it, vi } from 'vitest';
import { findOrphanIntents, listStripePaymentIntents, vendureMetadataOf } from './reconciliation';
import { StripeIntentLite } from './types';

const NOW = new Date('2026-09-11T04:10:00Z');
const hourAgo = Math.floor(NOW.getTime() / 1000) - 3600;

function pi(over: Partial<StripeIntentLite> & { id: string }): StripeIntentLite {
    return { status: 'succeeded', amount: 12999, currency: 'gbp', created: hourAgo, metadata: { orderCode: 'ORD1', channelToken: 'tok' }, ...over };
}

describe('vendureMetadataOf', () => {
    it('reads the payments-plugin metadata keys', () => {
        expect(vendureMetadataOf(pi({ id: 'pi_1', metadata: { orderCode: 'A', orderId: '5', channelToken: 't', languageCode: 'en' } })))
            .toEqual({ orderCode: 'A', orderId: '5', channelToken: 't' });
        expect(vendureMetadataOf(pi({ id: 'pi_1', metadata: null }))).toEqual({ orderCode: null, orderId: null, channelToken: null });
    });
});

describe('findOrphanIntents', () => {
    it('returns succeeded/requires_capture intents with no matching payment', () => {
        const out = findOrphanIntents([
            pi({ id: 'pi_known1' }),
            pi({ id: 'pi_orphanA' }),
            pi({ id: 'pi_orphanB', status: 'requires_capture', amount: 500000 }),
            pi({ id: 'pi_canceledX', status: 'canceled' }),
            pi({ id: 'pi_pendingX', status: 'requires_payment_method' }),
        ], new Set(['pi_known1']), { now: NOW });
        expect(out.map(o => o.paymentIntentId)).toEqual(['pi_orphanA', 'pi_orphanB']);
        expect(out[1]).toMatchObject({ amountMinor: 500000, currency: 'GBP', status: 'requires_capture', orderCode: 'ORD1', channelToken: 'tok' });
        expect(out[0].createdAt.getTime()).toBe(hourAgo * 1000);
    });

    it('skips intents inside the grace window (webhook may still be in flight)', () => {
        const fresh = Math.floor(NOW.getTime() / 1000) - 60;
        const out = findOrphanIntents([pi({ id: 'pi_freshX', created: fresh })], new Set(), { now: NOW });
        expect(out).toEqual([]);
        expect(findOrphanIntents([pi({ id: 'pi_freshX', created: fresh })], new Set(), { now: NOW, graceMs: 0 })).toHaveLength(1);
    });

    it('ignores intents without Vendure metadata unless asked', () => {
        const foreign = pi({ id: 'pi_paylinkX', metadata: { invoice: '12' } });
        expect(findOrphanIntents([foreign], new Set(), { now: NOW })).toEqual([]);
        expect(findOrphanIntents([foreign], new Set(), { now: NOW, requireVendureMetadata: false })).toHaveLength(1);
    });

    it('rejects malformed ids', () => {
        expect(findOrphanIntents([pi({ id: 'ch_123' }), { ...pi({ id: 'pi_ok' }), id: undefined as any }], new Set(), { now: NOW })).toEqual([]);
    });
});

describe('listStripePaymentIntents', () => {
    it('paginates with starting_after until has_more is false', async () => {
        const calls: string[] = [];
        const fetchImpl = vi.fn(async (url: string, init: any) => {
            calls.push(url);
            expect(init.headers.Authorization).toBe('Bearer sk_test_x');
            expect(init.headers['Stripe-Version']).toBe('2022-11-15');
            const page = calls.length;
            return {
                ok: true, status: 200,
                json: async () => ({
                    data: [{ id: `pi_${page}a`, status: 'succeeded', amount: 1, currency: 'gbp', created: hourAgo, metadata: {} },
                           { id: `pi_${page}b`, status: 'succeeded', amount: 2, currency: 'gbp', created: hourAgo }],
                    has_more: page < 3,
                }),
            };
        });
        const r = await listStripePaymentIntents('sk_test_x', hourAgo - 86400, { fetchImpl });
        expect(r.incomplete).toBe(false);
        expect(r.intents).toHaveLength(6);
        expect(r.intents[5]).toMatchObject({ id: 'pi_3b', amount: 2, metadata: null });
        expect(calls[0]).toContain('created%5Bgte%5D=');
        expect(calls[0]).toContain('limit=100');
        expect(calls[0]).not.toContain('starting_after');
        expect(calls[1]).toContain('starting_after=pi_1b');
        expect(calls[2]).toContain('starting_after=pi_2b');
    });

    it('returns what it has and flags incomplete on an HTTP error', async () => {
        const log = vi.fn();
        let n = 0;
        const fetchImpl = vi.fn(async () => {
            n++;
            if (n === 1) return { ok: true, status: 200, json: async () => ({ data: [{ id: 'pi_1', status: 'succeeded', amount: 1, currency: 'gbp', created: hourAgo }], has_more: true }) };
            return { ok: false, status: 401, json: async () => ({}) };
        });
        const r = await listStripePaymentIntents('sk_test_x', hourAgo, { fetchImpl, log });
        expect(r.incomplete).toBe(true);
        expect(r.intents).toHaveLength(1);
        expect(log).toHaveBeenCalledWith(expect.stringContaining('HTTP 401'));
    });

    it('flags incomplete on a thrown fetch and on a missing key', async () => {
        const log = vi.fn();
        const fetchImpl = vi.fn(async () => { throw new Error('boom'); });
        const r = await listStripePaymentIntents('sk_test_x', hourAgo, { fetchImpl, log });
        expect(r).toEqual({ intents: [], incomplete: true });
        expect(log).toHaveBeenCalledWith(expect.stringContaining('boom'));
        expect(await listStripePaymentIntents('', hourAgo, { fetchImpl })).toEqual({ intents: [], incomplete: true });
    });

    it('stops at the page cap', async () => {
        const log = vi.fn();
        const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'pi_x', status: 'succeeded', amount: 1, currency: 'gbp', created: hourAgo }], has_more: true }) }));
        const r = await listStripePaymentIntents('sk_test_x', hourAgo, { fetchImpl, log, maxPages: 2 });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(r.incomplete).toBe(true);
        expect(log).toHaveBeenCalledWith(expect.stringContaining('2-page cap'));
    });
});
