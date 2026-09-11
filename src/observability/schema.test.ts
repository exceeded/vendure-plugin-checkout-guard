import { describe, expect, it } from 'vitest';
import { translateSql } from '@huloglobal/vendure-licence-sdk';
import { ensureObservabilitySchema, FUNNEL_EVENT_TABLE, PAYMENT_EVENT_TABLE } from './schema';

/** Capture the DDL the schema helper issues, then translate it for Postgres
 *  to prove nothing MySQL-only (ENUM, inline INDEX, DATETIME(3)) survives. */
async function capture(): Promise<string[]> {
    const sql: string[] = [];
    await ensureObservabilitySchema({ dialect: 'mysql', query: async (s: string) => { sql.push(s); return []; } });
    return sql;
}

describe('ensureObservabilitySchema', () => {
    it('creates both tables idempotently', async () => {
        const sql = await capture();
        expect(sql).toHaveLength(2);
        expect(sql[0]).toContain(`CREATE TABLE IF NOT EXISTS ${PAYMENT_EVENT_TABLE}`);
        expect(sql[1]).toContain(`CREATE TABLE IF NOT EXISTS ${FUNNEL_EVENT_TABLE}`);
        for (const k of ['failed', 'client_declined', 'orphan', 'amount_drift', 'hold_expired', 'bank_expired']) {
            expect(sql[0]).toContain(`'${k}'`);
        }
    });

    it('translates cleanly for Postgres', async () => {
        for (const s of await capture()) {
            const pg = translateSql(s, 'postgres');
            expect(pg).not.toMatch(/ENUM\s*\(/i);
            expect(pg).not.toMatch(/AUTO_INCREMENT/i);
            expect(pg).not.toMatch(/DATETIME/i);
            expect(pg).toContain('BIGSERIAL PRIMARY KEY');
            // inline indexes lifted into CREATE INDEX IF NOT EXISTS statements
            expect(pg).toMatch(/CREATE INDEX IF NOT EXISTS idx_cg/);
            const body = pg.split(';')[0];
            expect(body).not.toMatch(/\bINDEX\s+idx_/);
        }
    });
});
