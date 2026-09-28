import type { DbAdapter } from '@huloglobal/vendure-licence-sdk';

/**
 * Tables are created with `CREATE TABLE IF NOT EXISTS` through the
 * licence-sdk dialect adapter (no TypeORM entities: hosts run with plugin
 * migrations off). Inline ENUM/INDEX/DATETIME(3) are rewritten for
 * Postgres by the adapter.
 */
export const PAYMENT_EVENT_TABLE = 'checkout_guard_payment_event';
export const FUNNEL_EVENT_TABLE = 'checkout_guard_funnel_event';
/** Small key/value table shared by server and worker (reconciliation last-run). */
export const STATE_TABLE = 'checkout_guard_state';

export async function ensureObservabilitySchema(db: DbAdapter): Promise<void> {
    await db.query(`
        CREATE TABLE IF NOT EXISTS ${PAYMENT_EVENT_TABLE} (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            channelId INT NOT NULL,
            orderId INT NULL,
            orderCode VARCHAR(64) NULL,
            kind ENUM('failed','client_declined','orphan','amount_drift','hold_expired','bank_expired') NOT NULL,
            provider VARCHAR(32) NOT NULL,
            providerRef VARCHAR(191) NULL,
            code VARCHAR(64) NULL,
            message VARCHAR(500) NULL,
            amountMinor BIGINT NULL,
            currency VARCHAR(8) NULL,
            ip VARCHAR(64) NULL,
            createdAt DATETIME(3) NOT NULL,
            INDEX idx_cgpe_created (createdAt),
            INDEX idx_cgpe_kind_created (kind, createdAt),
            INDEX idx_cgpe_ip_created (ip, createdAt),
            INDEX idx_cgpe_ref (providerRef),
            INDEX idx_cgpe_order (orderCode)
        )
    `);
    await db.query(`
        CREATE TABLE IF NOT EXISTS ${FUNNEL_EVENT_TABLE} (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            channelId INT NOT NULL,
            orderCode VARCHAR(64) NULL,
            sessionId VARCHAR(128) NULL,
            step VARCHAR(32) NOT NULL,
            detail VARCHAR(500) NULL,
            ip VARCHAR(64) NULL,
            createdAt DATETIME(3) NOT NULL,
            INDEX idx_cgfe_created (createdAt),
            INDEX idx_cgfe_step_created (step, createdAt),
            INDEX idx_cgfe_order (orderCode)
        )
    `);
    await db.query(`
        CREATE TABLE IF NOT EXISTS ${STATE_TABLE} (
            k VARCHAR(64) PRIMARY KEY,
            v TEXT NOT NULL,
            updatedAt DATETIME(3) NOT NULL
        )
    `);
    // Vendure never indexes payment.transactionId or (state, method), yet the
    // webhook dedupe, hold lookups and dashboard counts filter on them.
    // Best effort: MariaDB ≥10.1 and Postgres accept IF NOT EXISTS; MySQL 8
    // does not, and a host without ALTER rights just keeps the scans.
    for (const ddl of [
        'CREATE INDEX IF NOT EXISTS idx_cg_payment_txn ON payment (`transactionId`)',
        'CREATE INDEX IF NOT EXISTS idx_cg_payment_state_method ON payment (state, method)',
    ]) {
        try { await db.query(ddl); } catch { /* optional */ }
    }
}
