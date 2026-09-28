import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Channel, Logger, PaymentMethod, ProcessContext, TransactionalConnection } from '@vendure/core';
import { adapterFor } from '@huloglobal/vendure-licence-sdk';
import { withDbLock } from '../db-lock';
import { ObservabilityService } from './observability.service';
import { STATE_TABLE } from './schema';
import { formatMinor, OpsAlertService } from './ops-alert.service';
import { findOrphanIntents, listStripePaymentIntents } from './reconciliation';
import { hasPremium, loggerCtx, noteLocked, runtimeOptions } from './runtime';
import { OrphanCandidate } from './types';

export interface ReconciliationRunResult {
    ran: boolean;
    reason?: string;
    accounts: number;
    intentsScanned: number;
    orphansFound: number;
    orphansNew: number;
    incomplete: boolean;
    startedAt: string;
    finishedAt: string;
}

export interface ReconciliationStatus {
    enabled: boolean;
    premium: boolean;
    lookbackDays: number;
    schedule: string;
    lastRun: ReconciliationRunResult | null;
}

interface StripeAccount {
    apiKey: string;
    channelIds: number[];
    channelTokens: Map<string, number>;
    methodCodes: string[];
}

const SCHEDULE = '10 4 * * *';
const DEFAULT_LOOKBACK_DAYS = 3;
const MAX_LOOKBACK_DAYS = 30;

/**
 * Daily Stripe reconciliation (premium, worker process, 04:10).
 *
 * For every Stripe account configured on a channel's `stripe` payment
 * method, lists PaymentIntents created in the lookback window whose
 * status is `succeeded` or `requires_capture`, and compares them with
 * `payment.transactionId`. Money Stripe holds that Vendure has no
 * payment row for (the webhook failed: ORDER_PAYMENT_STATE_ERROR, a
 * transition error, an outage) becomes an `orphan` payment event and one
 * ops alert per run. Rows are de-duplicated by PaymentIntent id, so a
 * still-orphaned intent is reported once, not daily.
 *
 * @docsCategory Services
 * @category Services
 */
@Injectable()
export class ReconciliationService {
    private lastRun: ReconciliationRunResult | null = null;
    private running = false;

    constructor(
        private connection: TransactionalConnection,
        private processContext: ProcessContext,
        private events: ObservabilityService,
        private ops: OpsAlertService,
    ) {}

    lookbackDays(): number {
        const n = Math.floor(Number(runtimeOptions().reconciliation?.lookbackDays));
        if (!Number.isFinite(n) || n < 1) return DEFAULT_LOOKBACK_DAYS;
        return Math.min(MAX_LOOKBACK_DAYS, n);
    }

    /** Status incl. the last run from ANY process (the cron runs on the worker, the dashboard on the server). */
    async status(): Promise<ReconciliationStatus> {
        let lastRun = this.lastRun;
        try {
            const rows: Array<{ v: string }> = await adapterFor(this.connection.rawConnection)
                .query(`SELECT v FROM ${STATE_TABLE} WHERE k = ?`, ['reconcile:last']);
            if (rows?.[0]?.v) {
                const stored = JSON.parse(rows[0].v) as ReconciliationRunResult;
                if (!lastRun || String(stored.startedAt) > String(lastRun.startedAt)) lastRun = stored;
            }
        } catch { /* table missing on first boot */ }
        return {
            enabled: runtimeOptions().reconciliation?.enabled !== false,
            premium: hasPremium(),
            lookbackDays: this.lookbackDays(),
            schedule: SCHEDULE,
            lastRun,
        };
    }

    private async persistLastRun(result: ReconciliationRunResult): Promise<void> {
        this.lastRun = result;
        try {
            const db = adapterFor(this.connection.rawConnection);
            await db.query(
                `INSERT INTO ${STATE_TABLE} (k, v, updatedAt) VALUES (?, ?, NOW(3)) ON DUPLICATE KEY UPDATE v = VALUES(v), updatedAt = NOW(3)`,
                ['reconcile:last', JSON.stringify(result)], { conflictColumns: ['k'] } as any,
            );
        } catch (e: any) {
            Logger.debug(`Could not persist reconciliation result: ${e?.message || e}`, loggerCtx);
        }
    }

    @Cron(SCHEDULE)
    async daily() {
        if (this.processContext.isServer) return; // worker only
        await this.runOnce();
    }

    /** Retention: funnel beacons after 90 days, short-lived payment events after 180, the rest after 400. Worker only. */
    @Cron('20 3 * * *')
    async prune() {
        if (this.processContext.isServer) return;
        try {
            const locked = await withDbLock(this.connection.rawConnection, 'prune', async () => {
                const funnel = await this.events.pruneFunnel(90);
                const events = await this.events.prunePaymentEvents(180, 400);
                return { funnel, events };
            });
            if (locked.acquired && locked.result && (locked.result.funnel || locked.result.events)) {
                Logger.info(`Checkout Guard retention: removed ${locked.result.funnel} funnel row(s), ${locked.result.events} payment event(s)`, loggerCtx);
            }
        } catch (e: any) {
            Logger.warn(`Checkout Guard retention failed: ${e?.message || e}`, loggerCtx);
        }
    }

    /**
     * One reconciliation pass. `force` bypasses the `reconciliation.enabled`
     * option (the admin "run now" button) but never the premium gate.
     */
    async runOnce(opts: { force?: boolean } = {}): Promise<ReconciliationRunResult> {
        const startedAt = new Date().toISOString();
        const skip = (reason: string): ReconciliationRunResult => ({
            ran: false, reason, accounts: 0, intentsScanned: 0, orphansFound: 0, orphansNew: 0,
            incomplete: false, startedAt, finishedAt: new Date().toISOString(),
        });
        if (!hasPremium()) {
            noteLocked('Stripe reconciliation');
            return skip('premium_locked');
        }
        if (!opts.force && runtimeOptions().reconciliation?.enabled === false) return skip('disabled');
        if (this.running) return skip('already_running');
        this.running = true;
        try {
            // Cross-process: the admin "Run now" (server) and the 04:10 cron (worker).
            const locked = await withDbLock(this.connection.rawConnection, 'reconcile', () => this.reconcile(startedAt));
            if (!locked.acquired) return skip('already_running');
            const result = locked.result!;
            await this.persistLastRun(result);
            return result;
        } catch (e: any) {
            Logger.error(`Stripe reconciliation failed: ${e?.message || e}`, loggerCtx);
            const failed = { ...skip('error'), ran: true, incomplete: true };
            await this.persistLastRun(failed);
            return failed;
        } finally {
            this.running = false;
        }
    }

    private async reconcile(startedAt: string): Promise<ReconciliationRunResult> {
        const accounts = await this.stripeAccounts();
        const lookback = this.lookbackDays();
        const result: ReconciliationRunResult = {
            ran: true, accounts: accounts.length, intentsScanned: 0, orphansFound: 0, orphansNew: 0,
            incomplete: false, startedAt, finishedAt: startedAt,
        };
        if (!accounts.length) {
            Logger.verbose('Stripe reconciliation: no channel has a Stripe payment method with an apiKey', loggerCtx);
            result.finishedAt = new Date().toISOString();
            return result;
        }

        const known = await this.knownTransactionIds(lookback + 2);
        const createdGte = Math.floor(Date.now() / 1000) - lookback * 86_400;
        const newOrphans: Array<OrphanCandidate & { channelId: number }> = [];

        for (const account of accounts) {
            const { intents, incomplete } = await listStripePaymentIntents(account.apiKey, createdGte, {
                log: msg => Logger.warn(`Stripe reconciliation (channels ${account.channelIds.join(',')}): ${msg}`, loggerCtx),
            });
            result.intentsScanned += intents.length;
            if (incomplete) result.incomplete = true;
            const orphans = findOrphanIntents(intents, known);
            result.orphansFound += orphans.length;
            const already = await this.events.existingPaymentEventRefs('orphan', orphans.map(o => o.paymentIntentId));
            for (const o of orphans) {
                if (already.has(o.paymentIntentId)) continue;
                const channelId = (o.channelToken && account.channelTokens.get(o.channelToken)) || account.channelIds[0];
                const orderId = o.orderId && /^\d+$/.test(o.orderId) ? Number(o.orderId) : null;
                const id = await this.events.recordPaymentEvent({
                    channelId,
                    orderId,
                    orderCode: o.orderCode,
                    kind: 'orphan',
                    provider: 'stripe',
                    providerRef: o.paymentIntentId,
                    code: o.status,
                    message: `PaymentIntent ${o.status} on Stripe with no Vendure payment (created ${o.createdAt.toISOString()})`,
                    amountMinor: o.amountMinor,
                    currency: o.currency,
                });
                if (id) newOrphans.push({ ...o, channelId });
            }
        }

        result.orphansNew = newOrphans.length;
        result.finishedAt = new Date().toISOString();
        Logger.info(
            `Stripe reconciliation: ${result.intentsScanned} intent(s) across ${accounts.length} account(s), `
            + `${result.orphansFound} orphan(s) (${result.orphansNew} new)${result.incomplete ? ' — listing incomplete' : ''}`,
            loggerCtx,
        );

        if (newOrphans.length) {
            const lines = newOrphans.slice(0, 10).map(o =>
                `• ${o.paymentIntentId} ${formatMinor(o.amountMinor, o.currency)} ${o.status}`
                + (o.orderCode ? ` — order ${o.orderCode}` : ''));
            const more = newOrphans.length > 10 ? `\n…and ${newOrphans.length - 10} more` : '';
            await this.ops.alert({
                event: 'reconciliation.summary',
                text: `Checkout Guard: ${newOrphans.length} Stripe payment(s) with no Vendure payment row (last ${lookback} day(s)).\n`
                    + `${lines.join('\n')}${more}\nReview in Admin → Checkout Guard → Payment events (kind: orphan).`,
                provider: 'stripe',
                detail: { orphans: newOrphans.map(o => ({ paymentIntentId: o.paymentIntentId, amountMinor: o.amountMinor, currency: o.currency, orderCode: o.orderCode, channelId: o.channelId })) },
            });
        }
        return result;
    }

    /** Stripe accounts in use, grouped by secret key so a shared account is listed once. */
    private async stripeAccounts(): Promise<StripeAccount[]> {
        const methods = await this.connection.rawConnection.getRepository(PaymentMethod)
            .find({ relations: ['channels'] })
            .catch(() => [] as PaymentMethod[]);
        const byKey = new Map<string, StripeAccount>();
        for (const m of methods) {
            if (!m.enabled || m.handler?.code !== 'stripe') continue;
            const apiKey = m.handler.args?.find(a => a.name === 'apiKey')?.value;
            if (!apiKey || !/^(sk|rk)_/.test(String(apiKey))) continue;
            const key = String(apiKey);
            let acc = byKey.get(key);
            if (!acc) {
                acc = { apiKey: key, channelIds: [], channelTokens: new Map(), methodCodes: [] };
                byKey.set(key, acc);
            }
            acc.methodCodes.push(m.code);
            for (const ch of (m.channels || []) as Channel[]) {
                const id = Number(ch.id);
                if (!acc.channelIds.includes(id)) acc.channelIds.push(id);
                if (ch.token) acc.channelTokens.set(ch.token, id);
            }
            if (!acc.channelIds.length) acc.channelIds.push(1);
        }
        return [...byKey.values()];
    }

    /** `payment.transactionId` values that look like PaymentIntents, recent enough to overlap the window. */
    private async knownTransactionIds(days: number): Promise<Set<string>> {
        const db = adapterFor(this.connection.rawConnection);
        // One pass over the window: the transaction id, and (for holds created
        // through the webhook) the intent carried in metadata. Backticks keep
        // Vendure's camelCase columns intact on Postgres.
        const rows: Array<{ transactionId: string | null; metadata: any }> = await db.query(
            `SELECT \`transactionId\`, metadata FROM payment WHERE \`createdAt\` > DATE_SUB(NOW(), INTERVAL ? DAY)`,
            [Math.max(1, Math.floor(days))],
        ).catch(() => []);
        const set = new Set<string>();
        for (const r of rows) {
            if (r.transactionId && String(r.transactionId).startsWith('pi_')) { set.add(String(r.transactionId)); continue; }
            try {
                const m = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata;
                const pi = m?.paymentIntentId || m?.public?.paymentIntentId;
                if (typeof pi === 'string' && pi.startsWith('pi_')) set.add(pi);
            } catch { /* not JSON */ }
        }
        return set;
    }
}
