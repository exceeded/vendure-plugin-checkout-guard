import { describe, expect, it } from 'vitest';

import { addDays, classifyBankTransfer, daysUntil } from './expiry-policy';

const createdAt = new Date('2026-09-01T12:00:00.000Z');
const payBy = new Date('2026-09-08T23:59:59.999Z');

describe('classifyBankTransfer', () => {
    it('does nothing on day 1', () => {
        const d = classifyBankTransfer({ now: new Date('2026-09-02T12:00:00.000Z'), createdAt, payBy, expiryDays: 7, reminderAfterDays: 3 });
        expect(d).toMatchObject({ expire: false, remind: false });
        expect(d.expiresAt).toEqual(payBy);
        expect(d.remindAt.toISOString()).toBe('2026-09-04T12:00:00.000Z');
    });

    it('reminds once after reminderAfterDays and never again', () => {
        const now = new Date('2026-09-05T00:00:00.000Z');
        expect(classifyBankTransfer({ now, createdAt, payBy, expiryDays: 7, reminderAfterDays: 3 })).toMatchObject({ expire: false, remind: true });
        expect(classifyBankTransfer({ now, createdAt, payBy, reminderSentAt: new Date('2026-09-04T18:00:00Z'), expiryDays: 7, reminderAfterDays: 3 }))
            .toMatchObject({ expire: false, remind: false });
    });

    it('expires strictly after payBy and never reminds at the same time', () => {
        expect(classifyBankTransfer({ now: new Date('2026-09-08T23:59:59.999Z'), createdAt, payBy, expiryDays: 7, reminderAfterDays: 3 }))
            .toMatchObject({ expire: false, remind: true });
        expect(classifyBankTransfer({ now: new Date('2026-09-09T00:00:00.000Z'), createdAt, payBy, expiryDays: 7, reminderAfterDays: 3 }))
            .toMatchObject({ expire: true, remind: false });
    });

    it('falls back to createdAt + expiryDays when payBy is missing or invalid', () => {
        const d = classifyBankTransfer({ now: new Date('2026-09-09T00:00:00.000Z'), createdAt, payBy: null, expiryDays: 7, reminderAfterDays: 3 });
        expect(d.expiresAt.toISOString()).toBe('2026-09-08T12:00:00.000Z');
        expect(d.expire).toBe(true);
        const bad = classifyBankTransfer({ now: new Date('2026-09-02T00:00:00.000Z'), createdAt, payBy: new Date('x'), expiryDays: 7, reminderAfterDays: 3 });
        expect(bad.expiresAt.toISOString()).toBe('2026-09-08T12:00:00.000Z');
    });

    it('guards against non-positive option values', () => {
        const d = classifyBankTransfer({ now: new Date('2026-09-02T00:00:00.000Z'), createdAt, payBy: null, expiryDays: 0, reminderAfterDays: -1 });
        expect(d.expiresAt).toEqual(addDays(createdAt, 7));
        expect(d.remindAt).toEqual(addDays(createdAt, 3));
    });

    it('does not remind when the reminder offset is beyond expiry', () => {
        const d = classifyBankTransfer({ now: new Date('2026-09-20T00:00:00.000Z'), createdAt, payBy, expiryDays: 7, reminderAfterDays: 30 });
        expect(d).toMatchObject({ expire: true, remind: false });
    });
});

describe('daysUntil', () => {
    it('rounds up and goes negative once past', () => {
        expect(daysUntil(payBy, new Date('2026-09-08T00:00:00.000Z'))).toBe(1);
        expect(daysUntil(payBy, new Date('2026-09-01T00:00:00.000Z'))).toBe(8);
        expect(daysUntil(payBy, new Date('2026-09-10T00:00:00.000Z'))).toBe(-1);
    });
});
