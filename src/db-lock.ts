import { Logger } from '@vendure/core';

const loggerCtx = 'CheckoutGuard';

/**
 * A named, cross-process mutual-exclusion lock held on a dedicated database
 * connection for the duration of `fn` (MariaDB/MySQL `GET_LOCK`, Postgres
 * `pg_try_advisory_lock`). Two worker processes, or the admin "Run now" on
 * the server racing the worker's daily tick, can no longer both charge a
 * late fee or send the same reminder.
 *
 * Returns `null` without running `fn` when the lock is held elsewhere and
 * `waitSeconds` elapsed. A database without lock support (unit tests with a
 * stub connection) runs `fn` unguarded.
 */
export async function withDbLock<R>(
    rawConnection: any, name: string, fn: () => Promise<R>, waitSeconds = 0,
): Promise<{ acquired: boolean; result: R | null }> {
    const runner = typeof rawConnection?.createQueryRunner === 'function' ? rawConnection.createQueryRunner() : null;
    if (!runner) return { acquired: true, result: await fn() };
    const type = String(rawConnection?.options?.type || '');
    const pg = type === 'postgres';
    const key = `hulo_bc:${name}`.slice(0, 64);
    let held = false;
    try {
        await runner.connect();
        if (pg) {
            const deadline = Date.now() + Math.max(0, waitSeconds) * 1000;
            for (;;) {
                const rows = await runner.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [key]);
                held = rows?.[0]?.ok === true || rows?.[0]?.ok === 't';
                if (held || Date.now() >= deadline) break;
                await new Promise(r => setTimeout(r, 250));
            }
        } else {
            const rows = await runner.query('SELECT GET_LOCK(?, ?) AS ok', [key, Math.max(0, waitSeconds)]);
            held = Number(rows?.[0]?.ok) === 1;
        }
    } catch (e: any) {
        // Locks are an optimisation on top of the per-row guards: never fail the job because of them.
        Logger.warn(`DB lock "${name}" unavailable (${e?.message || e}); running unguarded`, loggerCtx);
        await runner.release().catch(() => undefined);
        return { acquired: true, result: await fn() };
    }
    if (!held) {
        await runner.release().catch(() => undefined);
        return { acquired: false, result: null };
    }
    try {
        return { acquired: true, result: await fn() };
    } finally {
        try {
            if (pg) await runner.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
            else await runner.query('SELECT RELEASE_LOCK(?)', [key]);
        } catch { /* the connection close releases it anyway */ }
        await runner.release().catch(() => undefined);
    }
}
