import { describe, expect, it } from 'vitest';
import { funnelKey, isFunnelStep, summariseFunnel } from './funnel';

function rows(spec: Array<[string, string | null, string | null, string | null]>) {
    return spec.map(([step, orderCode, sessionId, ip], i) => ({ id: i + 1, step, orderCode, sessionId, ip }));
}

describe('isFunnelStep', () => {
    it('accepts the documented steps only', () => {
        for (const s of ['cart', 'address', 'payment', 'pay_attempt', 'pay_failed', 'coupon_rejected', 'placed']) {
            expect(isFunnelStep(s)).toBe(true);
        }
        expect(isFunnelStep('checkout')).toBe(false);
        expect(isFunnelStep('')).toBe(false);
        expect(isFunnelStep(null)).toBe(false);
        expect(isFunnelStep(42)).toBe(false);
    });
});

describe('funnelKey', () => {
    it('prefers order code, then session, then ip, then the row itself', () => {
        expect(funnelKey({ step: 'cart', orderCode: 'ABC', sessionId: 's1', ip: '1.1.1.1' })).toBe('o:ABC');
        expect(funnelKey({ step: 'cart', sessionId: 's1', ip: '1.1.1.1' })).toBe('s:s1');
        expect(funnelKey({ step: 'cart', ip: '1.1.1.1' })).toBe('ip:1.1.1.1');
        expect(funnelKey({ id: 7, step: 'cart' })).toBe('row:7');
    });
});

describe('summariseFunnel', () => {
    it('returns every step with zeros for an empty window', () => {
        const s = summariseFunnel([], 7);
        expect(s.days).toBe(7);
        expect(s.steps.map(x => x.step)).toEqual(['cart', 'address', 'payment', 'pay_attempt', 'pay_failed', 'coupon_rejected', 'placed']);
        expect(s.steps.every(x => x.events === 0 && x.unique === 0 && x.dropOffPct === null)).toBe(true);
        expect(s.conversionPct).toBeNull();
        expect(s.worstDropOffPct).toBeNull();
        expect(s.paymentFailureRatePct).toBeNull();
        expect(s.couponRejections).toBe(0);
    });

    it('counts unique checkouts and drop-off along the chain', () => {
        const s = summariseFunnel(rows([
            ['cart', null, 's1', null], ['cart', null, 's1', null], // repeat fires count once
            ['cart', null, 's2', null], ['cart', null, 's3', null], ['cart', null, 's4', null],
            ['address', null, 's1', null], ['address', null, 's2', null],
            ['payment', 'O1', 's1', null], ['payment', 'O2', 's2', null],
            ['pay_attempt', 'O1', null, null], ['pay_attempt', 'O2', null, null],
            ['pay_failed', 'O2', null, null],
            ['coupon_rejected', 'O1', null, null], ['coupon_rejected', 'O1', null, null],
            ['placed', 'O1', null, null],
        ]), 7);
        const by = Object.fromEntries(s.steps.map(x => [x.step, x]));
        expect(by.cart.events).toBe(5);
        expect(by.cart.unique).toBe(4);
        expect(by.cart.dropOffPct).toBeNull();
        expect(by.address.unique).toBe(2);
        expect(by.address.dropOffPct).toBe(50);
        expect(by.payment.unique).toBe(2);
        expect(by.payment.dropOffPct).toBe(0);
        expect(by.pay_attempt.unique).toBe(2);
        expect(by.placed.unique).toBe(1);
        expect(by.placed.dropOffPct).toBe(50);
        // side events never carry a drop-off
        expect(by.pay_failed.dropOffPct).toBeNull();
        expect(by.coupon_rejected.dropOffPct).toBeNull();
        expect(s.couponRejections).toBe(2);
        expect(s.paymentFailureRatePct).toBe(50);
        expect(s.conversionPct).toBe(25);
        expect(s.worstDropOffPct).toBe(50);
        expect(s.worstDropOffStep).toBe('address');
    });

    it('does not report a 100% drop-off past an uninstrumented step', () => {
        // Storefront only sends address/payment/placed (no cart beacon yet).
        const s = summariseFunnel(rows([
            ['address', null, 's1', null], ['address', null, 's2', null],
            ['payment', null, 's1', null], ['payment', null, 's2', null],
            ['placed', 'O1', 's1', null],
        ]), 30);
        const by = Object.fromEntries(s.steps.map(x => [x.step, x]));
        expect(by.cart.unique).toBe(0);
        expect(by.address.dropOffPct).toBeNull(); // baseline was empty
        expect(by.payment.dropOffPct).toBe(0);
        // pay_attempt was not instrumented: placed compares against payment
        expect(by.pay_attempt.dropOffPct).toBe(100);
        expect(by.placed.dropOffPct).toBe(50);
        expect(s.conversionPct).toBe(50);
    });

    it('ignores rows with unknown steps', () => {
        const s = summariseFunnel([{ id: 1, step: 'bogus', sessionId: 's1' }, { id: 2, step: 'cart', sessionId: 's1' }], 1);
        expect(s.steps.find(x => x.step === 'cart')!.unique).toBe(1);
        expect(s.steps.reduce((a, x) => a + x.events, 0)).toBe(1);
    });
});
