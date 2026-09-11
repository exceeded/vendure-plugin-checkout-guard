import { LanguageCode, PaymentMethodHandler } from '@vendure/core';

import { BANK_TRANSFER_HANDLER_CODE, buildBankTransferPublicDetails } from './bank-details';
import { DEFAULT_BANK_TRANSFER_EXPIRY_DAYS } from './bank-transfer-runtime';

/**
 * Bank transfer (BACS / SEPA / wire) payment method.
 *
 * Lifecycle — a real order, not an "email us" note:
 *   1. The storefront transitions the order to ArrangingPayment and calls
 *      `addPaymentToOrder({ method: '<code of the method using this handler>' })`.
 *   2. `createPayment` returns `Authorized`, so the order is placed and lands in
 *      `PaymentAuthorized`. The bank details, reference (order code), amount and
 *      pay-by date travel in `metadata.public`, which is the only metadata slice
 *      Vendure exposes to the Shop API — the storefront renders them from
 *      `activeOrder.payments[].metadata.public` and the confirmation page shows
 *      them again while `order.state === 'PaymentAuthorized'`.
 *   3. Funds arrive → an admin marks the payment received (Vendure admin
 *      "Settle payment", or `POST /checkout-guard/bank-transfers/:paymentId/received`)
 *      → `settlePayment` succeeds → order moves to `PaymentSettled` and the
 *      host's fulfilment (key delivery etc.) runs as for any settled payment.
 *   4. No funds by the pay-by date → the premium sweep (every 6 hours, worker)
 *      cancels the payment and the order and publishes `BankTransferExpiredEvent`.
 *
 * All account details are handler args so they are editable per payment method
 * (and therefore per channel) from the admin Payment Methods screen. Nothing is
 * hard-coded here on purpose.
 */
export const bankTransferPaymentHandler = new PaymentMethodHandler({
    code: BANK_TRANSFER_HANDLER_CODE,
    description: [{ languageCode: LanguageCode.en, value: 'Bank transfer (Checkout Guard)' }],
    args: {
        accountName: {
            type: 'string',
            label: [{ languageCode: LanguageCode.en, value: 'Account name' }],
            description: [{ languageCode: LanguageCode.en, value: 'Beneficiary name shown to the customer.' }],
            defaultValue: '',
        },
        accountNumber: {
            type: 'string',
            label: [{ languageCode: LanguageCode.en, value: 'Account number' }],
            defaultValue: '',
        },
        sortCode: {
            type: 'string',
            label: [{ languageCode: LanguageCode.en, value: 'Sort code' }],
            description: [{ languageCode: LanguageCode.en, value: 'UK domestic transfers (leave blank if not applicable).' }],
            defaultValue: '',
        },
        iban: {
            type: 'string',
            label: [{ languageCode: LanguageCode.en, value: 'IBAN' }],
            description: [{ languageCode: LanguageCode.en, value: 'International transfers (leave blank if not applicable).' }],
            defaultValue: '',
        },
        bic: {
            type: 'string',
            label: [{ languageCode: LanguageCode.en, value: 'BIC / SWIFT' }],
            defaultValue: '',
        },
        instructions: {
            type: 'string',
            label: [{ languageCode: LanguageCode.en, value: 'Instructions' }],
            description: [{
                languageCode: LanguageCode.en,
                value: 'Free text shown under the bank details, e.g. what to quote as the reference and when the order is fulfilled.',
            }],
            ui: { component: 'textarea-form-input' },
            defaultValue: 'Please quote your order number as the payment reference. Your order is reserved and will be fulfilled once we confirm receipt of funds.',
        },
        expiryDays: {
            type: 'int',
            label: [{ languageCode: LanguageCode.en, value: 'Pay within (days)' }],
            description: [{
                languageCode: LanguageCode.en,
                value: 'Days the customer has to pay. Shown as the pay-by date and used by the automatic expiry sweep.',
            }],
            defaultValue: DEFAULT_BANK_TRANSFER_EXPIRY_DAYS,
            ui: { component: 'number-form-input', min: 1, max: 90, step: 1 },
        },
    },

    createPayment: async (ctx, order, amount, args) => {
        const details = buildBankTransferPublicDetails({
            orderCode: order.code,
            amountMinor: amount,
            currency: order.currencyCode,
            args,
        });
        return {
            amount,
            // Authorized, not Settled: the order is placed and held pending funds.
            state: 'Authorized' as const,
            transactionId: order.code,
            metadata: { public: details },
        };
    },

    // Admin "mark received" / "Settle payment" — success moves the order to PaymentSettled.
    settlePayment: async () => ({ success: true }),

    // Unpaid transfer (admin cancel or the expiry sweep).
    cancelPayment: async () => ({ success: true }),
});
