import { createHash, timingSafeEqual } from 'crypto';
import { CustomFieldConfig, LanguageCode, RuntimeVendureConfig } from '@vendure/core';

/**
 * Name of the Order custom field that stores the SHA-256 of the session token
 * which created the order. Internal + readonly + non-public, so it never
 * appears in either GraphQL schema or the admin UI.
 */
export const CG_SESSION_HASH_FIELD = 'cgSessionHash' as const;

/** DB column TypeORM derives for the custom field (for host migrations). */
export const CG_SESSION_HASH_COLUMN = 'customFieldsCgsessionhash';

/**
 * Custom-field fragment the plugin's `configuration` hook merges into
 * `config.customFields.Order`. Exported separately so a host that composes
 * its own custom-field list can include it verbatim.
 */
export const cgSessionHashCustomField: CustomFieldConfig = {
    name: CG_SESSION_HASH_FIELD,
    type: 'string',
    length: 64,
    nullable: true,
    public: false,
    readonly: true,
    internal: true,
    label: [{ languageCode: LanguageCode.en, value: 'Checkout Guard: session hash' }],
    description: [{
        languageCode: LanguageCode.en,
        value: 'SHA-256 of the shop session token that created the order. Used to bind anonymous orderByCode lookups to the placing session.',
    }],
};

/**
 * Idempotently registers the plugin's Order custom fields on a Vendure config.
 * Safe to call more than once (the host may also list the field itself).
 */
export function registerCheckoutGuardCustomFields(config: RuntimeVendureConfig): RuntimeVendureConfig {
    const existing = config.customFields.Order || [];
    if (!existing.some(field => field.name === CG_SESSION_HASH_FIELD)) {
        config.customFields.Order = existing.concat([cgSessionHashCustomField]);
    }
    return config;
}

/**
 * SHA-256 hex digest of a session token. Returns `null` for empty input so
 * callers can treat "no session" and "no token" uniformly.
 */
export function hashSessionToken(token: string | null | undefined): string | null {
    if (token === null || token === undefined) return null;
    const value = String(token);
    if (!value) return null;
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Constant-time comparison of two hex digests (or any two strings). */
export function hashesEqual(a: string | null | undefined, b: string | null | undefined): boolean {
    if (!a || !b) return false;
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
}

/** Reads the stored session hash off an Order entity (or plain object). */
export function readStoredSessionHash(order: { customFields?: unknown } | null | undefined): string | null {
    const fields = order?.customFields as Record<string, unknown> | undefined;
    const value = fields?.[CG_SESSION_HASH_FIELD];
    return typeof value === 'string' && value.length > 0 ? value : null;
}

const DURATION_UNITS: Record<string, number> = {
    ms: 1,
    msec: 1, msecs: 1, millisecond: 1, milliseconds: 1,
    s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
    m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
    h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
    d: 86_400_000, day: 86_400_000, days: 86_400_000,
    w: 604_800_000, week: 604_800_000, weeks: 604_800_000,
    y: 31_557_600_000, yr: 31_557_600_000, yrs: 31_557_600_000, year: 31_557_600_000, years: 31_557_600_000,
};

/**
 * Parses an `ms`-style duration (`'2h'`, `'30m'`, `'5 days'`, `'1500'`, or a
 * number of milliseconds) into milliseconds. Throws on anything it cannot
 * parse so a misconfigured host fails at boot rather than silently opening
 * or closing the anonymous access window.
 */
export function parseDuration(value: string | number): number {
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || value < 0) {
            throw new Error(`Invalid duration: ${value}`);
        }
        return value;
    }
    const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]+)?\s*$/i.exec(String(value ?? ''));
    if (!match) {
        throw new Error(`Invalid duration: "${value}"`);
    }
    const amount = parseFloat(match[1]);
    const unit = (match[2] || 'ms').toLowerCase();
    const factor = DURATION_UNITS[unit];
    if (factor === undefined) {
        throw new Error(`Invalid duration unit in "${value}"`);
    }
    return Math.round(amount * factor);
}

export interface SessionHashDecisionInput {
    /** `event.ctx.apiType` — only shop-side events bind a session. */
    apiType: string | undefined;
    /** `event.type` from the OrderEvent. */
    type: 'created' | 'updated' | 'deleted' | string;
    /** Hash already stored on the order, if any. */
    existingHash: string | null | undefined;
    /** `event.ctx.session?.token`. */
    sessionToken: string | null | undefined;
}

/**
 * Pure decision for the OrderEvent subscriber: returns the hash to write, or
 * `null` when nothing should be written.
 *
 * - Only shop-API events qualify (admin/worker contexts are not the customer).
 * - `created` binds the order to the creating session.
 * - `updated` only back-fills orders that have no hash yet (orders created
 *   before the plugin was installed); an existing binding is never rotated,
 *   otherwise a later session touching the order could steal the lookup.
 */
export function decideSessionHashWrite(input: SessionHashDecisionInput): string | null {
    if (input.apiType !== 'shop') return null;
    if (input.type !== 'created' && input.type !== 'updated') return null;
    const hash = hashSessionToken(input.sessionToken);
    if (!hash) return null;
    if (input.type === 'updated' && input.existingHash) return null;
    if (input.existingHash === hash) return null;
    return hash;
}
