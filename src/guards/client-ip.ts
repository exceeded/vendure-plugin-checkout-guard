import { timingSafeEqual } from 'crypto';
import { isIP } from 'net';
import type { IncomingHttpHeaders } from 'http';
import type { Middleware } from '@vendure/core';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export interface TrustedClientIpOptions {
    /**
     * Addresses (IPv4/IPv6, plain or CIDR) of the reverse proxies and load
     * balancers that sit in front of the API — e.g. `['10.0.0.0/8',
     * '173.245.48.0/20', '2400:cb00::/32']`. When set, `x-forwarded-for` is
     * only consulted for requests whose socket peer is in this list, and the
     * client IP is the right-most entry that is NOT itself a trusted proxy
     * (the address the nearest trusted hop appended). Unset: `x-forwarded-for`
     * is ignored and the address comes from `req.ip` (Express `trust proxy`)
     * or the socket.
     */
    trustedProxies?: string[];
    /**
     * Honour `cf-connecting-ip`. Default `true` when `trustedProxies` is set
     * (Cloudflare's ranges should then be in the list — the header is only
     * read from a trusted peer), otherwise `false`: an origin reachable
     * without Cloudflare can be sent any value.
     */
    trustCloudflareHeader?: boolean;
    /** Header carrying the real client IP, set by the storefront's server-side proxy. Default `x-real-client-ip`. */
    header?: string;
    /** Header carrying the shared secret that proves the request came from the proxy. Default `x-checkout-guard-proxy`. */
    secretHeader?: string;
    /** The shared secret. Falls back to `process.env.CHECKOUT_GUARD_PROXY_SECRET`. Without a secret the IP header is never trusted. */
    secret?: string;
}

/** The subset of the options `getClientIp` needs (the secret is checked by the middleware, not here). */
export type ClientIpResolveOptions = Pick<TrustedClientIpOptions, 'header' | 'trustCloudflareHeader' | 'trustedProxies'>;

export interface ResolvedTrustedClientIpOptions {
    header: string;
    secretHeader: string;
    secret: string | undefined;
    trustedProxies: string[];
    trustCloudflareHeader: boolean;
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
    const trustedProxies = (opts?.trustedProxies || []).map(s => String(s).trim()).filter(Boolean);
    // Invalid entries are a configuration error: fail at boot, not per request.
    for (const entry of trustedProxies) {
        if (!parseCidr(entry)) throw new Error(`trustedClientIp.trustedProxies: "${entry}" is not an IPv4/IPv6 address or CIDR`);
    }
    const trustCloudflareHeader = opts?.trustCloudflareHeader ?? trustedProxies.length > 0;
    return { header, secretHeader, secret, trustedProxies, trustCloudflareHeader };
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

// ── CIDR matching ────────────────────────────────────────────────────

const V6_ALL_ONES = (BigInt(1) << BigInt(128)) - BigInt(1);
const V4_MAPPED_PREFIX = BigInt(0xffff) << BigInt(32);

/** An address as a 128-bit integer; IPv4 lands in the `::ffff:0:0/96` mapped block. */
export function ipToBigInt(ip: string): bigint | null {
    const version = isIP(ip);
    if (version === 4) {
        const p = ip.split('.').map(Number);
        return V4_MAPPED_PREFIX | (BigInt(p[0]) << BigInt(24)) | (BigInt(p[1]) << BigInt(16)) | (BigInt(p[2]) << BigInt(8)) | BigInt(p[3]);
    }
    if (version !== 6) return null;
    let s = ip;
    const embedded = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
    if (embedded) {
        const p = embedded[2].split('.').map(Number);
        s = `${embedded[1]}${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
    }
    const parts = s.split('::');
    if (parts.length > 2) return null;
    const head = parts[0] ? parts[0].split(':') : [];
    const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
    const fill = parts.length === 2 ? 8 - head.length - tail.length : 0;
    if (fill < 0) return null;
    const groups = [...head, ...new Array(fill).fill('0'), ...tail];
    if (groups.length !== 8) return null;
    let out = BigInt(0);
    for (const g of groups) {
        const n = parseInt(g, 16);
        if (!Number.isFinite(n) || n < 0 || n > 0xffff) return null;
        out = (out << BigInt(16)) | BigInt(n);
    }
    return out;
}

interface ParsedCidr { network: bigint; mask: bigint }

/** `10.0.0.0/8`, `203.0.113.9`, `2400:cb00::/32`, `[2001:db8::1]` → network + mask, or `null`. */
export function parseCidr(entry: string): ParsedCidr | null {
    const raw = String(entry || '').trim();
    if (!raw) return null;
    const slash = raw.lastIndexOf('/');
    const ipPart = slash >= 0 ? raw.slice(0, slash) : raw;
    const ip = normaliseIp(ipPart);
    if (!ip) return null;
    const version = isIP(ip);
    const maxBits = version === 4 ? 32 : 128;
    let prefix = maxBits;
    if (slash >= 0) {
        const p = raw.slice(slash + 1);
        if (!/^\d{1,3}$/.test(p)) return null;
        prefix = Number(p);
        if (prefix > maxBits) return null;
    }
    const bits = ipToBigInt(ip);
    if (bits === null) return null;
    const length = version === 4 ? prefix + 96 : prefix;
    const mask = length === 0 ? BigInt(0) : V6_ALL_ONES ^ ((BigInt(1) << BigInt(128 - length)) - BigInt(1));
    return { network: bits & mask, mask };
}

const MATCHER_CACHE = new WeakMap<string[], ParsedCidr[]>();

function matcherFor(list: string[] | undefined): ParsedCidr[] {
    if (!list || !list.length) return [];
    let parsed = MATCHER_CACHE.get(list);
    if (!parsed) {
        parsed = list.map(parseCidr).filter((c): c is ParsedCidr => !!c);
        MATCHER_CACHE.set(list, parsed);
    }
    return parsed;
}

/** True when `ip` (any textual form `normaliseIp` accepts) is inside one of `trustedProxies`. */
export function isTrustedProxy(ip: string | null | undefined, trustedProxies: string[] | undefined): boolean {
    const parsed = matcherFor(trustedProxies);
    if (!parsed.length) return false;
    const norm = normaliseIp(ip);
    const bits = norm ? ipToBigInt(norm) : null;
    if (bits === null) return false;
    return parsed.some(c => (bits & c.mask) === c.network);
}

/**
 * The client address in an `x-forwarded-for` chain as seen from a trusted
 * peer: walk from the right, skipping trusted proxies (each hop appends the
 * address it received the request from), and return the first address that
 * is not one of ours. Malformed entries end the walk — everything to their
 * left was supplied by an untrusted party.
 */
export function clientIpFromForwardedFor(value: string | undefined, trustedProxies: string[] | undefined): string | null {
    if (!value) return null;
    const entries = value.split(',').map(s => s.trim());
    for (let i = entries.length - 1; i >= 0; i--) {
        const ip = normaliseIp(entries[i]);
        if (!ip) return null;
        if (!isTrustedProxy(ip, trustedProxies)) return ip;
    }
    return null;
}

/**
 * Resolves the client IP for a request, in order of trust:
 *  1. the trusted proxy header (`x-real-client-ip`) — only survives to this
 *     point when `trustedClientIpMiddleware` verified the proxy secret;
 *  2. `cf-connecting-ip`, when `trustCloudflareHeader` is on (and, with
 *     `trustedProxies` set, only when the socket peer is a trusted proxy);
 *  3. `x-forwarded-for`, only when the socket peer is in `trustedProxies`:
 *     the right-most entry that is not itself a trusted proxy;
 *  4. `req.ip` (Express applies the host's own `trust proxy` setting);
 *  5. the socket address (`req.socket.remoteAddress`).
 *
 * Without `trustedProxies`, `x-forwarded-for` is never read: a browser can
 * send any value in it, so the left-most entry proved nothing.
 * Returns `null` when nothing usable is present.
 */
export function getClientIp(req: ClientIpSource | null | undefined, opts?: ClientIpResolveOptions): string | null {
    if (!req || !req.headers) return null;
    const header = (opts?.header || DEFAULT_TRUSTED_CLIENT_IP_HEADER).toLowerCase();
    const trusted = opts?.trustedProxies && opts.trustedProxies.length ? opts.trustedProxies : undefined;
    const trustCf = opts?.trustCloudflareHeader ?? !!trusted;
    const peer = normaliseIp(req.socket?.remoteAddress);
    const peerTrusted = !!trusted && isTrustedProxy(peer, trusted);
    const candidates: Array<string | null | undefined> = [
        headerValue(req.headers, header),
        trustCf && (!trusted || peerTrusted) ? headerValue(req.headers, 'cf-connecting-ip') : undefined,
        peerTrusted ? clientIpFromForwardedFor(headerValue(req.headers, 'x-forwarded-for'), trusted) : undefined,
        trusted ? req.socket?.remoteAddress : req.ip,
        trusted ? req.ip : req.socket?.remoteAddress,
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
