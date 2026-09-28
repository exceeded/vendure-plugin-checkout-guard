import { FUNNEL_CHAIN, FUNNEL_STEPS, FunnelStep, FunnelStepSummary, FunnelSummary } from './types';

/** A funnel row as read back from the table (only what the summary needs). */
export interface FunnelRowLite {
    id?: number | string;
    step: string;
    orderCode?: string | null;
    sessionId?: string | null;
    ip?: string | null;
}

export function isFunnelStep(v: unknown): v is FunnelStep {
    return typeof v === 'string' && (FUNNEL_STEPS as readonly string[]).includes(v);
}

/**
 * The identity a row is counted under for "unique checkouts": the order
 * code when the storefront sent one, else the storefront session id,
 * else the client IP, else the row itself (never merged).
 */
export function funnelKey(row: FunnelRowLite): string {
    if (row.orderCode) return `o:${row.orderCode}`;
    if (row.sessionId) return `s:${row.sessionId}`;
    if (row.ip) return `ip:${row.ip}`;
    return `row:${row.id ?? Math.random()}`;
}

function pct(numerator: number, denominator: number): number | null {
    if (!denominator) return null;
    return Math.round((numerator / denominator) * 1000) / 10;
}

/**
 * Pure aggregation: counts per step (raw + unique) and the drop-off
 * between consecutive chain steps. Unique counts are computed on the
 * whole window, so a session that fires `payment` twice counts once.
 */
export function summariseFunnel(rows: FunnelRowLite[], days: number): FunnelSummary {
    const events = new Map<FunnelStep, number>();
    const uniques = new Map<FunnelStep, Set<string>>();
    for (const step of FUNNEL_STEPS) {
        events.set(step, 0);
        uniques.set(step, new Set());
    }
    for (const row of rows) {
        if (!isFunnelStep(row.step)) continue;
        events.set(row.step, (events.get(row.step) || 0) + 1);
        uniques.get(row.step)!.add(funnelKey(row));
    }
    return summariseFunnelCounts(
        FUNNEL_STEPS.map(step => ({ step, events: events.get(step) || 0, unique: uniques.get(step)!.size })), days,
    );
}

/** One aggregated row per step, as `GROUP BY step` returns it. */
export interface FunnelStepCounts { step: string; events: number; unique: number; }

/** The same summary from per-step counts (the database did the counting). */
export function summariseFunnelCounts(counts: FunnelStepCounts[], days: number): FunnelSummary {
    const events = new Map<FunnelStep, number>();
    const uniques = new Map<FunnelStep, { size: number }>();
    for (const step of FUNNEL_STEPS) {
        events.set(step, 0);
        uniques.set(step, { size: 0 });
    }
    for (const c of counts) {
        if (!isFunnelStep(c.step)) continue;
        events.set(c.step, (events.get(c.step) || 0) + (Number(c.events) || 0));
        uniques.get(c.step)!.size += Number(c.unique) || 0;
    }

    const steps: FunnelStepSummary[] = [];
    let worst: { step: FunnelStep; pct: number } | null = null;
    let prevChainUnique: number | null = null;
    for (const step of FUNNEL_STEPS) {
        const unique = uniques.get(step)!.size;
        let dropOffPct: number | null = null;
        if (FUNNEL_CHAIN.includes(step)) {
            if (prevChainUnique !== null && prevChainUnique > 0) {
                dropOffPct = pct(Math.max(0, prevChainUnique - unique), prevChainUnique);
                if (dropOffPct !== null && (!worst || dropOffPct > worst.pct)) {
                    worst = { step, pct: dropOffPct };
                }
            }
            // A step nobody has instrumented yet (0 uniques while the next
            // step has traffic) must not read as a 100% drop-off: only
            // advance the baseline when the step carried data.
            if (unique > 0 || prevChainUnique === null) prevChainUnique = unique;
        }
        steps.push({ step, events: events.get(step) || 0, unique, dropOffPct });
    }

    const firstPopulated = FUNNEL_CHAIN.map(s => uniques.get(s)!.size).find(n => n > 0) || 0;
    const placed = uniques.get('placed')!.size;
    const attempts = uniques.get('pay_attempt')!.size;
    const failed = uniques.get('pay_failed')!.size;

    return {
        days,
        steps,
        conversionPct: pct(placed, firstPopulated),
        worstDropOffPct: worst?.pct ?? null,
        worstDropOffStep: worst?.step ?? null,
        paymentFailureRatePct: pct(failed, attempts),
        couponRejections: events.get('coupon_rejected') || 0,
    };
}
