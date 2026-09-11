import { describe, expect, it } from 'vitest';

import { evaluateBankTransferEligibility, formatMinorAmount } from './bank-transfer-eligibility';

const base = { totalWithTax: 10_000, currencyCode: 'GBP', isGuest: false, customerGroupIds: [] as string[] };

describe('evaluateBankTransferEligibility', () => {
    it('passes with no rules configured', () => {
        expect(evaluateBankTransferEligibility(base, {})).toBe(true);
        expect(evaluateBankTransferEligibility({ ...base, isGuest: true }, {})).toBe(true);
    });

    it('treats 0 / null limits as unset', () => {
        expect(evaluateBankTransferEligibility(base, { minAmountMinor: 0, maxAmountMinor: null })).toBe(true);
    });

    it('blocks guests when allowGuests is false', () => {
        const r = evaluateBankTransferEligibility({ ...base, isGuest: true }, { allowGuests: false });
        expect(typeof r).toBe('string');
        expect(r).toMatch(/signed-in/);
        expect(evaluateBankTransferEligibility(base, { allowGuests: false })).toBe(true);
    });

    it('enforces the minimum and maximum totals with a readable reason', () => {
        expect(evaluateBankTransferEligibility({ ...base, totalWithTax: 4_999 }, { minAmountMinor: 5_000 })).toBe(
            'Bank transfer is available on orders of £50.00 or more.',
        );
        expect(evaluateBankTransferEligibility({ ...base, totalWithTax: 5_000 }, { minAmountMinor: 5_000 })).toBe(true);
        expect(evaluateBankTransferEligibility({ ...base, totalWithTax: 500_001 }, { maxAmountMinor: 500_000 })).toBe(
            'Bank transfer is available on orders up to £5,000.00.',
        );
        expect(evaluateBankTransferEligibility({ ...base, totalWithTax: 500_000 }, { maxAmountMinor: 500_000 })).toBe(true);
    });

    it('restricts to customer groups when configured, comparing ids as strings', () => {
        const args = { allowedCustomerGroupIds: [3, '7'] };
        expect(evaluateBankTransferEligibility({ ...base, customerGroupIds: ['7'] }, args)).toBe(true);
        expect(evaluateBankTransferEligibility({ ...base, customerGroupIds: [3] as any }, args)).toBe(true);
        expect(typeof evaluateBankTransferEligibility({ ...base, customerGroupIds: ['9'] }, args)).toBe('string');
        expect(typeof evaluateBankTransferEligibility({ ...base, customerGroupIds: [] }, args)).toBe('string');
    });

    it('checks guest status before amounts', () => {
        const r = evaluateBankTransferEligibility({ ...base, isGuest: true, totalWithTax: 1 }, { allowGuests: false, minAmountMinor: 100 });
        expect(r).toMatch(/signed-in/);
    });
});

describe('formatMinorAmount', () => {
    it('formats known currencies and falls back for unknown codes', () => {
        expect(formatMinorAmount(12_345, 'GBP')).toBe('£123.45');
        expect(formatMinorAmount(12_345, 'ZZZ')).toMatch(/123\.45/);
    });
});
