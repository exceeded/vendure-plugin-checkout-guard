import { describe, expect, it } from 'vitest';
import { SessionBoundOrderByCodeAccessStrategy } from './session-bound-order-access.strategy';
import { CG_SESSION_HASH_FIELD, hashSessionToken } from './session-hash';

const NOW = Date.parse('2026-09-11T10:00:00Z');
const HOUR = 3_600_000;

class TestStrategy extends SessionBoundOrderByCodeAccessStrategy {
    protected now(): number {
        return NOW;
    }
}

const OWNER_TOKEN = 'owner-session-token';
const OWNER_HASH = hashSessionToken(OWNER_TOKEN)!;

function order(overrides: Record<string, unknown> = {}): any {
    return {
        id: 1,
        code: 'ABC123',
        orderPlacedAt: new Date(NOW - 10 * 60_000),
        customer: { id: 7, user: { id: 42 } },
        customFields: { [CG_SESSION_HASH_FIELD]: OWNER_HASH },
        ...overrides,
    };
}

function ctx(overrides: { activeUserId?: unknown; sessionToken?: string | null } = {}): any {
    return {
        activeUserId: overrides.activeUserId,
        session: overrides.sessionToken === null ? undefined : { token: overrides.sessionToken ?? OWNER_TOKEN },
        apiType: 'shop',
    };
}

describe('SessionBoundOrderByCodeAccessStrategy', () => {
    const strategy = new TestStrategy('2h');

    it('parses the duration at construction', () => {
        expect(strategy.anonymousAccessMs).toBe(2 * HOUR);
        expect(new TestStrategy().anonymousAccessMs).toBe(2 * HOUR);
        expect(() => new TestStrategy('never')).toThrow();
    });

    it('grants the owning user permanent access', () => {
        expect(strategy.canAccessOrder(ctx({ activeUserId: 42, sessionToken: 'anything' }), order({ orderPlacedAt: new Date(NOW - 400 * 24 * HOUR) }))).toBe(true);
        expect(strategy.canAccessOrder(ctx({ activeUserId: '42', sessionToken: 'anything' }), order())).toBe(true);
    });

    it('refuses other logged-in users even with the placing session', () => {
        expect(strategy.canAccessOrder(ctx({ activeUserId: 99 }), order())).toBe(false);
        expect(strategy.canAccessOrder(ctx({ activeUserId: 99 }), order({ customer: undefined }))).toBe(false);
    });

    it('grants the placing anonymous session within the window', () => {
        expect(strategy.canAccessOrder(ctx(), order())).toBe(true);
        expect(strategy.canAccessOrder(ctx(), order({ orderPlacedAt: new Date(NOW - 2 * HOUR + 1000) }))).toBe(true);
    });

    it('refuses the placing anonymous session after the window', () => {
        expect(strategy.canAccessOrder(ctx(), order({ orderPlacedAt: new Date(NOW - 2 * HOUR) }))).toBe(false);
        expect(strategy.canAccessOrder(ctx(), order({ orderPlacedAt: new Date(NOW - 3 * HOUR) }))).toBe(false);
    });

    it('refuses any other anonymous session, even inside the window', () => {
        expect(strategy.canAccessOrder(ctx({ sessionToken: 'someone-else' }), order())).toBe(false);
        expect(strategy.canAccessOrder(ctx({ sessionToken: null }), order())).toBe(false);
        expect(strategy.canAccessOrder(ctx({ sessionToken: '' }), order())).toBe(false);
    });

    it('lets the placing session watch its own unplaced order', () => {
        expect(strategy.canAccessOrder(ctx(), order({ orderPlacedAt: null }))).toBe(true);
        expect(strategy.canAccessOrder(ctx({ sessionToken: 'someone-else' }), order({ orderPlacedAt: null }))).toBe(false);
    });

    it('refuses anonymous access to unbound orders by default', () => {
        expect(strategy.canAccessOrder(ctx(), order({ customFields: {} }))).toBe(false);
        expect(strategy.canAccessOrder(ctx(), order({ customFields: undefined }))).toBe(false);
    });

    it('falls back to the default window for unbound orders when allowed', () => {
        const lenient = new TestStrategy('2h', { allowUnboundOrders: true });
        expect(lenient.canAccessOrder(ctx({ sessionToken: 'anyone' }), order({ customFields: {} }))).toBe(true);
        expect(lenient.canAccessOrder(ctx({ sessionToken: 'anyone' }), order({ customFields: {}, orderPlacedAt: new Date(NOW - 3 * HOUR) }))).toBe(false);
        expect(lenient.canAccessOrder(ctx({ sessionToken: 'anyone' }), order({ customFields: {}, orderPlacedAt: null }))).toBe(false);
    });

    it('handles a missing order defensively', () => {
        expect(strategy.canAccessOrder(ctx(), undefined as any)).toBe(false);
    });
});
