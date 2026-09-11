import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Logger, ProcessContext } from '@vendure/core';
import { StripeHoldService } from './stripe-hold.service';

const loggerCtx = 'CheckoutGuard:StripeHold';

/**
 * Hourly safety capture (worker only). A card authorisation Stripe holds
 * for a manual-capture PaymentIntent lapses after 7 days; anything still
 * Authorized after `safetyCaptureDays` (default 6) is captured so the
 * money is never silently released. No Redis needed: the query is
 * idempotent (a captured payment is no longer Authorized) and capture
 * uses a per-intent idempotency key at Stripe.
 */
@Injectable()
export class StripeHoldCron {
    private running = false;

    constructor(private service: StripeHoldService, private processContext: ProcessContext) {}

    @Cron(CronExpression.EVERY_HOUR)
    async safetyCapture() {
        if (this.processContext.isServer) return;
        if (this.running) return;
        this.running = true;
        try {
            await this.service.safetyCapture();
        } catch (e: any) {
            Logger.error(`Safety capture run failed: ${e?.message || e}`, loggerCtx, e?.stack);
        } finally {
            this.running = false;
        }
    }
}
