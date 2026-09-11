/**
 * Pure decision logic for the 6-hourly sweep. Given what we know about an
 * Authorized bank-transfer payment, decide whether it should be expired now,
 * or reminded now, or left alone.
 */
export interface BankTransferSweepInput {
    now: Date;
    /** payment.createdAt */
    createdAt: Date;
    /** The pay-by moment shown to the customer (metadata.public.payBy), if present. */
    payBy?: Date | null;
    /** When the reminder event was already published, if ever. */
    reminderSentAt?: Date | null;
    /** Fallback expiry window when the payment carries no payBy. */
    expiryDays: number;
    /** Reminder offset from createdAt. */
    reminderAfterDays: number;
}

export interface BankTransferSweepDecision {
    /** Effective expiry moment used for the decision. */
    expiresAt: Date;
    /** Moment the reminder becomes due. */
    remindAt: Date;
    expire: boolean;
    remind: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function addDays(date: Date, days: number): Date {
    return new Date(date.getTime() + days * DAY_MS);
}

export function classifyBankTransfer(input: BankTransferSweepInput): BankTransferSweepDecision {
    const expiryDays = input.expiryDays > 0 ? input.expiryDays : 7;
    const reminderAfterDays = input.reminderAfterDays > 0 ? input.reminderAfterDays : 3;
    const expiresAt = input.payBy && !Number.isNaN(input.payBy.getTime())
        ? input.payBy
        : addDays(input.createdAt, expiryDays);
    const remindAt = addDays(input.createdAt, reminderAfterDays);
    const now = input.now.getTime();

    const expire = now > expiresAt.getTime();
    // A reminder only makes sense while the customer can still pay, and only once.
    const remind = !expire && !input.reminderSentAt && now >= remindAt.getTime();
    return { expiresAt, remindAt, expire, remind };
}

/** Whole days (rounded up) until `expiresAt`; negative when already past. */
export function daysUntil(expiresAt: Date, now: Date): number {
    return Math.ceil((expiresAt.getTime() - now.getTime()) / DAY_MS);
}
