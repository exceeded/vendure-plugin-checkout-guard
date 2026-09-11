import { timingSafeEqual } from 'crypto';
import { isIP } from 'net';
import type { IncomingHttpHeaders } from 'http';
import type { Middleware } from '@vendure/core';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export interface TrustedClientIpOptions {
    /** Honour `cf-connecting-ip` (default true). Set false when the API is reachable without Cloudflare. */
    trustCloudflareHeader?: boolean;
    /** Header carrying the real client IP, set by the storefront's server-side proxy. Default `x-real-client-ip`. */
    header?: string;
    /** Header carrying the shared secret that proves the request came from the proxy. Default `x-checkout-guard-proxy`. */
    secretHeader?: string;
    /** The shared secret. Falls back to `process.env.CHECKOUT_GUARD_PROXY_SECRET`. Without a secret the IP header is never trusted. */
    secret?: string;
}

export interface ResolvedTrustedClientIpOptions {
    header: string;
    secretHeader: string;
    secret: string | undefined;
}

export const DEFAULT_TRUSTED_CLIENT_IP_HEADER = 'x-real-client-ip';
export const DEFAULT_TRUSTED_CLIENT_IP_SECRET_HEADER = 'x-checkout-guard-proxy';
export const TRUSTED_CLIENT_IP_ENV = 'CHECKOUT_GUARD_PROXY_SECRET';

/** Property the middleware stamps on `req` — `true` when the proxy secret matched. */
export const TRUSTED_PROXY_REQUEST_FLAG = 'checkoutGuardTrustedProxy';

export function resolveTrustedClientIpOptions(opts?: TrustedClientIpOptions): ResolvedTrustedClientIpOptions {
    const header = (opts?.header || DEFAULT_TRUSTED_CLIENT_IP_HEADER).trim().toLowerCase();
    const secretHeader = (opts?.secretHeader || DEFAULT_TRUSTED_CLIENT_IP_SECRET_HEADER).trim().toLowerCase();
    const explicit = (opts?.secret || '').trim();
    const fromEnv = (process.env[TRUSTED_CLIENT_IP_ENV] || '').trim();
    const secret = explicit || fromEnv || undefined;
    return { header, secretHeader, secret };
}

/** Minimal request shape accepted by `getClientIp` (Express `Request` satisfies it). */
export interface ClientIpSource {
    headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>;
    socket?: { remoteAddress?: string | undefined } | null;
    ip?: string | undefined;
}

function headerValue(headers: ClientIpSource['headers'], name: string): string | undefined {
    const raw = (headers as Record<string, string | string[] | undefined>)[name];
    if (Array.isArray(raw)) return raw[0];
    return typeof raw === 'string' ? raw : undefined;
}

/**
 * Normalises a candidate address: trims, strips IPv6 brackets, the
 * `::ffff:` v4-mapped prefix and an IPv4 `:port` suffix. Returns `null`
 * unless the result is a syntactically valid IPv4/IPv6 address.
 */
export function normaliseIp(candidate: string | null | undefined): string | null {
    if (!candidate) return null;
    let value = String(candidate).trim();
    if (!value) return null;
    if (value.startsWith('[')) {
        const close = value.indexOf(']');
        value = close > 0 ? value.slice(1, close) : value.slice(1);
    }
    if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(value)) {
        value = value.slice(7);
    }
    if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(value)) {
        value = value.slice(0, value.lastIndexOf(':'));
    }
    return isIP(value) ? value : null;
}

/**
 * Resolves the client IP for a request, in order of trust:
 *  1. the trusted proxy header (`x-real-client-ip`) — only survives to this
 *     point when `trustedClientIpMiddleware` verified the proxy secret;
 *  2. `cf-connecting-ip` (Cloudflare in front of the API);
 *  3. the first entry of `x-forwarded-for`;
 *  4. the socket address (`req.socket.remoteAddress`, then `req.ip`).
 *
 * Returns `null` when nothing usable is present.
 */
export function getClientIp(req: ClientIpSource | null | undefined, opts?: Pick<TrustedClientIpOptions, 'header' | 'trustCloudflareHeader'>): string | null {
    if (!req || !req.headers) return null;
    const header = (opts?.header || DEFAULT_TRUSTED_CLIENT_IP_HEADER).toLowerCase();
    // `cf-connecting-ip` is only meaningful when Cloudflare is the sole way
    // to reach the API (an origin reachable directly could be sent any value).
    const trustCf = opts?.trustCloudflareHeader !== false;
    const candidates: Array<string | undefined> = [
        headerValue(req.headers, header),
        trustCf ? headerValue(req.headers, 'cf-connecting-ip') : undefined,
        headerValue(req.headers, 'x-forwarded-for')?.split(',')[0],
        req.socket?.remoteAddress,
        req.ip,
    ];
    for (const candidate of candidates) {
        const ip = normaliseIp(candidate);
        if (ip) return ip;
    }
    return null;
}

function secretsMatch(presented: string, expected: string): boolean {
    const a = Buffer.from(presented, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}

/**
 * Express handler that removes the client-IP header from any request that
 * does not present the proxy secret, so nothing downstream (fraud scoring,
 * `user-info`, rate limits) can be fed a spoofed address. When no secret is
 * configured the header is always removed. The secret header itself is left
 * in place so host code can perform its own check if it wishes; the verdict
 * is also stamped on `req[TRUSTED_PROXY_REQUEST_FLAG]`.
 */
export function createTrustedClientIpHandler(opts?: TrustedClientIpOptions): RequestHandler {
    const resolved = resolveTrustedClientIpOptions(opts);
    return (req: Request, _res: Response, next: NextFunction) => {
        const presented = headerValue(req.headers, resolved.secretHeader);
        const trusted = !!resolved.secret && !!presented && secretsMatch(presented, resolved.secret);
        if (!trusted && req.headers[resolved.header] !== undefined) {
            delete req.headers[resolved.header];
        }
        (req as unknown as Record<string, unknown>)[TRUSTED_PROXY_REQUEST_FLAG] = trusted;
        next();
    };
}

/**
 * Vendure `Middleware` entry for `config.apiOptions.middleware`. Mounted with
 * `beforeListen` on the root path so it runs first on every route (Shop API,
 * Admin API and every plugin REST controller), before body parsing.
 */
export function trustedClientIpMiddleware(opts?: TrustedClientIpOptions): Middleware {
    return {
        route: '/',
        handler: createTrustedClientIpHandler(opts),
        beforeListen: true,
    };
}
