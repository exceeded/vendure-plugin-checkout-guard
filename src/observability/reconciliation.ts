import { OrphanCandidate, StripeIntentLite } from './types';

/**
 * Stripe reconciliation — pure matching plus a thin, injectable-fetch
 * lister so the cron's logic is unit-testable without the network.
 */

export const STRIPE_API_VERSION = '2022-11-15';

/** PaymentIntent statuses that represent money (captured or reserved). */
export const RECONCILE_STATUSES: ReadonlySet<string> = new Set(['succeeded', 'requires_capture']);

export interface MatchOptions {
    /**
     * Only intents carrying Vendure checkout metadata (orderCode / orderId
     * / channelToken — set by @vendure/payments-plugin and by the hold
     * flow) are considered. Intents created elsewhere on the same Stripe
     * account (invoice pay links, dashboard charges) are ignored unless
     * this is set. Default true.
     */
    requireVendureMetadata?: boolean;
    /** Ignore intents younger than this — the webhook may still be in flight. Default 15 min. */
    graceMs?: number;
    now?: Date;
}

export function vendureMetadataOf(pi: StripeIntentLite): { orderCode: string | null; orderId: string | null; channelToken: string | null } {
    const m = pi.metadata || {};
    return {
        orderCode: m.orderCode || null,
        orderId: m.orderId || null,
        channelToken: m.channelToken || null,
    };
}

/**
 * Compare a page of intents against the set of `payment.transactionId`
 * values known to Vendure; return the ones that hold money but have no
 * payment row.
 */
export function findOrphanIntents(
    intents: StripeIntentLite[],
    knownTransactionIds: ReadonlySet<string>,
    opts: MatchOptions = {},
): OrphanCandidate[] {
    const requireMeta = opts.requireVendureMetadata !== false;
    const graceMs = opts.graceMs ?? 15 * 60_000;
    const nowMs = (opts.now || new Date()).getTime();
    const out: OrphanCandidate[] = [];
    for (const pi of intents) {
        if (!pi || typeof pi.id !== 'string' || !/^pi_[A-Za-z0-9]+$/.test(pi.id)) continue;
        if (!RECONCILE_STATUSES.has(pi.status)) continue;
        if (knownTransactionIds.has(pi.id)) continue;
        const createdMs = (Number(pi.created) || 0) * 1000;
        if (createdMs && nowMs - createdMs < graceMs) continue;
        const meta = vendureMetadataOf(pi);
        if (requireMeta && !meta.orderCode && !meta.orderId && !meta.channelToken) continue;
        out.push({
            paymentIntentId: pi.id,
            amountMinor: Number(pi.amount) || 0,
            currency: String(pi.currency || '').toUpperCase(),
            createdAt: new Date(createdMs || nowMs),
            orderCode: meta.orderCode,
            orderId: meta.orderId,
            channelToken: meta.channelToken,
            status: pi.status,
        });
    }
    return out;
}

export type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

export interface ListIntentsOptions {
    fetchImpl?: FetchLike;
    timeoutMs?: number;
    /** Safety cap on pages (100 intents each). Default 50 → 5,000 intents. */
    maxPages?: number;
    log?: (msg: string) => void;
}

/**
 * `GET /v1/payment_intents?created[gte]=…&limit=100`, following
 * `starting_after` until `has_more` is false. Errors stop pagination and
 * are reported through `opts.log`; whatever was collected is returned
 * together with an `incomplete` flag so the caller never treats a
 * partial listing as authoritative.
 */
export async function listStripePaymentIntents(
    apiKey: string,
    createdGteEpochSeconds: number,
    opts: ListIntentsOptions = {},
): Promise<{ intents: StripeIntentLite[]; incomplete: boolean }> {
    const fetchImpl: FetchLike = opts.fetchImpl ?? (globalThis as any).fetch;
    const log = opts.log ?? (() => undefined);
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const maxPages = Math.max(1, opts.maxPages ?? 50);
    const intents: StripeIntentLite[] = [];
    if (typeof fetchImpl !== 'function' || !apiKey) return { intents, incomplete: true };

    let startingAfter: string | null = null;
    for (let page = 0; page < maxPages; page++) {
        const params = new URLSearchParams();
        params.set('created[gte]', String(Math.floor(createdGteEpochSeconds)));
        params.set('limit', '100');
        if (startingAfter) params.set('starting_after', startingAfter);
        const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = setTimeout(() => ac?.abort(), timeoutMs);
        let body: any;
        try {
            const res = await fetchImpl(`https://api.stripe.com/v1/payment_intents?${params.toString()}`, {
                method: 'GET',
                headers: { Authorization: `Bearer ${apiKey}`, 'Stripe-Version': STRIPE_API_VERSION },
                signal: ac?.signal,
            });
            if (!res || !res.ok) {
                log(`Stripe GET payment_intents returned HTTP ${res?.status ?? '?'}`);
                return { intents, incomplete: true };
            }
            body = await res.json();
        } catch (e: any) {
            log(`Stripe GET payment_intents failed: ${e?.message || e}`);
            return { intents, incomplete: true };
        } finally {
            clearTimeout(timer);
        }
        const data: any[] = Array.isArray(body?.data) ? body.data : [];
        for (const pi of data) {
            intents.push({
                id: pi.id,
                status: pi.status,
                amount: pi.amount,
                currency: pi.currency,
                created: pi.created,
                metadata: pi.metadata || null,
                description: pi.description || null,
            });
        }
        if (!body?.has_more || !data.length) return { intents, incomplete: false };
        startingAfter = data[data.length - 1].id;
    }
    log(`Stripe payment_intents listing hit the ${maxPages}-page cap`);
    return { intents, incomplete: true };
}
