/**
 * Runtime settings for the bank-transfer module.
 *
 * The plugin class (`src/plugin.ts`) owns the options object and the licence
 * state. This module never imports the plugin class (that would be a circular
 * import between the handler, the cron and the plugin), so the plugin pushes
 * the two values the module needs here from `CheckoutGuardPlugin.init()`:
 *
 * ```ts
 * setBankTransferRuntime({
 *     expiryDays: options.bankTransfer?.expiryDays,
 *     reminderAfterDays: options.bankTransfer?.reminderAfterDays,
 *     hasPremiumAccess: () => CheckoutGuardPlugin.hasPremiumAccess(),
 * });
 * ```
 *
 * Defaults are safe when nothing has been set: 7-day expiry, 3-day reminder,
 * and premium access reported as false (so the sweep is a logged no-op).
 */
export interface BankTransferRuntime {
    /** Days after the payment is created before an unpaid transfer expires. Default 7. */
    expiryDays: number;
    /** Days after the payment is created before the reminder event fires. Default 3. */
    reminderAfterDays: number;
    /** Auto-expiry + reminders are premium features; the sweep is a no-op when this returns false. */
    hasPremiumAccess: () => boolean;
}

export const DEFAULT_BANK_TRANSFER_EXPIRY_DAYS = 7;
export const DEFAULT_BANK_TRANSFER_REMINDER_AFTER_DAYS = 3;

let runtime: BankTransferRuntime = {
    expiryDays: DEFAULT_BANK_TRANSFER_EXPIRY_DAYS,
    reminderAfterDays: DEFAULT_BANK_TRANSFER_REMINDER_AFTER_DAYS,
    hasPremiumAccess: () => false,
};

function positiveIntOr(value: unknown, fallback: number): number {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function setBankTransferRuntime(next: Partial<BankTransferRuntime>): void {
    runtime = {
        expiryDays: positiveIntOr(next.expiryDays, DEFAULT_BANK_TRANSFER_EXPIRY_DAYS),
        reminderAfterDays: positiveIntOr(next.reminderAfterDays, DEFAULT_BANK_TRANSFER_REMINDER_AFTER_DAYS),
        hasPremiumAccess: typeof next.hasPremiumAccess === 'function' ? next.hasPremiumAccess : runtime.hasPremiumAccess,
    };
}

export function getBankTransferRuntime(): BankTransferRuntime {
    return runtime;
}
