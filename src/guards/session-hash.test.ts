import { describe, expect, it } from 'vitest';
import {
    CG_SESSION_HASH_FIELD,
    cgSessionHashCustomField,
    decideSessionHashWrite,
    hashSessionToken,
    hashesEqual,
    parseDuration,
    readStoredSessionHash,
    registerCheckoutGuardCustomFields,
} from './session-hash';

describe('hashSessionToken', () => {
    it('produces a stable 64-char hex sha256', () => {
        const a = hashSessionToken('abc');
        expect(a).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
        expect(hashSessionToken('abc')).toBe(a);
        expect(hashSessionToken('abd')).not.toBe(a);
    });

    it('returns null for empty input', () => {
        expect(hashSessionToken('')).toBeNull();
        expect(hashSessionToken(null)).toBeNull();
        expect(hashSessionToken(undefined)).toBeNull();
    });
});

describe('hashesEqual', () => {
    it('compares equal-length strings safely', () => {
        expect(hashesEqual('abc', 'abc')).toBe(true);
        expect(hashesEqual('abc', 'abd')).toBe(false);
        expect(hashesEqual('abc', 'abcd')).toBe(false);
        expect(hashesEqual(null, 'abc')).toBe(false);
        expect(hashesEqual('abc', undefined)).toBe(false);
    });
});

describe('parseDuration', () => {
    it('parses ms-style strings', () => {
        expect(parseDuration('2h')).toBe(7_200_000);
        expect(parseDuration('30m')).toBe(1_800_000);
        expect(parseDuration('5d')).toBe(432_000_000);
        expect(parseDuration('90s')).toBe(90_000);
        expect(parseDuration('1.5 hours')).toBe(5_400_000);
        expect(parseDuration('1500')).toBe(1500);
        expect(parseDuration('250ms')).toBe(250);
        expect(parseDuration(4000)).toBe(4000);
    });

    it('throws on garbage', () => {
        expect(() => parseDuration('soon')).toThrow();
        expect(() => parseDuration('2 fortnights')).toThrow();
        expect(() => parseDuration('')).toThrow();
        expect(() => parseDuration(-1)).toThrow();
        expect(() => parseDuration(Number.NaN)).toThrow();
    });
});

describe('readStoredSessionHash', () => {
    it('reads the custom field and ignores blanks', () => {
        expect(readStoredSessionHash({ customFields: { [CG_SESSION_HASH_FIELD]: 'deadbeef' } })).toBe('deadbeef');
        expect(readStoredSessionHash({ customFields: { [CG_SESSION_HASH_FIELD]: '' } })).toBeNull();
        expect(readStoredSessionHash({ customFields: {} })).toBeNull();
        expect(readStoredSessionHash({})).toBeNull();
        expect(readStoredSessionHash(null)).toBeNull();
    });
});

describe('decideSessionHashWrite', () => {
    const token = 'sess-token';
    const hash = hashSessionToken(token)!;

    it('binds on shop-side creation', () => {
        expect(decideSessionHashWrite({ apiType: 'shop', type: 'created', existingHash: null, sessionToken: token })).toBe(hash);
    });

    it('ignores admin and worker contexts', () => {
        expect(decideSessionHashWrite({ apiType: 'admin', type: 'created', existingHash: null, sessionToken: token })).toBeNull();
        expect(decideSessionHashWrite({ apiType: 'custom', type: 'created', existingHash: null, sessionToken: token })).toBeNull();
        expect(decideSessionHashWrite({ apiType: undefined, type: 'created', existingHash: null, sessionToken: token })).toBeNull();
    });

    it('ignores deletions and missing sessions', () => {
        expect(decideSessionHashWrite({ apiType: 'shop', type: 'deleted', existingHash: null, sessionToken: token })).toBeNull();
        expect(decideSessionHashWrite({ apiType: 'shop', type: 'created', existingHash: null, sessionToken: undefined })).toBeNull();
    });

    it('back-fills unbound orders on update but never rotates an existing binding', () => {
        expect(decideSessionHashWrite({ apiType: 'shop', type: 'updated', existingHash: null, sessionToken: token })).toBe(hash);
        expect(decideSessionHashWrite({ apiType: 'shop', type: 'updated', existingHash: 'other', sessionToken: token })).toBeNull();
        expect(decideSessionHashWrite({ apiType: 'shop', type: 'updated', existingHash: hash, sessionToken: token })).toBeNull();
    });

    it('skips a no-op write when the hash already matches', () => {
        expect(decideSessionHashWrite({ apiType: 'shop', type: 'created', existingHash: hash, sessionToken: token })).toBeNull();
    });
});

describe('registerCheckoutGuardCustomFields', () => {
    it('adds the field once and keeps existing fields', () => {
        const config: any = { customFields: { Order: [{ name: 'ip', type: 'string' }] } };
        registerCheckoutGuardCustomFields(config);
        registerCheckoutGuardCustomFields(config);
        expect(config.customFields.Order.map((f: any) => f.name)).toEqual(['ip', CG_SESSION_HASH_FIELD]);
        expect(config.customFields.Order[1]).toBe(cgSessionHashCustomField);
    });

    it('creates the Order list when absent', () => {
        const config: any = { customFields: {} };
        registerCheckoutGuardCustomFields(config);
        expect(config.customFields.Order).toHaveLength(1);
    });

    it('is internal, readonly and non-public', () => {
        expect(cgSessionHashCustomField).toMatchObject({ name: CG_SESSION_HASH_FIELD, type: 'string', public: false, readonly: true, internal: true });
    });
});
