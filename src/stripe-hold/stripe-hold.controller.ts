import { Controller, Get, Headers, HttpStatus, Param, Post, Query, Req, Res } from '@nestjs/common';
import { Ctx, Logger, Permission, RequestContext } from '@vendure/core';
import type { Request, Response } from 'express';
import { parseVendureMetadata, resolveWebhookSecret } from './hold-utils';
import type { RequestWithRawBody } from './raw-body.middleware';
import { effectiveStripeHoldOptions } from './runtime';
import { StripeSignatureError, verifyStripeSignature } from './stripe-signature';
import { StripeHoldService } from './stripe-hold.service';

const loggerCtx = 'CheckoutGuard:StripeHold';

function denyUnlessAdmin(ctx: RequestContext, res: Response, write: boolean): boolean {
    const needed = write ? [Permission.UpdateOrder] : [Permission.ReadOrder];
    if (!ctx.userHasPermissions(needed)) {
        res.status(403).json({ error: 'forbidden' });
        return true;
    }
    return false;
}

/**
 * `/checkout-guard/stripe-webhook` (public, signature-verified) and the
 * admin hold endpoints. The webhook route must be paired with
 * `stripeHoldRawBodyMiddlewareRegistration` in the plugin's
 * `configuration` — without the raw body every signature check fails.
 */
@Controller('checkout-guard')
export class StripeHoldController {
    constructor(private service: StripeHoldService) {}

    @Post('stripe-webhook')
    async webhook(@Headers('stripe-signature') signature: string | undefined, @Req() req: Request, @Res() res: Response) {
        const r = req as RequestWithRawBody;
        const raw: Buffer | undefined = Buffer.isBuffer(r.rawBody) ? r.rawBody : (Buffer.isBuffer(r.body) ? r.body : undefined);
        if (!raw || !raw.length) {
            Logger.error('Stripe webhook arrived without a raw body — is stripeHoldRawBodyMiddlewareRegistration registered?', loggerCtx);
            res.status(HttpStatus.BAD_REQUEST).send('Raw body unavailable');
            return;
        }
        if (!signature) {
            Logger.warn('Stripe webhook without stripe-signature header rejected', loggerCtx);
            res.status(HttpStatus.BAD_REQUEST).send('Missing stripe-signature header');
            return;
        }
        // The body is parsed once, unverified, purely to pick the channel's
        // secret; nothing is acted on until the signature has passed.
        let event: any;
        try {
            event = JSON.parse(raw.toString('utf8'));
        } catch {
            res.status(HttpStatus.BAD_REQUEST).send('Invalid JSON');
            return;
        }
        const meta = parseVendureMetadata(event?.data?.object?.metadata);
        const channel = meta ? await this.service.channelForToken(meta.channelToken) : undefined;
        const secret = resolveWebhookSecret(channel?.code, effectiveStripeHoldOptions().webhookSecret);
        if (!secret) {
            Logger.error(`No Stripe webhook secret configured${channel ? ` for channel ${channel.code}` : ''} (options.stripe.webhookSecret or env STRIPE_CG_WEBHOOK_SECRET_<CHANNELCODE>)`, loggerCtx);
            res.status(HttpStatus.BAD_REQUEST).send('Webhook secret not configured');
            return;
        }
        try {
            verifyStripeSignature(raw, signature, secret);
        } catch (e: any) {
            const reason = e instanceof StripeSignatureError ? e.reason : 'error';
            Logger.error(`Stripe webhook signature rejected (${reason})${channel ? ` for channel ${channel.code}` : ''}`, loggerCtx);
            res.status(HttpStatus.BAD_REQUEST).send('Error verifying Stripe webhook signature');
            return;
        }
        try {
            const outcome = await this.service.handleEvent(event, req);
            if (!res.headersSent) res.status(outcome.status).send(outcome.message);
        } catch (e: any) {
            // Signature passed but handling failed: 5xx so Stripe retries the
            // delivery — a transient DB error must never lose a hold.
            Logger.error(`Stripe webhook handling threw: ${e?.message || e}`, loggerCtx, e?.stack);
            if (!res.headersSent) res.status(HttpStatus.INTERNAL_SERVER_ERROR).send('Error logged — retry');
        }
    }

    // ── Admin: holds ────────────────────────────────────────────────────

    @Get('holds')
    async holds(@Ctx() ctx: RequestContext, @Res() res: Response, @Query('due') due?: string) {
        if (denyUnlessAdmin(ctx, res, false)) return;
        const includeDue = due === '1' || due === 'true' ? true : due === '0' || due === 'false' ? false : undefined;
        const items = await this.service.listHolds(ctx, { includeDue });
        const { safetyCaptureDays, autoCaptureBelowMinor, holdMethodCode } = effectiveStripeHoldOptions();
        return res.json({
            items,
            total: items.length,
            premium: this.service.premium(),
            settings: { safetyCaptureDays, autoCaptureBelowMinor: autoCaptureBelowMinor ?? null, holdMethodCode },
        });
    }

    @Post('holds/:paymentId/capture')
    async capture(@Ctx() ctx: RequestContext, @Res() res: Response, @Param('paymentId') paymentId: string) {
        if (denyUnlessAdmin(ctx, res, true)) return;
        if (!/^\d{1,18}$/.test(paymentId)) return res.status(400).json({ ok: false, error: 'bad_payment_id' });
        if (!this.service.premium()) return res.status(402).json({ error: 'premium_required' });
        const r = await this.service.capture(ctx, paymentId, 'admin');
        return res.status(r.ok ? 200 : this.statusFor(r.error)).json(r);
    }

    @Post('holds/:paymentId/cancel')
    async cancel(@Ctx() ctx: RequestContext, @Res() res: Response, @Param('paymentId') paymentId: string) {
        if (denyUnlessAdmin(ctx, res, true)) return;
        if (!/^\d{1,18}$/.test(paymentId)) return res.status(400).json({ ok: false, error: 'bad_payment_id' });
        if (!this.service.premium()) return res.status(402).json({ error: 'premium_required' });
        const r = await this.service.cancel(ctx, paymentId, 'admin');
        return res.status(r.ok ? 200 : this.statusFor(r.error)).json(r);
    }

    private statusFor(error?: string): number {
        if (error === 'payment_not_found') return 404;
        if (error === 'not_a_stripe_hold' || (error || '').startsWith('payment_is_')) return 409;
        return 502;
    }
}
