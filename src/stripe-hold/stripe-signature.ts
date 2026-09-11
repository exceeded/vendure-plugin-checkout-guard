import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Stripe webhook signature verification without the Stripe SDK.
 *
 * Header: `t=<unix seconds>,v1=<hex hmac>[,v1=<hex hmac>...][,v0=...]`
 * Signed payload: `${t}.${rawBody}` with HMAC-SHA256 over the endpoint
 * secret. Any `v1` entry matching (constant-time) passes; timestamps
 * outside `toleranceSec` are rejected to defeat replay.
 *
 * https://docs.stripe.com/webhooks#verify-manually
 */

export const DEFAULT_SIGNATURE_TOLERANCE_SEC = 300;

export interface ParsedStripeSignature {
    timestamp: number;
    signatures: string[];
}

export class StripeSignatureError extends Error {
    constructor(message: string, public readonly reason:
        'missing_header' | 'malformed_header' | 'no_signatures' | 'timestamp_out_of_tolerance' | 'no_match' | 'missing_secret' | 'missing_body') {
        super(message);
        this.name = 'StripeSignatureError';
    }
}

export function parseStripeSignatureHeader(header: string | undefined | null): ParsedStripeSignature {
    if (!header || typeof header !== 'string') {
        throw new StripeSignatureError('Missing stripe-signature header', 'missing_header');
    }
    let timestamp = NaN;
    const signatures: string[] = [];
    for (const part of header.split(',')) {
        const idx = part.indexOf('=');
        if (idx <= 0) continue;
        const k = part.slice(0, idx).trim();
        const v = part.slice(idx + 1).trim();
        if (k === 't') timestamp = Number(v);
        else if (k === 'v1' && /^[0-9a-f]{64}$/i.test(v)) signatures.push(v.toLowerCase());
    }
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
        throw new StripeSignatureError('Malformed stripe-signature header (no timestamp)', 'malformed_header');
    }
    if (!signatures.length) {
        throw new StripeSignatureError('No v1 signatures in stripe-signature header', 'no_signatures');
    }
    return { timestamp: Math.floor(timestamp), signatures };
}

export function computeStripeSignature(payload: Buffer | string, secret: string, timestamp: number): string {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
    return createHmac('sha256', secret)
        .update(`${timestamp}.`)
        .update(body)
        .digest('hex');
}

export interface VerifyOptions {
    toleranceSec?: number;
    /** Injectable clock (unix seconds) for tests. */
    nowSec?: number;
}

/** Throws `StripeSignatureError` on any failure; returns the parsed
 *  timestamp on success. Never falls back to trusting the payload. */
export function verifyStripeSignature(
    payload: Buffer | string | undefined,
    header: string | undefined | null,
    secret: string | undefined,
    opts: VerifyOptions = {},
): { timestamp: number } {
    if (!secret) throw new StripeSignatureError('No webhook secret configured', 'missing_secret');
    if (payload === undefined || payload === null || (Buffer.isBuffer(payload) ? payload.length === 0 : payload.length === 0)) {
        throw new StripeSignatureError('Empty request body', 'missing_body');
    }
    const parsed = parseStripeSignatureHeader(header);
    const tolerance = opts.toleranceSec ?? DEFAULT_SIGNATURE_TOLERANCE_SEC;
    const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
    if (tolerance > 0 && Math.abs(now - parsed.timestamp) > tolerance) {
        throw new StripeSignatureError('Webhook timestamp outside tolerance', 'timestamp_out_of_tolerance');
    }
    const expected = Buffer.from(computeStripeSignature(payload, secret, parsed.timestamp), 'hex');
    const ok = parsed.signatures.some(sig => {
        const got = Buffer.from(sig, 'hex');
        return got.length === expected.length && timingSafeEqual(got, expected);
    });
    if (!ok) throw new StripeSignatureError('Signature mismatch', 'no_match');
    return { timestamp: parsed.timestamp };
}

/** Build a header the way Stripe does — used by tests and the e2e harness. */
export function buildStripeSignatureHeader(payload: Buffer | string, secret: string, timestamp: number = Math.floor(Date.now() / 1000)): string {
    return `t=${timestamp},v1=${computeStripeSignature(payload, secret, timestamp)}`;
}

/** Verify + parse in one go. Returns the event object (untyped). */
export function constructStripeEvent(
    payload: Buffer | string | undefined,
    header: string | undefined | null,
    secret: string | undefined,
    opts: VerifyOptions = {},
): any {
    verifyStripeSignature(payload, header, secret, opts);
    const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);
    return JSON.parse(text);
}
