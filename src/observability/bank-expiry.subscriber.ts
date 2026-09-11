import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { EventBus, Logger } from '@vendure/core';
import { BankTransferExpiredEvent } from '../bank-transfer/bank-transfer.events';
import { ObservabilityService } from './observability.service';
import { formatMinor, OpsAlertService } from './ops-alert.service';
import { loggerCtx } from './runtime';

/**
 * Records a `bank_expired` payment event (and raises `bank.expired`)
 * whenever the bank-transfer sweep cancels an unpaid order. The sweep
 * itself is premium, so this subscriber only ever fires on licensed /
 * trial installs; the event kind is free-tier so nothing is dropped.
 */
@Injectable()
export class BankExpirySubscriber implements OnApplicationBootstrap {
    constructor(
        private eventBus: EventBus,
        private events: ObservabilityService,
        private ops: OpsAlertService,
    ) {}

    onApplicationBootstrap() {
        this.eventBus.ofType(BankTransferExpiredEvent).subscribe(event => {
            this.record(event).catch(e =>
                Logger.warn(`Could not record bank-transfer expiry for ${event.order?.code || '?'}: ${e?.message || e}`, loggerCtx));
        });
    }

    async record(event: BankTransferExpiredEvent): Promise<void> {
        const { order, payment, payBy } = event;
        const ref = payment?.transactionId || order?.code || `payment:${payment?.id}`;
        if (await this.events.hasPaymentEvent('bank_expired', ref)) return;
        const channelId = Number(order?.channels?.[0]?.id ?? event.ctx?.channelId ?? 1);
        const currency = order?.currencyCode || null;
        const amount = Number(payment?.amount) || 0;
        await this.events.recordPaymentEvent({
            channelId,
            orderId: order?.id != null ? Number(order.id) : null,
            orderCode: order?.code,
            kind: 'bank_expired',
            provider: 'bank-transfer',
            providerRef: ref,
            code: 'expired',
            message: `Bank transfer not received by ${payBy instanceof Date ? payBy.toISOString() : String(payBy)}; order cancelled`,
            amountMinor: amount,
            currency,
        });
        void this.ops.alert({
            event: 'bank.expired',
            text: `Checkout Guard: bank transfer for order ${order?.code} (${formatMinor(amount, currency)}) was not received by the pay-by date; the order has been cancelled.`,
            orderCode: order?.code,
            channelId,
            provider: 'bank-transfer',
            providerRef: ref,
            amountMinor: amount,
            currency: currency || undefined,
        });
    }
}
