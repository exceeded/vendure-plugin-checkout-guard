import { describe, expect, it } from 'vitest';
import {
    computeHoldUntil, currencyHasFractionPart, formatMinor, fromStripeMinorUnits, holdUntilFromMetadata, isHoldDue,
    isPaymentIntentId, parseVendureMetadata, resolveWebhookSecret, toStripeMinorUnits, webhookSecretEnvName,
    captureIdempotencyKey, cancelIdempotencyKey,
} from './hold-utils';

describe('parseVendureMetadata', () => {
    it('accepts the StripePlugin shape (orderId as string or number)', () => {
        expect(parseVendureMetadata({ channelToken: 'tok', orderCode: 'ABC', orderId: '12', languageCode: 'en' }))
            .toEqual({ channelToken: 'tok', orderCode: 'ABC', orderId: '12', languageCode: 'en' });
        expect(parseVendureMetadata({ channelToken: 'tok', orderCode: 'ABC', orderId: 12 })?.orderId).toBe('12');
    });
    it('rejects incomplete / foreign metadata', () => {
        expect(parseVendureMetadata(null)).toBeNull();
        expect(parseVendureMetadata({})).toBeNull();
        expect(parseVendureMetadata({ channelToken: 'tok', orderCode: 'ABC' })).toBeNull();
        expect(parseVendureMetadata({ invoiceId: '7' })).toBeNull();
        expect(parseVendureMetadata({ channelToken: ' ', orderCode: 'A', orderId: '1' })).toBeNull();
    });
});

describe('webhook secret resolution', () => {
    it('builds env names from channel codes', () => {
        expect(webhookSecretEnvName('elite')).toBe('STRIPE_CG_WEBHOOK_SECRET_ELITE');
        expect(webhookSecretEnvName('license-dock')).toBe('STRIPE_CG_WEBHOOK_SECRET_LICENSE_DOCK');
        expect(webhookSecretEnvName('__default_channel__')).toBe('STRIPE_CG_WEBHOOK_SECRET_DEFAULT_CHANNEL');
        expect(webhookSecretEnvName('')).toBe('STRIPE_CG_WEBHOOK_SECRET_DEFAULT');
    });
    it('prefers the channel env override, then the option', () => {
        const env = { STRIPE_CG_WEBHOOK_SECRET_ELITE: 'whsec_env ' } as NodeJS.ProcessEnv;
        expect(resolveWebhookSecret('elite', 'whsec_opt', env)).toBe('whsec_env');
        expect(resolveWebhookSecret('other', 'whsec_opt', env)).toBe('whsec_opt');
        expect(resolveWebhookSecret(undefined, 'whsec_opt', env)).toBe('whsec_opt');
        expect(resolveWebhookSecret('other', '  ', env)).toBeUndefined();
        expect(resolveWebhookSecret(undefined, undefined, env)).toBeUndefined();
    });
});

describe('minor-unit conversion', () => {
    it('knows zero-decimal currencies', () => {
        expect(currencyHasFractionPart('GBP')).toBe(true);
        expect(currencyHasFractionPart('JPY')).toBe(false);
        expect(currencyHasFractionPart('nonsense')).toBe(true);
    });
    it('round-trips GBP unchanged and JPY ×100', () => {
        expect(toStripeMinorUnits(12345, 'GBP')).toBe(12345);
        expect(fromStripeMinorUnits(12345, 'GBP')).toBe(12345);
        expect(toStripeMinorUnits(50000, 'JPY')).toBe(500);
        expect(fromStripeMinorUnits(500, 'JPY')).toBe(50000);
    });
});

describe('hold timing', () => {
    const t0 = new Date('2026-09-01T10:00:00Z');
    it('computes holdUntil from safetyCaptureDays with a sane default', () => {
        expect(computeHoldUntil(t0, 6).toISOString()).toBe('2026-09-07T10:00:00.000Z');
        expect(computeHoldUntil(t0, 0).toISOString()).toBe('2026-09-07T10:00:00.000Z');
        expect(computeHoldUntil(t0, NaN).toISOString()).toBe('2026-09-07T10:00:00.000Z');
        expect(computeHoldUntil(t0, 2).toISOString()).toBe('2026-09-03T10:00:00.000Z');
    });
    it('isHoldDue flips exactly at the boundary', () => {
        expect(isHoldDue(t0, 6, new Date('2026-09-07T09:59:59Z'))).toBe(false);
        expect(isHoldDue(t0, 6, new Date('2026-09-07T10:00:00Z'))).toBe(true);
    });
    it('reads holdUntil from public metadata first', () => {
        expect(holdUntilFromMetadata({ public: { holdUntil: '2026-09-07T10:00:00.000Z' }, holdUntil: '2000-01-01' })?.toISOString()).toBe('2026-09-07T10:00:00.000Z');
        expect(holdUntilFromMetadata({ holdUntil: '2026-09-07T10:00:00.000Z' })?.toISOString()).toBe('2026-09-07T10:00:00.000Z');
        expect(holdUntilFromMetadata({ public: { holdUntil: 'garbage' } })).toBeNull();
        expect(holdUntilFromMetadata(undefined)).toBeNull();
    });
});

describe('misc', () => {
    it('validates PaymentIntent ids', () => {
        expect(isPaymentIntentId('pi_3Abc123XYZ')).toBe(true);
        expect(isPaymentIntentId('ch_123')).toBe(false);
        expect(isPaymentIntentId('pi_')).toBe(false);
        expect(isPaymentIntentId(undefined)).toBe(false);
    });
    it('idempotency keys are stable within a minute and change across minutes', () => {
        const t0 = new Date('2026-09-11T10:00:10Z'); const t1 = new Date('2026-09-11T10:00:50Z'); const t2 = new Date('2026-09-11T10:01:10Z');
        expect(captureIdempotencyKey('pi_1', t0)).toBe(captureIdempotencyKey('pi_1', t1));
        expect(captureIdempotencyKey('pi_1', t0)).not.toBe(captureIdempotencyKey('pi_1', t2));
        expect(captureIdempotencyKey('pi_1', t0)).toMatch(/^cg-capture-pi_1-\d+$/);
        expect(cancelIdempotencyKey('pi_1', t0)).toMatch(/^cg-cancel-pi_1-\d+$/);
    });
    it('formats amounts and never throws', () => {
        expect(formatMinor(123456, 'GBP')).toBe('£1,234.56');
        expect(formatMinor(50000, 'JPY')).toMatch(/50,000/);
        expect(formatMinor(100, 'XXXX')).toBe('100 XXXX');
    });
});
