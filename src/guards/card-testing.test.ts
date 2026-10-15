import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    CardTestingGate, DEFAULT_CARD_TESTING, _resetCardTestingHooks, cardTestingBlockedBody,
    resolveCardTestingOptions, setCardTestingBlockListener, setFailureLookup,
} from './card-testing';
import { createMutationRateLimitHandler } from './mutation-rate-limit';
import { setCounterSink } from './counters';

vi.mock('@vendure/core', () => ({ Logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

afterEach(() => { _resetCardTestingHooks(); setCounterSink(null); });

describe('resolveCardTestingOptions', () => {
    it('defaults, clamps and disables', () => {
        expect(resolveCardTestingOptions()).toEqual(DEFAULT_CARD_TESTING);
        expect(resolveCardTestingOptions(false)).toBeNull();
        const r = resolveCardTestingOptions({ maxFailedPerIp: 2, windowMinutes: 0, blockMinutes: -5, mutations: ['addPaymentToOrder', 'bad name'] })!;
        expect(r.maxFailedPerIp).toBe(2);
        expect(r.windowMinutes).toBe(60);
        expect(r.blockMinutes).toBe(720);
        expect(r.mutations).toEqual(['addPaymentToOrder']);
    });
});

describe('CardTestingGate', () => {
    it('is a no-op until a lookup is installed, then blocks at the cap for the block window', async () => {
        let t = 1_000_000;
        const gate = new CardTestingGate(resolveCardTestingOptions({ maxFailedPerIp: 3, blockMinutes: 10 })!, () => t);
        expect((await gate.check('203.0.113.9', 'createStripePaymentIntent')).blocked).toBe(false);
        const lookup = vi.fn(async () => 3);
        setFailureLookup(lookup);
        const seen: any[] = [];
        setCardTestingBlockListener(info => seen.push(info));
        const v = await gate.check('203.0.113.9', 'createStripePaymentIntent');
        expect(v.blocked).toBe(true);
        expect(v.failures).toBe(3);
        expect(seen).toHaveLength(1);
        expect(seen[0].ip).toBe('203.0.113.9');
        // Still blocked without another lookup, inside the window.
        t += 5 * 60_000;
        expect((await gate.check('203.0.113.9', 'addPaymentToOrder')).blocked).toBe(true);
        expect(lookup).toHaveBeenCalledTimes(1);
        expect(seen).toHaveLength(1);
        // After the block window the lookup runs again.
        t += 6 * 60_000;
        lookup.mockResolvedValueOnce(0);
        expect((await gate.check('203.0.113.9', 'addPaymentToOrder')).blocked).toBe(false);
        expect(lookup).toHaveBeenCalledTimes(2);
    });

    it('caches a clean answer for 30 s, ignores uncovered mutations and fails open on lookup errors', async () => {
        let t = 0;
        const gate = new CardTestingGate(resolveCardTestingOptions()!, () => t);
        const lookup = vi.fn(async () => 1);
        setFailureLookup(lookup);
        await gate.check('198.51.100.7', 'createStripePaymentIntent');
        t += 10_000;
        await gate.check('198.51.100.7', 'createStripePaymentIntent');
        expect(lookup).toHaveBeenCalledTimes(1);
        t += 31_000;
        await gate.check('198.51.100.7', 'createStripePaymentIntent');
        expect(lookup).toHaveBeenCalledTimes(2);
        expect((await gate.check('198.51.100.7', 'applyCouponCode')).blocked).toBe(false);
        lookup.mockRejectedValueOnce(new Error('db down'));
        t += 31_000;
        expect((await gate.check('198.51.100.7', 'createStripePaymentIntent')).blocked).toBe(false);
    });
});

describe('rate-limit handler + card-testing gate', () => {
    const req = (body: any, ip = '203.0.113.9') => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body, socket: { remoteAddress: ip }, ip } as any);
    const res = () => {
        const r: any = { statusCode: 200, headers: {} as Record<string, string>, body: undefined };
        r.status = (c: number) => { r.statusCode = c; return r; };
        r.setHeader = (k: string, v: string) => { r.headers[k] = v; };
        r.json = (b: unknown) => { r.body = b; return r; };
        return r;
    };
    const flush = () => new Promise(resolve => setImmediate(resolve));

    it('answers 429 card_testing_blocked for a tripped IP and counts it, but passes clean traffic', async () => {
        setFailureLookup(async ip => (ip === '203.0.113.9' ? 9 : 0));
        const counted: string[] = [];
        setCounterSink(name => counted.push(name));
        const handler = createMutationRateLimitHandler({ cardTesting: { maxFailedPerIp: 4 } });
        const body = { query: 'mutation { createStripePaymentIntent }' };
        const r1 = res(); const next1 = vi.fn();
        handler(req(body), r1, next1); await flush();
        expect(r1.statusCode).toBe(429);
        expect(r1.body).toEqual(cardTestingBlockedBody('createStripePaymentIntent'));
        expect(Number(r1.headers['Retry-After'])).toBeGreaterThanOrEqual(60);
        expect(next1).not.toHaveBeenCalled();
        expect(counted).toEqual(['card_testing_block']);
        const r2 = res(); const next2 = vi.fn();
        handler(req(body, '198.51.100.7'), r2, next2); await flush();
        expect(next2).toHaveBeenCalledTimes(1);
        expect(r2.statusCode).toBe(200);
        const r3 = res(); const next3 = vi.fn();
        handler(req({ query: 'query { activeOrder { id } }' }), r3, next3); await flush();
        expect(next3).toHaveBeenCalledTimes(1);
    });

    it('can be disabled', async () => {
        setFailureLookup(async () => 99);
        const handler = createMutationRateLimitHandler({ cardTesting: false });
        const r = res(); const next = vi.fn();
        handler(req({ query: 'mutation { createStripePaymentIntent }' }), r, next); await flush();
        expect(next).toHaveBeenCalledTimes(1);
    });
});
