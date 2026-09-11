import { describe, expect, it } from 'vitest';
import {
    StripeSignatureError, buildStripeSignatureHeader, computeStripeSignature, constructStripeEvent, parseStripeSignatureHeader,
    verifyStripeSignature,
} from './stripe-signature';

const secret = 'whsec_test_secret_123';
const body = Buffer.from(JSON.stringify({ id: 'evt_1', type: 'payment_intent.amount_capturable_updated', data: { object: { id: 'pi_1' } } }));
const now = 1_760_000_000;

function reason(fn: () => unknown): string {
    try { fn(); } catch (e) { return e instanceof StripeSignatureError ? e.reason : 'other'; }
    return 'none';
}

describe('parseStripeSignatureHeader', () => {
    it('parses timestamp and every v1 signature, ignoring v0', () => {
        const sig = 'a'.repeat(64);
        const p = parseStripeSignatureHeader(`t=${now},v1=${sig},v0=${'b'.repeat(64)},v1=${'c'.repeat(64)}`);
        expect(p.timestamp).toBe(now);
        expect(p.signatures).toEqual([sig, 'c'.repeat(64)]);
    });
    it('rejects missing/malformed headers', () => {
        expect(reason(() => parseStripeSignatureHeader(undefined))).toBe('missing_header');
        expect(reason(() => parseStripeSignatureHeader('v1=abc'))).toBe('malformed_header');
        expect(reason(() => parseStripeSignatureHeader(`t=${now}`))).toBe('no_signatures');
        expect(reason(() => parseStripeSignatureHeader(`t=${now},v1=nothex`))).toBe('no_signatures');
    });
});

describe('verifyStripeSignature', () => {
    it('accepts a header Stripe would produce', () => {
        const header = buildStripeSignatureHeader(body, secret, now);
        expect(verifyStripeSignature(body, header, secret, { nowSec: now })).toEqual({ timestamp: now });
        expect(verifyStripeSignature(body.toString('utf8'), header, secret, { nowSec: now + 299 })).toEqual({ timestamp: now });
    });
    it('rejects a tampered body, wrong secret, or replay outside tolerance', () => {
        const header = buildStripeSignatureHeader(body, secret, now);
        expect(reason(() => verifyStripeSignature(Buffer.from(body.toString() + ' '), header, secret, { nowSec: now }))).toBe('no_match');
        expect(reason(() => verifyStripeSignature(body, header, 'whsec_other', { nowSec: now }))).toBe('no_match');
        expect(reason(() => verifyStripeSignature(body, header, secret, { nowSec: now + 301 }))).toBe('timestamp_out_of_tolerance');
        expect(reason(() => verifyStripeSignature(body, header, secret, { nowSec: now - 301 }))).toBe('timestamp_out_of_tolerance');
        expect(verifyStripeSignature(body, header, secret, { nowSec: now + 10_000, toleranceSec: 0 }).timestamp).toBe(now);
    });
    it('never falls back when the secret or body is missing', () => {
        const header = buildStripeSignatureHeader(body, secret, now);
        expect(reason(() => verifyStripeSignature(body, header, undefined, { nowSec: now }))).toBe('missing_secret');
        expect(reason(() => verifyStripeSignature(body, header, '', { nowSec: now }))).toBe('missing_secret');
        expect(reason(() => verifyStripeSignature(undefined, header, secret, { nowSec: now }))).toBe('missing_body');
        expect(reason(() => verifyStripeSignature(Buffer.alloc(0), header, secret, { nowSec: now }))).toBe('missing_body');
    });
    it('passes when any one v1 entry matches (key rollover)', () => {
        const good = computeStripeSignature(body, secret, now);
        const header = `t=${now},v1=${'0'.repeat(64)},v1=${good}`;
        expect(verifyStripeSignature(body, header, secret, { nowSec: now }).timestamp).toBe(now);
    });
});

describe('constructStripeEvent', () => {
    it('returns the parsed event after verification', () => {
        const header = buildStripeSignatureHeader(body, secret, now);
        const ev = constructStripeEvent(body, header, secret, { nowSec: now });
        expect(ev.type).toBe('payment_intent.amount_capturable_updated');
        expect(ev.data.object.id).toBe('pi_1');
    });
    it('throws before parsing on a bad signature', () => {
        expect(() => constructStripeEvent(body, `t=${now},v1=${'f'.repeat(64)}`, secret, { nowSec: now })).toThrow(StripeSignatureError);
    });
});
