import { describe, expect, it } from 'vitest';

import {
    buildBankTransferPublicDetails,
    computePayBy,
    normaliseExpiryDays,
    parsePayBy,
    readBankTransferPublicDetails,
} from './bank-details';

describe('computePayBy', () => {
    it('adds the expiry days and lands at end of that UTC day', () => {
        const from = new Date('2026-09-11T14:23:00.000Z');
        const payBy = computePayBy(from, 7);
        expect(payBy.toISOString()).toBe('2026-09-18T23:59:59.999Z');
    });

    it('falls back to 7 days for invalid expiryDays', () => {
        const from = new Date('2026-09-11T00:00:00.000Z');
        expect(computePayBy(from, 0).toISOString()).toBe('2026-09-18T23:59:59.999Z');
        expect(computePayBy(from, NaN).toISOString()).toBe('2026-09-18T23:59:59.999Z');
        expect(computePayBy(from, -3).toISOString()).toBe('2026-09-18T23:59:59.999Z');
    });

    it('rolls over month boundaries', () => {
        const from = new Date('2026-09-28T09:00:00.000Z');
        expect(computePayBy(from, 5).toISOString()).toBe('2026-10-03T23:59:59.999Z');
    });
});

describe('normaliseExpiryDays', () => {
    it('floors positive values and defaults otherwise', () => {
        expect(normaliseExpiryDays(7)).toBe(7);
        expect(normaliseExpiryDays('14')).toBe(14);
        expect(normaliseExpiryDays(2.9)).toBe(2);
        expect(normaliseExpiryDays(0)).toBe(7);
        expect(normaliseExpiryDays(null)).toBe(7);
        expect(normaliseExpiryDays(undefined)).toBe(7);
    });
});

describe('buildBankTransferPublicDetails', () => {
    const now = new Date('2026-09-11T10:00:00.000Z');

    it('carries the reference, amount, currency, payBy and only the non-empty bank fields', () => {
        const d = buildBankTransferPublicDetails({
            orderCode: 'ABC123',
            amountMinor: 12999,
            currency: 'GBP',
            now,
            args: {
                accountName: '  Example Ltd ',
                accountNumber: '12345678',
                sortCode: '01-02-03',
                iban: '',
                bic: '   ',
                instructions: 'Quote your order number.',
                expiryDays: 7,
            },
        });
        expect(d).toEqual({
            method: 'bank-transfer',
            reference: 'ABC123',
            amountMinor: 12999,
            currency: 'GBP',
            payBy: '2026-09-18T23:59:59.999Z',
            expiryDays: 7,
            accountName: 'Example Ltd',
            accountNumber: '12345678',
            sortCode: '01-02-03',
            instructions: 'Quote your order number.',
        });
        expect('iban' in d).toBe(false);
        expect('bic' in d).toBe(false);
    });

    it('rounds the amount and uses the default expiry when the arg is missing', () => {
        const d = buildBankTransferPublicDetails({
            orderCode: 'X', amountMinor: 100.4, currency: 'EUR', now, args: {},
        });
        expect(d.amountMinor).toBe(100);
        expect(d.expiryDays).toBe(7);
        expect(d.payBy).toBe('2026-09-18T23:59:59.999Z');
    });
});

describe('readBankTransferPublicDetails / parsePayBy', () => {
    it('reads from an object and from a JSON string', () => {
        const meta = { public: { method: 'bank-transfer', reference: 'R1', amountMinor: 1, currency: 'GBP', payBy: '2026-09-18T23:59:59.999Z', expiryDays: 7 } };
        expect(readBankTransferPublicDetails(meta)?.reference).toBe('R1');
        expect(readBankTransferPublicDetails(JSON.stringify(meta))?.reference).toBe('R1');
        expect(parsePayBy(readBankTransferPublicDetails(meta))?.toISOString()).toBe('2026-09-18T23:59:59.999Z');
    });

    it('returns null for non bank-transfer metadata or garbage', () => {
        expect(readBankTransferPublicDetails({ paymentIntentId: 'pi_1' })).toBeNull();
        expect(readBankTransferPublicDetails('not json')).toBeNull();
        expect(readBankTransferPublicDetails(null)).toBeNull();
        expect(readBankTransferPublicDetails({ public: { method: 'stripe' } })).toBeNull();
        expect(parsePayBy(null)).toBeNull();
        expect(parsePayBy({ payBy: 'nope' } as any)).toBeNull();
    });
});
