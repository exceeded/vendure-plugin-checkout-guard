import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Logger, TransactionalConnection } from '@vendure/core';
import { adapterFor, DbAdapter } from '@huloglobal/vendure-licence-sdk';
import { COUNTER_TABLE } from './schema';
import { loggerCtx } from './runtime';

/** Local calendar day as `YYYY-MM-DD` (the same clock the stats queries use). */
export function dayKey(d: Date = new Date()): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const FLUSH_MS = 2_000;
const NAME_RE = /^[a-z0-9_]{1,32}$/;

/**
 * Per-day counters (`cg_counter`: day, name, n) for the events that leave
 * no row of their own — Shop API rate-limit rejections and session-bound
 * `orderByCode` refusals. Increments are buffered in memory and written as
 * one upsert per name every two seconds, so a burst of 429s costs one SQL
 * statement, not one per request, and the request path never waits on the
 * database. Runs on both the server (where the guards fire) and the worker.
 *
 * @docsCategory Services
 * @category Services
 */
@Injectable()
export class CounterService implements OnModuleDestroy {
    private pending = new Map<string, number>();
    private timer: NodeJS.Timeout | null = null;
    private flushing: Promise<void> | null = null;

    constructor(private connection: TransactionalConnection) {}

    private get db(): DbAdapter {
        return adapterFor(this.connection.rawConnection);
    }

    /** Increment `name` for today. Synchronous; the write happens on the next flush. */
    bump(name: string, by: number = 1): void {
        if (!NAME_RE.test(name) || !Number.isFinite(by) || by <= 0) return;
        const key = `${dayKey()}|${name}`;
        this.pending.set(key, (this.pending.get(key) || 0) + Math.round(by));
        if (!this.timer) {
            this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, FLUSH_MS);
            if (typeof this.timer.unref === 'function') this.timer.unref();
        }
    }

    /** Write every buffered increment. Safe to call concurrently. */
    async flush(): Promise<void> {
        if (this.flushing) return this.flushing;
        if (this.pending.size === 0) return;
        const batch = this.pending;
        this.pending = new Map();
        this.flushing = (async () => {
            for (const [key, n] of batch) {
                const [day, name] = key.split('|');
                try {
                    await this.db.query(
                        `INSERT INTO ${COUNTER_TABLE} (day, name, n) VALUES (?, ?, ?)
                         ON DUPLICATE KEY UPDATE n = ${COUNTER_TABLE}.n + VALUES(n)`,
                        [day, name, n],
                        { conflictColumns: ['day', 'name'] },
                    );
                } catch (e: any) {
                    // Put the increment back so the next flush retries once the table exists.
                    this.pending.set(key, (this.pending.get(key) || 0) + n);
                    Logger.warn(`Counter ${name} not written: ${e?.message || e}`, loggerCtx);
                }
            }
        })().finally(() => { this.flushing = null; });
        return this.flushing;
    }

    /** Sum of `name` over the calendar days in `[from, to)` (local days). */
    async sum(name: string, from: Date, to: Date): Promise<number> {
        const totals = await this.sums(from, to);
        return totals[name] || 0;
    }

    /** Every counter summed over the calendar days in `[from, to)`. */
    async sums(from: Date, to: Date): Promise<Record<string, number>> {
        await this.flush().catch(() => undefined);
        const rows: Array<{ name: string; n: any }> = await this.db.query(
            `SELECT name, COALESCE(SUM(n), 0) AS n FROM ${COUNTER_TABLE} WHERE day >= ? AND day < ? GROUP BY name`,
            [dayKey(from), dayKey(to)],
        ).catch(() => []);
        const out: Record<string, number> = {};
        for (const r of rows || []) out[String(r.name)] = Number(r.n || 0);
        return out;
    }

    /** Retention: drop counter days older than `days` (default 400). */
    async prune(days: number = 400): Promise<number> {
        const d = Math.max(30, Math.floor(Number(days) || 400));
        const r = await this.db.query(
            `DELETE FROM ${COUNTER_TABLE} WHERE day < DATE_SUB(CURRENT_DATE, INTERVAL ? DAY)`,
            [d], { needAffected: true },
        ).catch(() => null);
        return Number(r?.affectedRows || 0);
    }

    async onModuleDestroy() {
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        await this.flush().catch(() => undefined);
    }
}
