import { adapterFor } from '@huloglobal/vendure-licence-sdk';
import { Injectable, OnModuleInit } from '@nestjs/common';
import {
    Channel,
    EventBus,
    ID,
    Logger,
    Order,
    OrderService,
    Payment,
    RequestContext,
    RequestContextService,
    TransactionalConnection,
    isGraphQlErrorResult,
} from '@vendure/core';

import { BANK_TRANSFER_HANDLER_CODE, parsePayBy, readBankTransferPublicDetails } from './bank-details';
import { getBankTransferRuntime } from './bank-transfer-runtime';
import { BankTransferExpiredEvent, BankTransferReminderEvent } from './bank-transfer.events';
import { classifyBankTransfer, daysUntil } from './expiry-policy';

const loggerCtx = 'CheckoutGuard';

export type BankTransferListStatus = 'awaiting' | 'expired' | 'settled' | 'cancelled' | 'all';

/** One row of the admin listing. */
export interface BankTransferRow {
    paymentId: ID;
    orderId: ID;
    orderCode: string;
    channelId: ID;
    channelCode: string | null;
    customerEmail: string | null;
    amountMinor: number;
    currency: string;
    paymentState: string;
    orderState: string;
    createdAt: string;
    /** ISO pay-by moment (from the payment's public metadata, else createdAt + expiryDays). */
    payBy: string;
    /** Whole days until payBy (negative when past). */
    daysLeft: number;
    reminderSentAt: string | null;
    expiredAt: string | null;
    settledAt: string | null;
    cancelledAt: string | null;
    accountName: string | null;
}

export interface BankTransferSweepResult {
    scanned: number;
    expired: number;
    reminded: number;
    /** Orders whose bank payment was already cancelled but the order was not (a
     *  failed cancelOrder on an earlier pass) and were cancelled on this pass. */
    repaired: number;
    skipped: 'locked' | null;
}

export interface BankTransferActionResult {
    ok: boolean;
    error?: string;
    paymentState?: string;
    orderState?: string;
}

interface CandidateRow {
    paymentId: ID;
    orderId: ID;
    orderCode: string;
    channelId: ID;
    paymentCreatedAt: string | Date;
    amount: number;
    metadata: unknown;
    reminderSentAt: string | Date | null;
}

/**
 * @docsCategory Services
 * @category Services
 */
@Injectable()
export class BankTransferService implements OnModuleInit {
    private lockedLogged = false;

    constructor(
        private connection: TransactionalConnection,
        private orderService: OrderService,
        private requestContextService: RequestContextService,
        private eventBus: EventBus,
    ) {}

    private get db() {
        return adapterFor(this.connection.rawConnection);
    }

    async onModuleInit() {
        try {
            await this.ensureSchema();
        } catch (e: any) {
            Logger.error(`bank-transfer schema init failed: ${e.message}`, loggerCtx);
        }
    }

    // ── Schema ──────────────────────────────────────────────────────────
    /**
     * Tracking rows keyed by payment id. The payment/order tables stay the
     * source of truth for state; this table only remembers what the sweep
     * has already done (reminder sent, expired) and when an admin acted.
     * Created with plain DDL through the dialect adapter — the host runs with
     * plugin migrations off, so no TypeORM entity.
     */
    async ensureSchema(): Promise<void> {
        await this.db.query(`
            CREATE TABLE IF NOT EXISTS checkout_guard_bank_transfer (
                paymentId BIGINT PRIMARY KEY,
                orderId BIGINT NOT NULL,
                orderCode VARCHAR(64) NOT NULL,
                channelId INT NOT NULL,
                amountMinor BIGINT NOT NULL DEFAULT 0,
                currency VARCHAR(8) NULL,
                payBy DATETIME NULL,
                reminderSentAt DATETIME NULL,
                expiredAt DATETIME NULL,
                settledAt DATETIME NULL,
                cancelledAt DATETIME NULL,
                createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_cg_bt_order (orderId),
                INDEX idx_cg_bt_channel (channelId)
            )`);
    }

    // ── Method codes ────────────────────────────────────────────────────
    /**
     * `payment.method` stores the PaymentMethod *code*, which a host may name
     * differently from the handler code (ELITE's row is `bank-transfer`, but a
     * second channel could be `bacs`). Resolve every enabled-or-not method
     * whose handler is ours.
     */
    async bankTransferMethodCodes(): Promise<string[]> {
        const rows: Array<{ code: string; handler: unknown }> = await this.db.query(
            `SELECT code, handler FROM payment_method`,
        );
        const codes: string[] = [];
        for (const row of rows ?? []) {
            let handler: any = row.handler;
            if (typeof handler === 'string') {
                try { handler = JSON.parse(handler); } catch { handler = null; }
            }
            if (handler && handler.code === BANK_TRANSFER_HANDLER_CODE && row.code) codes.push(String(row.code));
        }
        // The handler code itself is a sensible fallback so a fresh install
        // still sweeps if the method row is created with the same code.
        if (!codes.includes(BANK_TRANSFER_HANDLER_CODE)) codes.push(BANK_TRANSFER_HANDLER_CODE);
        return codes;
    }

    private placeholders(n: number): string {
        return Array.from({ length: n }, () => '?').join(', ');
    }

    // ── Listing (admin) ─────────────────────────────────────────────────
    async list(status: BankTransferListStatus = 'awaiting', days = 90, limit = 200): Promise<BankTransferRow[]> {
        const codes = await this.bankTransferMethodCodes();
        const runtime = getBankTransferRuntime();
        const where: string[] = [`p.method IN (${this.placeholders(codes.length)})`];
        const params: any[] = [...codes];
        switch (status) {
            case 'awaiting':
                where.push(`p.state = 'Authorized'`);
                break;
            case 'settled':
                where.push(`p.state = 'Settled'`);
                break;
            case 'expired':
                where.push(`p.state = 'Cancelled'`, `t.expiredAt IS NOT NULL`);
                break;
            case 'cancelled':
                where.push(`p.state = 'Cancelled'`);
                break;
            case 'all':
            default:
                break;
        }
        const safeDays = Math.max(1, Math.min(3650, Math.floor(Number(days) || 90)));
        where.push(`p.createdAt >= DATE_SUB(NOW(), INTERVAL ? DAY)`);
        params.push(safeDays);
        const safeLimit = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 200)));

        const rows: any[] = await this.db.query(
            `SELECT p.id AS paymentId, p.state AS paymentState, p.amount AS amountMinor, p.createdAt AS createdAt,
                    p.updatedAt AS paymentUpdatedAt, p.metadata AS metadata,
                    o.id AS orderId, o.code AS orderCode, o.state AS orderState, o.currencyCode AS currency,
                    c.emailAddress AS customerEmail,
                    ch.id AS channelId, ch.code AS channelCode,
                    t.reminderSentAt AS reminderSentAt, t.expiredAt AS expiredAt, t.settledAt AS settledAt,
                    t.cancelledAt AS cancelledAt, t.payBy AS trackedPayBy
             FROM payment p
             JOIN \`order\` o ON o.id = p.orderId
             LEFT JOIN customer c ON c.id = o.customerId
             LEFT JOIN order_channels_channel occ ON occ.orderId = o.id
             LEFT JOIN channel ch ON ch.id = occ.channelId
             LEFT JOIN checkout_guard_bank_transfer t ON t.paymentId = p.id
             WHERE ${where.join(' AND ')}
             ORDER BY p.createdAt DESC
             LIMIT ${safeLimit * 4}`,
            params,
        );
        // An order belongs to its own channel AND the default channel, so the
        // join yields one row per channel. Keep the non-default one.
        const byPayment = new Map<string, any>();
        for (const r of rows ?? []) {
            const key = String(r.paymentId);
            const existing = byPayment.get(key);
            if (!existing || (String(existing.channelId) === '1' && String(r.channelId) !== '1')) byPayment.set(key, r);
        }
        const now = new Date();
        const out: BankTransferRow[] = [];
        for (const r of byPayment.values()) {
            const details = readBankTransferPublicDetails(r.metadata);
            const createdAt = new Date(r.createdAt);
            const payByDate = parsePayBy(details)
                ?? (r.trackedPayBy ? new Date(r.trackedPayBy) : null)
                ?? new Date(createdAt.getTime() + runtime.expiryDays * 86_400_000);
            out.push({
                paymentId: r.paymentId,
                orderId: r.orderId,
                orderCode: r.orderCode,
                channelId: r.channelId,
                channelCode: r.channelCode ?? null,
                customerEmail: r.customerEmail ?? null,
                amountMinor: Number(r.amountMinor) || 0,
                currency: details?.currency || r.currency,
                paymentState: r.paymentState,
                orderState: r.orderState,
                createdAt: createdAt.toISOString(),
                payBy: payByDate.toISOString(),
                daysLeft: daysUntil(payByDate, now),
                reminderSentAt: toIso(r.reminderSentAt),
                expiredAt: toIso(r.expiredAt),
                settledAt: toIso(r.settledAt) ?? (r.paymentState === 'Settled' ? toIso(r.paymentUpdatedAt) : null),
                cancelledAt: toIso(r.cancelledAt) ?? (r.paymentState === 'Cancelled' ? toIso(r.paymentUpdatedAt) : null),
                accountName: details?.accountName ?? null,
            });
            if (out.length >= safeLimit) break;
        }
        return out;
    }

    /** KPI helper for the dashboard summary: bank transfers still awaiting funds. */
    async countAwaiting(): Promise<number> {
        const codes = await this.bankTransferMethodCodes();
        const [row] = await this.db.query(
            `SELECT COUNT(*) AS n FROM payment p WHERE p.state = 'Authorized' AND p.method IN (${this.placeholders(codes.length)})`,
            codes,
        );
        return Number(row?.n || 0);
    }

    // ── Admin actions ───────────────────────────────────────────────────
    /** Funds arrived: settle the payment, which moves the order to PaymentSettled. */
    async markReceived(paymentId: ID): Promise<BankTransferActionResult> {
        const payment = await this.loadBankTransferPayment(paymentId);
        if (!payment) return { ok: false, error: 'not_a_bank_transfer_payment' };
        if (payment.state !== 'Authorized') {
            return { ok: false, error: `payment_not_authorized:${payment.state}`, paymentState: payment.state, orderState: payment.order.state };
        }
        const ctx = await this.contextForOrder(payment.order);
        const result = await this.orderService.settlePayment(ctx, payment.id);
        if (isGraphQlErrorResult(result)) {
            return { ok: false, error: result.message, paymentState: payment.state, orderState: payment.order.state };
        }
        await this.ensureTracked(payment, ctx.channelId);
        await this.db.query(`UPDATE checkout_guard_bank_transfer SET settledAt = NOW() WHERE paymentId = ?`, [payment.id]);
        const order = await this.orderService.findOne(ctx, payment.order.id);
        Logger.info(`Bank transfer received for order ${payment.order.code} (payment ${payment.id})`, loggerCtx);
        return { ok: true, paymentState: result.state, orderState: order?.state ?? payment.order.state };
    }

    /** Admin cancel: cancel the payment and the order (no expiry event). */
    async cancelByAdmin(paymentId: ID, reason?: string): Promise<BankTransferActionResult> {
        const payment = await this.loadBankTransferPayment(paymentId);
        if (!payment) return { ok: false, error: 'not_a_bank_transfer_payment' };
        if (payment.state !== 'Authorized') {
            return { ok: false, error: `payment_not_authorized:${payment.state}`, paymentState: payment.state, orderState: payment.order.state };
        }
        const ctx = await this.contextForOrder(payment.order);
        const outcome = await this.cancelPaymentAndOrder(ctx, payment, reason || 'Bank transfer cancelled by administrator');
        if (!outcome.ok) return outcome;
        await this.ensureTracked(payment, ctx.channelId);
        await this.db.query(`UPDATE checkout_guard_bank_transfer SET cancelledAt = NOW() WHERE paymentId = ?`, [payment.id]);
        Logger.info(`Bank transfer cancelled by admin for order ${payment.order.code} (payment ${payment.id})`, loggerCtx);
        return outcome;
    }

    // ── Sweep (cron, premium) ───────────────────────────────────────────
    /**
     * Expire unpaid transfers past their pay-by date and publish one reminder
     * per payment after `reminderAfterDays`. Premium only: when locked the
     * sweep logs once and does nothing — the handler and checker keep working
     * on the free tier, orders just wait for a human.
     */
    async sweep(now: Date = new Date()): Promise<BankTransferSweepResult> {
        const runtime = getBankTransferRuntime();
        if (!runtime.hasPremiumAccess()) {
            if (!this.lockedLogged) {
                this.lockedLogged = true;
                Logger.warn(
                    'Bank-transfer auto-expiry and reminders are a premium feature — unpaid transfers will not be expired automatically. Activate a licence to enable them.',
                    loggerCtx,
                );
            }
            return { scanned: 0, expired: 0, reminded: 0, repaired: 0, skipped: 'locked' };
        }
        this.lockedLogged = false;

        const candidates = await this.findAwaitingCandidates();
        const result: BankTransferSweepResult = { scanned: candidates.length, expired: 0, reminded: 0, repaired: 0, skipped: null };
        for (const c of candidates) {
            try {
                const details = readBankTransferPublicDetails(c.metadata);
                const decision = classifyBankTransfer({
                    now,
                    createdAt: new Date(c.paymentCreatedAt),
                    payBy: parsePayBy(details),
                    reminderSentAt: c.reminderSentAt ? new Date(c.reminderSentAt) : null,
                    expiryDays: runtime.expiryDays,
                    reminderAfterDays: runtime.reminderAfterDays,
                });
                if (!decision.expire && !decision.remind) continue;

                const payment = await this.loadBankTransferPayment(c.paymentId);
                if (!payment || payment.state !== 'Authorized' || payment.order.state !== 'PaymentAuthorized') continue;
                const ctx = await this.contextForOrder(payment.order);
                await this.ensureTracked(payment, ctx.channelId, decision.expiresAt);

                if (decision.expire) {
                    const outcome = await this.cancelPaymentAndOrder(
                        ctx, payment, `Bank transfer not received by ${decision.expiresAt.toISOString().slice(0, 10)}`,
                    );
                    if (!outcome.ok) {
                        Logger.warn(`Could not expire bank transfer for order ${payment.order.code}: ${outcome.error}`, loggerCtx);
                        continue;
                    }
                    await this.db.query(
                        `UPDATE checkout_guard_bank_transfer SET expiredAt = NOW(), cancelledAt = NOW() WHERE paymentId = ?`,
                        [payment.id],
                    );
                    const order = (await this.orderService.findOne(ctx, payment.order.id)) ?? payment.order;
                    await this.eventBus.publish(new BankTransferExpiredEvent(ctx, order, payment, decision.expiresAt));
                    result.expired++;
                    Logger.info(`Expired unpaid bank transfer for order ${payment.order.code} (payment ${payment.id})`, loggerCtx);
                } else if (decision.remind) {
                    await this.db.query(
                        `UPDATE checkout_guard_bank_transfer SET reminderSentAt = NOW() WHERE paymentId = ? AND reminderSentAt IS NULL`,
                        [payment.id],
                    );
                    await this.eventBus.publish(new BankTransferReminderEvent(ctx, payment.order, payment, decision.expiresAt));
                    result.reminded++;
                    Logger.info(`Bank transfer reminder due for order ${payment.order.code} (payment ${payment.id})`, loggerCtx);
                }
            } catch (e: any) {
                Logger.error(`Bank transfer sweep failed for payment ${c.paymentId}: ${e.message}`, loggerCtx);
            }
        }
        result.repaired = await this.repairStranded();
        return result;
    }

    /**
     * A previous pass cancelled the payment but `cancelOrder` failed (the two
     * steps are separate Vendure operations): the order sits in
     * PaymentAuthorized with only Cancelled bank payments and nothing else
     * would ever touch it. Finish the cancellation.
     */
    private async repairStranded(): Promise<number> {
        const codes = await this.bankTransferMethodCodes();
        if (!codes.length) return 0;
        const ph = this.placeholders(codes.length);
        const rows: Array<{ orderId: ID; orderCode: string }> = await this.db.query(
            `SELECT o.id AS orderId, o.code AS orderCode
             FROM \`order\` o
             WHERE o.state = 'PaymentAuthorized'
               AND EXISTS (SELECT 1 FROM payment p WHERE p.orderId = o.id AND p.method IN (${ph}) AND p.state = 'Cancelled')
               AND NOT EXISTS (SELECT 1 FROM payment p2 WHERE p2.orderId = o.id AND p2.state IN ('Authorized', 'Settled'))
             LIMIT 100`,
            codes,
        ).catch(() => []);
        let repaired = 0;
        for (const r of rows ?? []) {
            try {
                const order = await this.connection.rawConnection.getRepository(Order).findOne({ where: { id: r.orderId as any }, relations: ['channels'] });
                if (!order) continue;
                const ctx = await this.contextForOrder(order);
                const res = await this.orderService.cancelOrder(ctx, { orderId: order.id, reason: 'Bank transfer not received (order left open by an earlier failed cancellation)' });
                if (isGraphQlErrorResult(res)) {
                    Logger.warn(`Could not finish cancelling stranded order ${r.orderCode}: ${res.message}`, loggerCtx);
                    continue;
                }
                await this.db.query(`UPDATE checkout_guard_bank_transfer SET cancelledAt = COALESCE(cancelledAt, NOW()) WHERE orderId = ?`, [order.id]);
                repaired++;
                Logger.info(`Finished cancelling stranded bank-transfer order ${r.orderCode}`, loggerCtx);
            } catch (e: any) {
                Logger.error(`Stranded-order repair failed for ${r.orderCode}: ${e.message}`, loggerCtx);
            }
        }
        return repaired;
    }

    /**
     * Orders in PaymentAuthorized whose payments are bank-transfer Authorized
     * and nothing else live (no other Authorized/Settled payment from another
     * method — a split-tender order is never expired by this sweep).
     */
    private async findAwaitingCandidates(): Promise<CandidateRow[]> {
        const codes = await this.bankTransferMethodCodes();
        const ph = this.placeholders(codes.length);
        const rows: any[] = await this.db.query(
            `SELECT p.id AS paymentId, p.createdAt AS paymentCreatedAt, p.amount AS amount, p.metadata AS metadata,
                    o.id AS orderId, o.code AS orderCode,
                    MIN(occ.channelId) AS channelId,
                    t.reminderSentAt AS reminderSentAt
             FROM payment p
             JOIN \`order\` o ON o.id = p.orderId
             JOIN order_channels_channel occ ON occ.orderId = o.id
             LEFT JOIN checkout_guard_bank_transfer t ON t.paymentId = p.id
             WHERE o.state = 'PaymentAuthorized'
               AND p.state = 'Authorized'
               AND p.method IN (${ph})
               AND NOT EXISTS (
                   SELECT 1 FROM payment p2
                   WHERE p2.orderId = o.id AND p2.id <> p.id
                     AND p2.state IN ('Authorized', 'Settled')
                     AND p2.method NOT IN (${ph})
               )
             GROUP BY p.id, p.createdAt, p.amount, p.metadata, o.id, o.code, t.reminderSentAt
             ORDER BY p.createdAt ASC
             LIMIT 500`,
            [...codes, ...codes],
        );
        return rows ?? [];
    }

    // ── Internals ───────────────────────────────────────────────────────
    private async loadBankTransferPayment(paymentId: ID): Promise<Payment | null> {
        const payment = await this.connection.rawConnection.getRepository(Payment).findOne({
            where: { id: paymentId as any },
            relations: ['order', 'order.channels'],
        });
        if (!payment) return null;
        const codes = await this.bankTransferMethodCodes();
        if (!codes.includes(payment.method)) return null;
        return payment;
    }

    /**
     * An admin-API context for the order's own channel. Payments are not
     * channel-aware, so OrderService checks the order is visible in the
     * context's channel — the request's channel may not be the order's.
     */
    private async contextForOrder(order: Order): Promise<RequestContext> {
        let channel: Channel | undefined = order.channels?.find(ch => String(ch.id) !== '1') ?? order.channels?.[0];
        if (!channel) {
            const rows: Array<{ channelId: ID }> = await this.db.query(
                `SELECT channelId FROM order_channels_channel WHERE orderId = ? ORDER BY channelId DESC`, [order.id],
            );
            const id = rows?.[0]?.channelId;
            channel = id
                ? (await this.connection.rawConnection.getRepository(Channel).findOne({ where: { id: id as any } })) ?? undefined
                : undefined;
        }
        // Pass the TOKEN, not the entity: a Channel loaded through the order
        // relation carries no defaultTaxZone, and every order operation
        // (cancel, settle) recalculates prices → "error.no-active-tax-zone".
        // RequestContextService resolves a token to the fully-loaded channel.
        return this.requestContextService.create({
            apiType: 'admin',
            channelOrToken: channel?.token,
        });
    }

    private async cancelPaymentAndOrder(ctx: RequestContext, payment: Payment, reason: string): Promise<BankTransferActionResult> {
        const cancelPayment = await this.orderService.cancelPayment(ctx, payment.id);
        if (isGraphQlErrorResult(cancelPayment)) {
            return { ok: false, error: `cancel_payment_failed: ${cancelPayment.message}`, paymentState: payment.state, orderState: payment.order.state };
        }
        const cancelOrder = await this.orderService.cancelOrder(ctx, { orderId: payment.order.id, reason });
        if (isGraphQlErrorResult(cancelOrder)) {
            return { ok: false, error: `cancel_order_failed: ${cancelOrder.message}`, paymentState: cancelPayment.state, orderState: payment.order.state };
        }
        return { ok: true, paymentState: cancelPayment.state, orderState: cancelOrder.state };
    }

    private async ensureTracked(payment: Payment, channelId: ID, expiresAt?: Date): Promise<void> {
        const existing = await this.db.query(`SELECT paymentId FROM checkout_guard_bank_transfer WHERE paymentId = ?`, [payment.id]);
        if (existing?.length) return;
        const details = readBankTransferPublicDetails(payment.metadata);
        const payBy = expiresAt ?? parsePayBy(details)
            ?? new Date(new Date(payment.createdAt).getTime() + getBankTransferRuntime().expiryDays * 86_400_000);
        await this.db.query(
            `INSERT INTO checkout_guard_bank_transfer (paymentId, orderId, orderCode, channelId, amountMinor, currency, payBy)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [payment.id, payment.order.id, payment.order.code, channelId, payment.amount, details?.currency ?? payment.order.currencyCode ?? null, toSqlDateTime(payBy)],
        );
    }
}

function toIso(value: string | Date | null | undefined): string | null {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** `YYYY-MM-DD HH:MM:SS` in UTC — accepted by both MariaDB DATETIME and Postgres TIMESTAMP. */
function toSqlDateTime(d: Date): string {
    return d.toISOString().slice(0, 19).replace('T', ' ');
}
