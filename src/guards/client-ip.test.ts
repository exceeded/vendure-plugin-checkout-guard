import { afterEach, describe, expect, it } from 'vitest';
import {
    TRUSTED_CLIENT_IP_ENV,
    TRUSTED_PROXY_REQUEST_FLAG,
    createTrustedClientIpHandler,
    getClientIp,
    normaliseIp,
    resolveTrustedClientIpOptions,
    trustedClientIpMiddleware,
} from './client-ip';

function req(headers: Record<string, string | string[] | undefined>, extra: Record<string, unknown> = {}): any {
    return { headers: { ...headers }, method: 'POST', ...extra };
}

function run(handler: ReturnType<typeof createTrustedClientIpHandler>, r: any): boolean {
    let called = false;
    handler(r, {} as any, () => { called = true; });
    return called;
}

describe('normaliseIp', () => {
    it('accepts valid addresses and strips wrappers', () => {
        expect(normaliseIp(' 203.0.113.9 ')).toBe('203.0.113.9');
        expect(normaliseIp('::ffff:203.0.113.9')).toBe('203.0.113.9');
        expect(normaliseIp('203.0.113.9:44321')).toBe('203.0.113.9');
        expect(normaliseIp('[2001:db8::1]')).toBe('2001:db8::1');
        expect(normaliseIp('2001:db8::1')).toBe('2001:db8::1');
    });

    it('rejects junk', () => {
        expect(normaliseIp('')).toBeNull();
        expect(normaliseIp(undefined)).toBeNull();
        expect(normaliseIp('not-an-ip')).toBeNull();
        expect(normaliseIp('999.1.1.1')).toBeNull();
        expect(normaliseIp('<script>')).toBeNull();
    });
});

describe('getClientIp', () => {
    it('prefers the trusted header, then cf-connecting-ip, then x-forwarded-for, then the socket', () => {
        const all = req({
            'x-real-client-ip': '198.51.100.1',
            'cf-connecting-ip': '198.51.100.2',
            'x-forwarded-for': '198.51.100.3, 10.0.0.1',
        }, { socket: { remoteAddress: '::ffff:10.0.0.9' }, ip: '10.0.0.8' });
        expect(getClientIp(all)).toBe('198.51.100.1');
        delete all.headers['x-real-client-ip'];
        expect(getClientIp(all)).toBe('198.51.100.2');
        delete all.headers['cf-connecting-ip'];
        expect(getClientIp(all)).toBe('198.51.100.3');
        delete all.headers['x-forwarded-for'];
        expect(getClientIp(all)).toBe('10.0.0.9');
        all.socket = undefined;
        expect(getClientIp(all)).toBe('10.0.0.8');
    });

    it('skips malformed candidates instead of returning them', () => {
        expect(getClientIp(req({ 'x-real-client-ip': 'evil', 'cf-connecting-ip': '198.51.100.2' }))).toBe('198.51.100.2');
        expect(getClientIp(req({ 'x-forwarded-for': ' , 198.51.100.7' }, { socket: { remoteAddress: '10.0.0.9' } }))).toBe('10.0.0.9');
    });

    it('honours a custom trusted header name and array headers', () => {
        expect(getClientIp(req({ 'x-client': ['198.51.100.5', '1.1.1.1'] }), { header: 'X-Client' })).toBe('198.51.100.5');
    });

    it('returns null when nothing is usable', () => {
        expect(getClientIp(req({}))).toBeNull();
        expect(getClientIp(null)).toBeNull();
        expect(getClientIp({ headers: undefined as any })).toBeNull();
    });
});

describe('resolveTrustedClientIpOptions', () => {
    const saved = process.env[TRUSTED_CLIENT_IP_ENV];
    afterEach(() => {
        if (saved === undefined) delete process.env[TRUSTED_CLIENT_IP_ENV];
        else process.env[TRUSTED_CLIENT_IP_ENV] = saved;
    });

    it('applies defaults and lower-cases header names', () => {
        delete process.env[TRUSTED_CLIENT_IP_ENV];
        expect(resolveTrustedClientIpOptions()).toEqual({ header: 'x-real-client-ip', secretHeader: 'x-checkout-guard-proxy', secret: undefined });
        expect(resolveTrustedClientIpOptions({ header: 'X-Client-IP', secretHeader: 'X-Proxy-Key', secret: ' s3cret ' }))
            .toEqual({ header: 'x-client-ip', secretHeader: 'x-proxy-key', secret: 's3cret' });
    });

    it('falls back to the environment secret and treats blank as unset', () => {
        process.env[TRUSTED_CLIENT_IP_ENV] = 'from-env';
        expect(resolveTrustedClientIpOptions().secret).toBe('from-env');
        expect(resolveTrustedClientIpOptions({ secret: '' }).secret).toBe('from-env');
        expect(resolveTrustedClientIpOptions({ secret: 'explicit' }).secret).toBe('explicit');
    });
});

describe('createTrustedClientIpHandler', () => {
    const handler = createTrustedClientIpHandler({ secret: 'proxy-secret' });

    it('keeps the IP header when the proxy secret matches', () => {
        const r = req({ 'x-real-client-ip': '198.51.100.1', 'x-checkout-guard-proxy': 'proxy-secret' });
        expect(run(handler, r)).toBe(true);
        expect(r.headers['x-real-client-ip']).toBe('198.51.100.1');
        expect(r[TRUSTED_PROXY_REQUEST_FLAG]).toBe(true);
        expect(getClientIp(r)).toBe('198.51.100.1');
    });

    it('strips the IP header when the secret is wrong, missing or the wrong length', () => {
        for (const bad of [{ 'x-checkout-guard-proxy': 'proxy-secreT' }, { 'x-checkout-guard-proxy': 'short' }, {}]) {
            const r = req({ 'x-real-client-ip': '198.51.100.1', 'cf-connecting-ip': '198.51.100.2', ...bad });
            expect(run(handler, r)).toBe(true);
            expect(r.headers['x-real-client-ip']).toBeUndefined();
            expect(r[TRUSTED_PROXY_REQUEST_FLAG]).toBe(false);
            expect(getClientIp(r)).toBe('198.51.100.2');
        }
    });

    it('never trusts the header when no secret is configured', () => {
        const saved = process.env[TRUSTED_CLIENT_IP_ENV];
        delete process.env[TRUSTED_CLIENT_IP_ENV];
        try {
            const noSecret = createTrustedClientIpHandler({});
            const r = req({ 'x-real-client-ip': '198.51.100.1', 'x-checkout-guard-proxy': '' });
            expect(run(noSecret, r)).toBe(true);
            expect(r.headers['x-real-client-ip']).toBeUndefined();
        } finally {
            if (saved !== undefined) process.env[TRUSTED_CLIENT_IP_ENV] = saved;
        }
    });

    it('respects custom header names', () => {
        const custom = createTrustedClientIpHandler({ header: 'X-Client', secretHeader: 'X-Key', secret: 'k' });
        const ok = req({ 'x-client': '198.51.100.1', 'x-key': 'k' });
        run(custom, ok);
        expect(ok.headers['x-client']).toBe('198.51.100.1');
        const bad = req({ 'x-client': '198.51.100.1' });
        run(custom, bad);
        expect(bad.headers['x-client']).toBeUndefined();
    });

    it('is exposed as a beforeListen middleware on the root route', () => {
        const mw = trustedClientIpMiddleware({ secret: 'x' });
        expect(mw.route).toBe('/');
        expect(mw.beforeListen).toBe(true);
        expect(typeof mw.handler).toBe('function');
    });
});
