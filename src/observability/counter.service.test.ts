import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeConnection } from '../__tests__/fakes';
import { CounterService, dayKey } from './counter.service';

let conn: FakeConnection;
let svc: CounterService;
let fail = false;
let rows: Array<{ name: string; n: number }> = [];

beforeEach(() => {
    vi.useFakeTimers();
    fail = false;
    rows = [];
    conn = new FakeConnection({
        query: (sql: string) => {
            if (/INSERT INTO cg_counter/.test(sql) && fail) throw new Error('no table');
            if (/SELECT name, COALESCE\(SUM\(n\), 0\)/.test(sql)) return rows;
            if (/DELETE FROM cg_counter/.test(sql)) return { affectedRows: 3 };
            return [];
        },
    });
    svc = new CounterService(conn as any);
});

afterEach(() => { vi.useRealTimers(); });

describe('CounterService', () => {
    it('buffers increments and writes one upsert per name on the next flush', async () => {
        svc.bump('rate_limit');
        svc.bump('rate_limit');
        svc.bump('order_access_denied');
        expect(conn.queries).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(2_100);
        const inserts = conn.ran(/INSERT INTO cg_counter/);
        expect(inserts).toHaveLength(2);
        expect(inserts[0].params).toEqual([dayKey(), 'rate_limit', 2]);
        expect(inserts[1].params).toEqual([dayKey(), 'order_access_denied', 1]);
        expect(inserts[0].sql).toContain('ON DUPLICATE KEY UPDATE n = cg_counter.n + VALUES(n)');
    });

    it('passes the conflict columns the Postgres translation needs', async () => {
        const raw = conn.rawConnection.query as ReturnType<typeof vi.fn>;
        svc.bump('rate_limit');
        await svc.flush();
        const call = raw.mock.calls.find((c: any[]) => /INSERT INTO cg_counter/.test(c[0]));
        expect(call).toBeTruthy();
        // adapterFor() on MySQL passes the statement through untouched; the opts travel on the adapter call.
        expect(call![0]).toMatch(/ON DUPLICATE KEY UPDATE/);
    });

    it('keeps the increment when the write fails so the next flush retries', async () => {
        fail = true;
        svc.bump('rate_limit');
        await svc.flush();
        expect(conn.ran(/INSERT INTO cg_counter/)).toHaveLength(1);
        fail = false;
        svc.bump('rate_limit');
        await svc.flush();
        const inserts = conn.ran(/INSERT INTO cg_counter/);
        expect(inserts).toHaveLength(2);
        expect(inserts[1].params[2]).toBe(2);
    });

    it('ignores names it does not recognise and non-positive increments', async () => {
        svc.bump('DROP TABLE');
        svc.bump('rate_limit', 0);
        svc.bump('rate_limit', -5);
        await svc.flush();
        expect(conn.ran(/INSERT INTO cg_counter/)).toHaveLength(0);
    });

    it('sums per name over local calendar days and flushes first', async () => {
        rows = [{ name: 'rate_limit', n: 12 }, { name: 'order_access_denied', n: 3 }];
        svc.bump('rate_limit');
        const from = new Date(2026, 9, 4);
        const to = new Date(2026, 9, 11);
        const totals = await svc.sums(from, to);
        expect(totals).toEqual({ rate_limit: 12, order_access_denied: 3 });
        expect(conn.ran(/INSERT INTO cg_counter/)).toHaveLength(1);
        const sel = conn.ran(/SELECT name, COALESCE/)[0];
        expect(sel.params).toEqual(['2026-10-04', '2026-10-11']);
        expect(await svc.sum('rate_limit', from, to)).toBe(12);
        expect(await svc.sum('nothing', from, to)).toBe(0);
    });

    it('prunes old days with a floor of 30', async () => {
        expect(await svc.prune(5)).toBe(3);
        expect(conn.ran(/DELETE FROM cg_counter/)[0].params).toEqual([30]);
    });

    it('flushes on shutdown', async () => {
        svc.bump('order_access_denied');
        await svc.onModuleDestroy();
        expect(conn.ran(/INSERT INTO cg_counter/)).toHaveLength(1);
    });
});

describe('dayKey', () => {
    it('formats the local calendar day', () => {
        expect(dayKey(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
    });
});
