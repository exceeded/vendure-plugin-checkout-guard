import { describe, expect, it } from 'vitest';
import { detectAmountDrift } from './amount-drift';

describe('detectAmountDrift', () => {
    it('is quiet when the payment equals the order total', () => {
        expect(detectAmountDrift({ paymentAmount: 12999, orderTotalWithTax: 12999 }))
            .toEqual({ drift: false, deltaMinor: 0, paidMinor: 12999 });
    });

    it('flags an under-payment (intent created before a line was added)', () => {
        const r = detectAmountDrift({ paymentAmount: 10000, orderTotalWithTax: 12999 });
        expect(r.drift).toBe(true);
        expect(r.deltaMinor).toBe(-2999);
    });

    it('flags an over-payment (coupon applied after the intent was created)', () => {
        const r = detectAmountDrift({ paymentAmount: 12999, orderTotalWithTax: 11699 });
        expect(r.drift).toBe(true);
        expect(r.deltaMinor).toBe(1300);
    });

    it('accepts split payments that add up to the total', () => {
        const r = detectAmountDrift({ paymentAmount: 5000, orderTotalWithTax: 12999, otherLivePaymentAmounts: [7999] });
        expect(r.drift).toBe(false);
        expect(r.paidMinor).toBe(12999);
    });

    it('still flags when the split does not add up either', () => {
        const r = detectAmountDrift({ paymentAmount: 5000, orderTotalWithTax: 12999, otherLivePaymentAmounts: [5000] });
        expect(r.drift).toBe(true);
        expect(r.deltaMinor).toBe(-2999);
    });

    it('accepts the single payment matching even when a stale extra payment exists', () => {
        // e.g. a cancelled-then-retried flow where the caller passed an
        // Authorized duplicate: the settling payment alone matches.
        const r = detectAmountDrift({ paymentAmount: 12999, orderTotalWithTax: 12999, otherLivePaymentAmounts: [12999] });
        expect(r.drift).toBe(false);
    });

    it('ignores non-numeric other amounts and rounds floats', () => {
        const r = detectAmountDrift({ paymentAmount: 100.4, orderTotalWithTax: 100, otherLivePaymentAmounts: [NaN] });
        expect(r.drift).toBe(false);
    });
});
