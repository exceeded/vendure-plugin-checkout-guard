import type { Order, OrderByCodeAccessStrategy, RequestContext } from '@vendure/core';
import { hashSessionToken, hashesEqual, parseDuration, readStoredSessionHash } from './session-hash';

export interface SessionBoundOrderAccessOptions {
    /**
     * Grant the default Vendure behaviour (any anonymous session may read the
     * order for `anonymousAccessDuration` after placement) to orders that carry
     * no session hash — i.e. orders created before the plugin was installed.
     * Default `false`: unbound orders are only readable by their owner.
     */
    allowUnboundOrders?: boolean;
}

/**
 * Drop-in replacement for Vendure's `DefaultOrderByCodeAccessStrategy`.
 *
 * Access is granted when:
 *  - the active user owns the order (permanent), or
 *  - the request is anonymous, the SHA-256 of the current session token equals
 *    the order's `cgSessionHash` custom field, and the order is either not yet
 *    placed (the placing session may watch its own order while a redirect
 *    payment flow races the webhook) or was placed within
 *    `anonymousAccessDuration`.
 *
 * Any other anonymous session — including one that merely knows the order
 * code — is refused, so the default 2-hour window no longer leaks licence
 * keys, e-mail and phone number to whoever guesses or shares a code.
 *
 * Host wiring:
 * ```ts
 * orderOptions: { orderByCodeAccessStrategy: new SessionBoundOrderByCodeAccessStrategy('2h') }
 * ```
 */
export class SessionBoundOrderByCodeAccessStrategy implements OrderByCodeAccessStrategy {
    readonly anonymousAccessMs: number;

    constructor(
        anonymousAccessDuration: string | number = '2h',
        private readonly options: SessionBoundOrderAccessOptions = {},
    ) {
        this.anonymousAccessMs = parseDuration(anonymousAccessDuration);
    }

    canAccessOrder(ctx: RequestContext, order: Order): boolean {
        if (!order) return false;

        if (ctx.activeUserId !== undefined && ctx.activeUserId !== null) {
            const ownerId = order.customer?.user?.id;
            return ownerId !== undefined && ownerId !== null && String(ownerId) === String(ctx.activeUserId);
        }

        const stored = readStoredSessionHash(order);
        if (!stored) {
            return !!this.options.allowUnboundOrders && this.placedWithinWindow(order);
        }

        const current = hashSessionToken(ctx.session?.token);
        if (!current || !hashesEqual(current, stored)) return false;

        if (!order.orderPlacedAt) return true;
        return this.placedWithinWindow(order);
    }

    /** Overridable clock for tests. */
    protected now(): number {
        return Date.now();
    }

    private placedWithinWindow(order: Order): boolean {
        if (!order.orderPlacedAt) return false;
        const placedAt = +new Date(order.orderPlacedAt);
        if (!Number.isFinite(placedAt)) return false;
        return this.now() - placedAt < this.anonymousAccessMs;
    }
}
