import { Order, Payment, RequestContext, VendureEvent } from '@vendure/core';

/**
 * Published (premium) by the expiry sweep after an unpaid bank transfer has
 * been cancelled — payment `Cancelled`, order `Cancelled`. Hosts subscribe to
 * send a "your order has expired" email:
 *
 * ```ts
 * eventBus.ofType(BankTransferExpiredEvent).subscribe(e => ...)
 * ```
 *
 * @docsCategory Events
 * @category Events
 */
export class BankTransferExpiredEvent extends VendureEvent {
    constructor(
        public ctx: RequestContext,
        public order: Order,
        public payment: Payment,
        /** The pay-by moment that passed. */
        public payBy: Date,
    ) {
        super();
    }
}

/**
 * Published (premium) once per payment when `reminderAfterDays` have elapsed
 * without funds arriving and the transfer has not yet expired. The plugin
 * sends nothing itself — hosts subscribe and send the reminder email with the
 * details in `payment.metadata.public`.
 *
 * @docsCategory Events
 * @category Events
 */
export class BankTransferReminderEvent extends VendureEvent {
    constructor(
        public ctx: RequestContext,
        public order: Order,
        public payment: Payment,
        /** The pay-by moment the reminder should quote. */
        public payBy: Date,
    ) {
        super();
    }
}
