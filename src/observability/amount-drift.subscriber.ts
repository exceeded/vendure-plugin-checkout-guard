import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { EventBus, Logger, Order, Payment, PaymentStateTransitionEvent, TransactionalConnection } from '@vendure/core';
import { detectAmountDrift } from './amount-drift';
import { ObservabilityService } from './observability.service';
import { formatMinor, OpsAlertService } from './ops-alert.service';
import { hasPremium, loggerCtx, noteLocked } from './runtime';

const LIVE_STATES = new Set(['Settled', 'Authorized']);
/** Order states in which every payment the customer will make has been made. */
const POST_PAYMENT_ORDER_STATES = new Set(['PaymentSettled', 'PaymentAuthorized', 'PartiallyShipped', 'Shipped', 'PartiallyDelivered', 'Delivered']);

/**
 * Amount-drift guard (premium). When a payment settles for an amount
 * that differs from the order total (and the order's live payments do
 * not add up to the total either), record an `amount_drift` event and
 * raise an ops alert. Typical cause: a PaymentIntent created against the
 * cart before a coupon or line change. Never blocks the transition.
 */
@Injectable()
export class AmountDriftSubscriber implements OnApplicationBootstrap {
    constructor(
        private eventBus: EventBus,
        private connection: TransactionalConnection,
        private events: ObservabilityService,
        private ops: OpsAlertService,
    ) {}

    onApplicationBootstrap() {
        this.eventBus.ofType(PaymentStateTransitionEvent).subscribe(event => {
            if (event.toState !== 'Settled') return;
            this.check(event).catch(e =>
                Logger.warn(`Amount-drift check failed for ${event.order?.code || '?'}: ${e?.message || e}`, loggerCtx));
        });
    }

    async check(event: PaymentStateTransitionEvent): Promise<boolean> {
        if (!hasPremium()) {
            noteLocked('Amount-drift guard');
            return false;
        }
        const payment: Payment = event.payment;
        const orderId = event.order?.id ?? (payment as any)?.order?.id;
        if (!orderId) return false;
        const order = await this.connection.rawConnection.getRepository(Order)
            .findOne({ where: { id: orderId }, relations: ['payments', 'channels'] });
        if (!order) return false;
        // Multi-payment checkouts (gift card + card, ArrangingAdditionalPayment)
        // settle their first part before the second exists: only judge an
        // order that has moved on from collecting payment, so a partial
        // settlement is not reported as "underpaid".
        if (!POST_PAYMENT_ORDER_STATES.has(String(order.state))) return false;
        const others = (order.payments || [])
            .filter(p => String(p.id) !== String(payment.id) && LIVE_STATES.has(p.state))
            .map(p => Number(p.amount) || 0);
        const verdict = detectAmountDrift({
            paymentAmount: Number(payment.amount) || 0,
            orderTotalWithTax: Number(order.totalWithTax) || 0,
            otherLivePaymentAmounts: others,
        });
        if (!verdict.drift) return false;

        const ref = payment.transactionId || `payment:${payment.id}`;
        if (await this.events.hasPaymentEvent('amount_drift', ref)) return false;
        const channelId = Number(order.channels?.[0]?.id ?? event.ctx?.channelId ?? 1);
        const currency = order.currencyCode || (payment as any)?.currencyCode || null;
        const message = `Settled ${formatMinor(verdict.paidMinor, currency)} against an order total of `
            + `${formatMinor(Number(order.totalWithTax) || 0, currency)} (delta ${verdict.deltaMinor > 0 ? '+' : ''}${formatMinor(verdict.deltaMinor, currency)})`;
        await this.events.recordPaymentEvent({
            channelId,
            orderId: Number(order.id),
            orderCode: order.code,
            kind: 'amount_drift',
            provider: payment.method || 'unknown',
            providerRef: ref,
            code: verdict.deltaMinor < 0 ? 'underpaid' : 'overpaid',
            message,
            amountMinor: verdict.paidMinor,
            currency,
        });
        Logger.warn(`Amount drift on ${order.code}: ${message}`, loggerCtx);
        void this.ops.alert({
            event: 'payment.amount_drift',
            text: `Checkout Guard: amount drift on order ${order.code} — ${message}. `
                + (verdict.deltaMinor < 0
                    ? 'The customer paid less than the order total; review before fulfilling.'
                    : 'The customer paid more than the order total; consider a partial refund.'),
            orderCode: order.code,
            channelId,
            provider: payment.method,
            providerRef: ref,
            amountMinor: verdict.paidMinor,
            currency: currency || undefined,
        });
        return true;
    }
}
