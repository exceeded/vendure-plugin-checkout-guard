import { Injectable, OnModuleInit } from '@nestjs/common';
import { Logger, TransactionalConnection } from '@vendure/core';
import { adapterFor, DbAdapter } from '@huloglobal/vendure-licence-sdk';
import { summariseFunnel } from './funnel';
import { ensureObservabilitySchema, FUNNEL_EVENT_TABLE, PAYMENT_EVENT_TABLE } from './schema';
import { BANK_METHOD_CODE, hasPremium, holdMethodCode, loggerCtx, noteLocked } from './runtime';
import {
    FunnelEventInput,
    FunnelSummary,
    ObservabilitySummary,
    PAYMENT_EVENT_KINDS,
    PaymentEventInput,
    PaymentEventKind,
    PaymentEventRow,
    PREMIUM_EVENT_KINDS,
} from './types';

const MAX_DAYS = 365;
const MAX_LIST = 500;

function clampDays(v: unknown, dflt: number): number {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n) || n < 1) return dflt;
    return Math.min(MAX_DAYS, n);
}

function clampLimit(v: unknown, dflt: number): number {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n) || n < 1) return dflt;
    return Math.min(MAX_LIST, n);
}

function trunc(v: unknown, max: number): string | null {
    if (v === undefined || v === null) return null;
    const s = String(v).trim();
    if (!s) return null;
    return s.length > max ? s.slice(0, max) : s;
}

function intOrNull(v: unknown): number | null {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n) : null;
}

export function isPaymentEventKind(v: unknown): v is PaymentEventKind {
    return typeof v === 'string' && (PAYMENT_EVENT_KINDS as readonly string[]).includes(v);
}

/**
 * Payment-event and funnel-event store plus the admin summaries.
 *
 * Both tables are plain SQL through the licence-sdk dialect adapter, so
 * the fraud-prevention plugin (0.19+) can read
 * `checkout_guard_payment_event` directly for its failed-payments signal.
 */
@Injectable()
export class ObservabilityService implements OnModuleInit {
    constructor(private connection: TransactionalConnection) {}

    private get db(): DbAdapter {
        return adapterFor(this.connection.rawConnection);
    }

    async onModuleInit() {
        try {
            await this.ensureSchema();
        } catch (e: any) {
            Logger.error(`Observability schema init failed: ${e.message}`, loggerCtx);
        }
    }

    async ensureSchema(): Promise<void> {
        await ensureObservabilitySchema(this.db);
    }

    // ── Payment events ───────────────────────────────────────────────

    /**
     * Record a payment event. Premium kinds (failed / orphan / amount_drift
     * / hold_expired) are dropped with a one-time notice on unlicensed
     * installs. Returns the new row id, or null when nothing was written.
     */
    async recordPaymentEvent(input: PaymentEventInput): Promise<number | null> {
        if (!isPaymentEventKind(input.kind)) {
            Logger.warn(`Ignoring payment event with unknown kind "${String(input.kind)}"`, loggerCtx);
            return null;
        }
        if (PREMIUM_EVENT_KINDS.has(input.kind) && !hasPremium()) {
            noteLocked('Failed-payment / reconciliation recording');
            return null;
        }
        try {
            const result = await this.db.query(
                `INSERT INTO ${PAYMENT_EVENT_TABLE}
                    (channelId, orderId, orderCode, kind, provider, providerRef, code, message, amountMinor, currency, ip, createdAt)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3))`,
                [
                    Number(input.channelId) || 1,
                    intOrNull(input.orderId),
                    trunc(input.orderCode, 64),
                    input.kind,
                    trunc(input.provider, 32) || 'unknown',
                    trunc(input.providerRef, 191),
                    trunc(input.code, 64),
                    trunc(input.message, 500),
                    intOrNull(input.amountMinor),
                    trunc(input.currency, 8)?.toUpperCase() ?? null,
                    trunc(input.ip, 64),
                ],
                { needInsertId: true },
            );
            const id = Number(result?.insertId);
            return Number.isFinite(id) ? id : null;
        } catch (e: any) {
            Logger.error(`Could not record payment event (${input.kind}): ${e.message}`, loggerCtx);
            return null;
        }
    }

    /** True when an event of this kind already references `providerRef`. */
    async hasPaymentEvent(kind: PaymentEventKind, providerRef: string): Promise<boolean> {
        if (!providerRef) return false;
        const rows = await this.db.query(
            `SELECT id FROM ${PAYMENT_EVENT_TABLE} WHERE kind = ? AND providerRef = ? LIMIT 1`,
            [kind, providerRef],
        ).catch(() => []);
        return rows.length > 0;
    }

    /**
     * Failed + client-declined payment attempts from an IP in the last
     * `windowMinutes`. Consumed by fraud scoring (fraud-prevention 0.19
     * reads the table directly; hosts may call this instead).
     */
    async countRecentFailures(ip: string, windowMinutes: number = 60): Promise<number> {
        if (!ip) return 0;
        const minutes = Math.max(1, Math.min(60 * 24 * 30, Math.floor(Number(windowMinutes) || 60)));
        const [row] = await this.db.query(
            `SELECT COUNT(*) AS n FROM ${PAYMENT_EVENT_TABLE}
             WHERE ip = ? AND kind IN ('failed', 'client_declined')
               AND createdAt > DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
            [ip, minutes],
        ).catch(() => [{ n: 0 }]);
        return Number(row?.n || 0);
    }

    async listPaymentEvents(filter: {
        kind?: string;
        days?: number | string;
        channelId?: number | string;
        orderCode?: string;
        limit?: number | string;
    } = {}): Promise<PaymentEventRow[]> {
        const days = clampDays(filter.days, 7);
        const limit = clampLimit(filter.limit, 200);
        const where: string[] = ['createdAt > DATE_SUB(NOW(), INTERVAL ? DAY)'];
        const params: any[] = [days];
        if (filter.kind && isPaymentEventKind(filter.kind)) {
            where.push('kind = ?');
            params.push(filter.kind);
        }
        const channelId = intOrNull(filter.channelId);
        if (channelId) {
            where.push('channelId = ?');
            params.push(channelId);
        }
        const orderCode = trunc(filter.orderCode, 64);
        if (orderCode) {
            where.push('orderCode = ?');
            params.push(orderCode);
        }
        const rows = await this.db.query(
            `SELECT id, channelId, orderId, orderCode, kind, provider, providerRef, code, message,
                    amountMinor, currency, ip, createdAt
             FROM ${PAYMENT_EVENT_TABLE}
             WHERE ${where.join(' AND ')}
             ORDER BY id DESC
             LIMIT ${limit}`,
            params,
        );
        return rows.map((r: any) => ({
            id: Number(r.id),
            channelId: Number(r.channelId),
            orderId: r.orderId == null ? null : Number(r.orderId),
            orderCode: r.orderCode ?? null,
            kind: r.kind,
            provider: r.provider,
            providerRef: r.providerRef ?? null,
            code: r.code ?? null,
            message: r.message ?? null,
            amountMinor: r.amountMinor == null ? null : Number(r.amountMinor),
            currency: r.currency ?? null,
            ip: r.ip ?? null,
            createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
        }));
    }

    async countPaymentEvents(kinds: PaymentEventKind[], days: number, channelId?: number | null): Promise<number> {
        if (!kinds.length) return 0;
        const ph = kinds.map(() => '?').join(',');
        const params: any[] = [...kinds, clampDays(days, 7)];
        let sql = `SELECT COUNT(*) AS n FROM ${PAYMENT_EVENT_TABLE}
                   WHERE kind IN (${ph}) AND createdAt > DATE_SUB(NOW(), INTERVAL ? DAY)`;
        if (channelId) {
            sql += ' AND channelId = ?';
            params.push(channelId);
        }
        const [row] = await this.db.query(sql, params).catch(() => [{ n: 0 }]);
        return Number(row?.n || 0);
    }

    /** Orphan events whose PaymentIntent still has no Vendure payment row. */
    async countOpenOrphans(channelId?: number | null): Promise<number> {
        const params: any[] = [];
        let sql = `SELECT COUNT(*) AS n FROM ${PAYMENT_EVENT_TABLE} e
                   WHERE e.kind = 'orphan' AND e.providerRef IS NOT NULL
                     AND NOT EXISTS (SELECT 1 FROM payment p WHERE p.transactionId = e.providerRef)`;
        if (channelId) {
            sql += ' AND e.channelId = ?';
            params.push(channelId);
        }
        const [row] = await this.db.query(sql, params).catch(() => [{ n: 0 }]);
        return Number(row?.n || 0);
    }

    /** Authorized payments for a handler code (holds pending / bank awaiting). */
    /** PaymentMethod codes (across channels) whose handler has this code. */
    async methodCodesForHandler(handlerCode: string): Promise<string[]> {
        const rows: Array<{ code: string }> = await this.db.query(
            `SELECT code FROM payment_method WHERE handler LIKE ?`, [`%"code":"${handlerCode.replace(/[%_"\\]/g, '')}"%`],
        ).catch(() => []);
        return (rows || []).map(r => r.code).filter(Boolean);
    }

    /** Authorized payments for a HANDLER (resolved to every method code using it). */
    async countAuthorizedPayments(handlerCode: string, channelId?: number | null): Promise<number> {
        const codes = await this.methodCodesForHandler(handlerCode);
        if (!codes.length) return 0;
        const params: any[] = [...codes];
        let sql = `SELECT COUNT(*) AS n FROM payment p WHERE p.state = 'Authorized' AND p.method IN (${codes.map(() => '?').join(',')})`;
        if (channelId) {
            sql += ` AND EXISTS (SELECT 1 FROM order_channels_channel oc WHERE oc.orderId = p.orderId AND oc.channelId = ?)`;
            params.push(channelId);
        }
        const [row] = await this.db.query(sql, params).catch(() => [{ n: 0 }]);
        return Number(row?.n || 0);
    }

    /** Resolve an order id (and channel) from its code; null when unknown. */
    async findOrderByCode(code: string): Promise<{ id: number; channelId: number | null; state: string } | null> {
        const c = trunc(code, 64);
        if (!c) return null;
        const rows = await this.db.query(
            `SELECT o.id, o.state,
                    (SELECT MIN(oc.channelId) FROM order_channels_channel oc WHERE oc.orderId = o.id) AS channelId
             FROM \`order\` o WHERE o.code = ? LIMIT 1`,
            [c],
        ).catch(() => []);
        if (!rows.length) return null;
        return {
            id: Number(rows[0].id),
            state: String(rows[0].state),
            channelId: rows[0].channelId == null ? null : Number(rows[0].channelId),
        };
    }

    // ── Funnel ───────────────────────────────────────────────────────

    async recordFunnelEvent(input: FunnelEventInput): Promise<void> {
        try {
            await this.db.query(
                `INSERT INTO ${FUNNEL_EVENT_TABLE} (channelId, orderCode, sessionId, step, detail, ip, createdAt)
                 VALUES (?, ?, ?, ?, ?, ?, NOW(3))`,
                [
                    Number(input.channelId) || 1,
                    trunc(input.orderCode, 64),
                    trunc(input.sessionId, 128),
                    input.step,
                    trunc(input.detail, 500),
                    trunc(input.ip, 64),
                ],
            );
        } catch (e: any) {
            Logger.error(`Could not record funnel event (${input.step}): ${e.message}`, loggerCtx);
        }
    }

    async funnelSummary(days: number | string = 7, channelId?: number | null): Promise<FunnelSummary> {
        const d = clampDays(days, 7);
        const params: any[] = [d];
        let sql = `SELECT id, step, orderCode, sessionId, ip FROM ${FUNNEL_EVENT_TABLE}
                   WHERE createdAt > DATE_SUB(NOW(), INTERVAL ? DAY)`;
        if (channelId) {
            sql += ' AND channelId = ?';
            params.push(channelId);
        }
        const rows = await this.db.query(sql, params).catch(() => []);
        return summariseFunnel(rows, d);
    }

    /** Retention: drop funnel rows older than `days` (default 90). Returns rows removed. */
    async pruneFunnel(days: number = 90): Promise<number> {
        const d = clampDays(days, 90);
        const r = await this.db.query(
            `DELETE FROM ${FUNNEL_EVENT_TABLE} WHERE createdAt < DATE_SUB(NOW(), INTERVAL ? DAY)`,
            [d], { needAffected: true },
        ).catch(() => null);
        return Number(r?.affectedRows || 0);
    }

    // ── Dashboard KPIs ───────────────────────────────────────────────

    async summary(channelId?: number | null): Promise<ObservabilitySummary> {
        const [holdsPending, bankAwaiting, failed7d, clientDeclined7d, orphansOpen, drift30d, funnel] = await Promise.all([
            this.countAuthorizedPayments('stripe-hold', channelId),
            this.countAuthorizedPayments('bank-transfer', channelId),
            this.countPaymentEvents(['failed'], 7, channelId),
            this.countPaymentEvents(['client_declined'], 7, channelId),
            this.countOpenOrphans(channelId),
            this.countPaymentEvents(['amount_drift'], 30, channelId),
            this.funnelSummary(7, channelId),
        ]);
        const first = funnel.steps.find(s => s.step === 'address' && s.unique > 0) || funnel.steps.find(s => s.unique > 0);
        const placed = funnel.steps.find(s => s.step === 'placed')?.unique || 0;
        const funnelDropOffPct = first && first.unique > 0
            ? Math.round((1 - placed / first.unique) * 1000) / 10
            : null;
        return {
            holdsPending, bankAwaiting, failed7d, clientDeclined7d, orphansOpen, drift30d,
            funnelDropOffPct, funnel, premium: hasPremium(),
        };
    }
}
