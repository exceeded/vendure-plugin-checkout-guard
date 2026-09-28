import { afterEach, describe, expect, it } from 'vitest';
import {
    TRUSTED_CLIENT_IP_ENV,
    TRUSTED_PROXY_REQUEST_FLAG,
    clientIpFromForwardedFor,
    createTrustedClientIpHandler,
    getClientIp,
    ipToBigInt,
    isTrustedProxy,
    normaliseIp,
    parseCidr,
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
    it('prefers the trusted header, then req.ip (Express trust proxy), then the socket — x-forwarded-for is ignored without trustedProxies', () => {
        const all = req({
            'x-real-client-ip': '198.51.100.1',
            'cf-connecting-ip': '198.51.100.2',
            'x-forwarded-for': '198.51.100.3, 10.0.0.1',
        }, { socket: { remoteAddress: '::ffff:10.0.0.9' }, ip: '10.0.0.8' });
        expect(getClientIp(all)).toBe('198.51.100.1');
        delete all.headers['x-real-client-ip'];
        // cf-connecting-ip is off by default: an origin reachable without Cloudflare can be sent anything.
        expect(getClientIp(all)).toBe('10.0.0.8');
        expect(getClientIp(all, { trustCloudflareHeader: true })).toBe('198.51.100.2');
        delete all.headers['cf-connecting-ip'];
        expect(getClientIp(all)).toBe('10.0.0.8');
        all.ip = undefined;
        expect(getClientIp(all)).toBe('10.0.0.9');
        all.socket = undefined;
        expect(getClientIp(all)).toBeNull();
    });

    it('skips malformed candidates instead of returning them', () => {
        expect(getClientIp(req({ 'x-real-client-ip': 'evil', 'cf-connecting-ip': '198.51.100.2' }), { trustCloudflareHeader: true })).toBe('198.51.100.2');
        expect(getClientIp(req({ 'x-forwarded-for': ' , 198.51.100.7' }, { socket: { remoteAddress: '10.0.0.9' } }), { trustedProxies: ['10.0.0.0/8'] })).toBe('198.51.100.7');
        expect(getClientIp(req({ 'x-forwarded-for': '198.51.100.7, junk' }, { socket: { remoteAddress: '10.0.0.9' } }), { trustedProxies: ['10.0.0.0/8'] })).toBe('10.0.0.9');
        expect(getClientIp(req({}, { ip: 'nope', socket: { remoteAddress: '10.0.0.9' } }))).toBe('10.0.0.9');
    });

    it('honours a custom trusted header name and array headers', () => {
        expect(getClientIp(req({ 'x-client': ['198.51.100.5', '1.1.1.1'] }), { header: 'X-Client' })).toBe('198.51.100.5');
    });

    it('returns null when nothing is usable', () => {
        expect(getClientIp(req({}))).toBeNull();
        expect(getClientIp(null)).toBeNull();
        expect(getClientIp({ headers: undefined as any })).toBeNull();
    });

    describe('with trustedProxies', () => {
        const proxies = ['10.0.0.0/8', '192.168.1.25', '2400:cb00::/32'];

        it('reads x-forwarded-for only from a trusted peer and takes the right-most untrusted entry', () => {
            const viaProxy = req({ 'x-forwarded-for': '203.0.113.9, 198.51.100.4, 10.0.0.2' }, { socket: { remoteAddress: '10.0.0.1' } });
            // 10.0.0.2 is ours (skipped); 198.51.100.4 is the client the nearest trusted hop saw.
            expect(getClientIp(viaProxy, { trustedProxies: proxies })).toBe('198.51.100.4');
            const direct = req({ 'x-forwarded-for': '203.0.113.9' }, { socket: { remoteAddress: '203.0.113.50' }, ip: '203.0.113.50' });
            expect(getClientIp(direct, { trustedProxies: proxies })).toBe('203.0.113.50');
        });

        it('falls back to the socket when every forwarded entry is a trusted proxy or malformed', () => {
            expect(getClientIp(req({ 'x-forwarded-for': '10.0.0.3, 10.0.0.2' }, { socket: { remoteAddress: '10.0.0.1' } }), { trustedProxies: proxies })).toBe('10.0.0.1');
            expect(getClientIp(req({ 'x-forwarded-for': '203.0.113.9, junk, 10.0.0.2' }, { socket: { remoteAddress: '10.0.0.1' } }), { trustedProxies: proxies })).toBe('10.0.0.1');
            expect(getClientIp(req({ 'x-forwarded-for': '203.0.113.9, junk' }, { socket: { remoteAddress: '10.0.0.1' } }), { trustedProxies: proxies })).toBe('10.0.0.1');
        });

        it('matches IPv6 peers, v4-mapped sockets and bracketed/ported forms', () => {
            const v6 = req({ 'x-forwarded-for': '2001:db8::7, [2400:cb00:1::5]:443' }, { socket: { remoteAddress: '2400:cb00:2::9' } });
            expect(getClientIp(v6, { trustedProxies: proxies })).toBe('2001:db8::7');
            const mapped = req({ 'x-forwarded-for': '198.51.100.8' }, { socket: { remoteAddress: '::ffff:192.168.1.25' } });
            expect(getClientIp(mapped, { trustedProxies: proxies })).toBe('198.51.100.8');
        });

        it('enables cf-connecting-ip by default, but only from a trusted peer', () => {
            const cf = req({ 'cf-connecting-ip': '198.51.100.2', 'x-forwarded-for': '198.51.100.2' }, { socket: { remoteAddress: '2400:cb00:2::9' } });
            expect(getClientIp(cf, { trustedProxies: proxies })).toBe('198.51.100.2');
            const spoof = req({ 'cf-connecting-ip': '198.51.100.2' }, { socket: { remoteAddress: '203.0.113.50' } });
            expect(getClientIp(spoof, { trustedProxies: proxies })).toBe('203.0.113.50');
            expect(getClientIp(cf, { trustedProxies: proxies, trustCloudflareHeader: false })).toBe('198.51.100.2');
            expect(getClientIp(req({ 'cf-connecting-ip': '198.51.100.2' }, { socket: { remoteAddress: '10.0.0.1' } }), { trustedProxies: proxies, trustCloudflareHeader: false })).toBe('10.0.0.1');
        });

        it('the secret-header path still wins over everything', () => {
            const r = req({ 'x-real-client-ip': '198.51.100.1', 'x-forwarded-for': '203.0.113.9' }, { socket: { remoteAddress: '10.0.0.1' } });
            expect(getClientIp(r, { trustedProxies: proxies })).toBe('198.51.100.1');
        });
    });
});

describe('CIDR helpers', () => {
    it('parses plain addresses and prefixes for both families', () => {
        expect(parseCidr('10.0.0.0/8')).toBeTruthy();
        expect(parseCidr('203.0.113.9')).toBeTruthy();
        expect(parseCidr('[2001:db8::1]')).toBeTruthy();
        expect(parseCidr('2400:cb00::/32')).toBeTruthy();
        expect(parseCidr('0.0.0.0/0')).toBeTruthy();
        expect(parseCidr('::/0')).toBeTruthy();
        for (const bad of ['', 'proxy', '10.0.0.0/33', '2400:cb00::/129', '10.0.0.0/x', '1.2.3']) expect(parseCidr(bad)).toBeNull();
    });

    it('matches addresses against prefixes', () => {
        expect(isTrustedProxy('10.255.1.2', ['10.0.0.0/8'])).toBe(true);
        expect(isTrustedProxy('11.0.0.1', ['10.0.0.0/8'])).toBe(false);
        expect(isTrustedProxy('::ffff:10.1.1.1', ['10.0.0.0/8'])).toBe(true);
        expect(isTrustedProxy('10.1.1.1', ['10.1.1.1'])).toBe(true);
        expect(isTrustedProxy('10.1.1.2', ['10.1.1.1'])).toBe(false);
        expect(isTrustedProxy('2400:cb00:ffff::1', ['2400:cb00::/32'])).toBe(true);
        expect(isTrustedProxy('2400:cb01::1', ['2400:cb00::/32'])).toBe(false);
        expect(isTrustedProxy('1.2.3.4', ['::/0'])).toBe(true);
        expect(isTrustedProxy('2001:db8::1', ['0.0.0.0/0'])).toBe(false);
        expect(isTrustedProxy('1.2.3.4', [])).toBe(false);
        expect(isTrustedProxy('1.2.3.4', undefined)).toBe(false);
        expect(isTrustedProxy('junk', ['0.0.0.0/0'])).toBe(false);
    });

    it('converts IPv6 forms consistently', () => {
        expect(ipToBigInt('::ffff:1.2.3.4')).toBe(ipToBigInt('1.2.3.4'));
        expect(ipToBigInt('2001:db8::1')).toBe(ipToBigInt('2001:0db8:0000:0000:0000:0000:0000:0001'));
        expect(ipToBigInt('::1')).toBe(BigInt(1));
        expect(ipToBigInt('junk')).toBeNull();
    });

    it('walks x-forwarded-for from the right', () => {
        expect(clientIpFromForwardedFor('203.0.113.9, 10.0.0.2', ['10.0.0.0/8'])).toBe('203.0.113.9');
        expect(clientIpFromForwardedFor('203.0.113.9', ['10.0.0.0/8'])).toBe('203.0.113.9');
        expect(clientIpFromForwardedFor('10.0.0.5', ['10.0.0.0/8'])).toBeNull();
        expect(clientIpFromForwardedFor(undefined, ['10.0.0.0/8'])).toBeNull();
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
        expect(resolveTrustedClientIpOptions()).toEqual({ header: 'x-real-client-ip', secretHeader: 'x-checkout-guard-proxy', secret: undefined, trustedProxies: [], trustCloudflareHeader: false });
        expect(resolveTrustedClientIpOptions({ header: 'X-Client-IP', secretHeader: 'X-Proxy-Key', secret: ' s3cret ' }))
            .toEqual({ header: 'x-client-ip', secretHeader: 'x-proxy-key', secret: 's3cret', trustedProxies: [], trustCloudflareHeader: false });
    });

    it('validates trustedProxies at boot and derives the Cloudflare default from it', () => {
        expect(resolveTrustedClientIpOptions({ trustedProxies: [' 10.0.0.0/8 ', '2400:cb00::/32', ''] }))
            .toMatchObject({ trustedProxies: ['10.0.0.0/8', '2400:cb00::/32'], trustCloudflareHeader: true });
        expect(resolveTrustedClientIpOptions({ trustedProxies: ['10.0.0.0/8'], trustCloudflareHeader: false }).trustCloudflareHeader).toBe(false);
        expect(resolveTrustedClientIpOptions({ trustCloudflareHeader: true }).trustCloudflareHeader).toBe(true);
        expect(() => resolveTrustedClientIpOptions({ trustedProxies: ['not-a-proxy'] })).toThrow(/not-a-proxy/);
        expect(() => trustedClientIpMiddleware({ trustedProxies: ['10.0.0.0/33'] })).toThrow(/10\.0\.0\.0\/33/);
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
            expect(getClientIp(r, { trustCloudflareHeader: true })).toBe('198.51.100.2');
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
