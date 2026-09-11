import type { NextFunction, Request, Response } from 'express';

/**
 * Raw-body capture for the Stripe webhook route. Registered with
 * `beforeListen: true` on `/checkout-guard/stripe-webhook` so it runs
 * before Nest's global JSON parser; it sets `req.body` to the raw Buffer
 * and `req._body = true`, which makes body-parser skip the route (the
 * same effect @vendure/payments-plugin gets from `bodyParser.raw`),
 * without adding a body-parser dependency of our own.
 *
 * Only identity-encoded bodies are accepted (Stripe never compresses
 * webhook payloads); anything else is rejected with 415 before it
 * reaches the controller.
 */

export const STRIPE_WEBHOOK_ROUTE = '/checkout-guard/stripe-webhook';
const MAX_BODY_BYTES = 1_048_576; // 1 MiB — Stripe events are a few KB

export type RequestWithRawBody = Request & { rawBody?: Buffer; _body?: boolean };

export function checkoutGuardRawBodyMiddleware(req: Request, res: Response, next: NextFunction): void {
    const r = req as RequestWithRawBody;
    if (r.method !== 'POST') { next(); return; }
    if (r.rawBody && Buffer.isBuffer(r.rawBody)) { next(); return; } // already captured upstream
    const enc = String(r.headers['content-encoding'] || 'identity').toLowerCase();
    if (enc !== 'identity') {
        res.status(415).send('Unsupported content-encoding');
        return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (err?: Error) => {
        if (done) return;
        done = true;
        if (err) { next(err); return; }
        const raw = Buffer.concat(chunks);
        r.rawBody = raw;
        r.body = raw;
        r._body = true;
        next();
    };
    r.on('data', (chunk: Buffer | string) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buf.length;
        if (size > MAX_BODY_BYTES) {
            done = true;
            res.status(413).send('Payload too large');
            r.destroy();
            return;
        }
        chunks.push(buf);
    });
    r.on('end', () => finish());
    r.on('error', e => finish(e));
}

/** Entry for `config.apiOptions.middleware.push(...)`. */
export const stripeHoldRawBodyMiddlewareRegistration = {
    route: STRIPE_WEBHOOK_ROUTE,
    handler: checkoutGuardRawBodyMiddleware,
    beforeListen: true,
} as const;
