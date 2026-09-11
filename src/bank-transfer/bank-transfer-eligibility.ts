import {
    CustomerService,
    ID,
    Injector,
    LanguageCode,
    Order,
    PaymentMethodEligibilityChecker,
    RequestContext,
} from '@vendure/core';

export const BANK_TRANSFER_ELIGIBILITY_CHECKER_CODE = 'bank-transfer-eligibility';

export interface BankTransferEligibilityArgs {
    /** Minimum order total (minor units) for bank transfer to be offered. 0 = no minimum. */
    minAmountMinor?: number | null;
    /** Maximum order total (minor units). 0 = no maximum. */
    maxAmountMinor?: number | null;
    /** Offer bank transfer to guests (no account). Default true. */
    allowGuests?: boolean | null;
    /** When non-empty, only customers in one of these groups may pay by bank transfer. */
    allowedCustomerGroupIds?: ID[] | null;
}

export interface BankTransferEligibilityInput {
    /** Order total including tax, minor units. */
    totalWithTax: number;
    /** ISO 4217 currency code, for the human-readable reason. */
    currencyCode: string;
    /** True when the session has no signed-in user. */
    isGuest: boolean;
    /** Groups the order's customer belongs to (empty for guests / no customer). */
    customerGroupIds: ID[];
}

export function formatMinorAmount(amountMinor: number, currencyCode: string): string {
    try {
        return new Intl.NumberFormat('en', { style: 'currency', currency: currencyCode }).format(amountMinor / 100);
    } catch {
        return `${(amountMinor / 100).toFixed(2)} ${currencyCode}`;
    }
}

/**
 * Pure eligibility rule. Returns `true` when bank transfer may be offered, or
 * a customer-facing reason string (Vendure surfaces it as
 * `eligiblePaymentMethods[].eligibilityMessage`).
 */
export function evaluateBankTransferEligibility(
    input: BankTransferEligibilityInput,
    args: BankTransferEligibilityArgs,
): true | string {
    const min = Number(args.minAmountMinor) || 0;
    const max = Number(args.maxAmountMinor) || 0;
    const allowGuests = args.allowGuests !== false;
    const allowedGroups = (args.allowedCustomerGroupIds ?? []).map(id => String(id)).filter(Boolean);

    if (input.isGuest && !allowGuests) {
        return 'Bank transfer is available to signed-in customers only. Please sign in or create an account.';
    }
    if (min > 0 && input.totalWithTax < min) {
        return `Bank transfer is available on orders of ${formatMinorAmount(min, input.currencyCode)} or more.`;
    }
    if (max > 0 && input.totalWithTax > max) {
        return `Bank transfer is available on orders up to ${formatMinorAmount(max, input.currencyCode)}.`;
    }
    if (allowedGroups.length) {
        const mine = new Set(input.customerGroupIds.map(id => String(id)));
        if (!allowedGroups.some(id => mine.has(id))) {
            return 'Bank transfer is not available for this account. Please choose another payment method.';
        }
    }
    return true;
}

let customerService: CustomerService | undefined;

/**
 * `bank-transfer-eligibility` — attach it to the bank-transfer payment method
 * in the admin (Payment Methods → Eligibility checker). Every rule is optional;
 * with no args set it always passes.
 */
export const bankTransferEligibilityChecker = new PaymentMethodEligibilityChecker({
    code: BANK_TRANSFER_ELIGIBILITY_CHECKER_CODE,
    description: [{ languageCode: LanguageCode.en, value: 'Bank transfer eligibility (Checkout Guard)' }],
    args: {
        minAmountMinor: {
            type: 'int',
            label: [{ languageCode: LanguageCode.en, value: 'Minimum order total (minor units)' }],
            description: [{ languageCode: LanguageCode.en, value: 'E.g. 5000 = 50.00. 0 = no minimum.' }],
            defaultValue: 0,
            ui: { component: 'number-form-input', min: 0, step: 1 },
        },
        maxAmountMinor: {
            type: 'int',
            label: [{ languageCode: LanguageCode.en, value: 'Maximum order total (minor units)' }],
            description: [{ languageCode: LanguageCode.en, value: '0 = no maximum.' }],
            defaultValue: 0,
            ui: { component: 'number-form-input', min: 0, step: 1 },
        },
        allowGuests: {
            type: 'boolean',
            label: [{ languageCode: LanguageCode.en, value: 'Allow guest checkout' }],
            defaultValue: true,
        },
        allowedCustomerGroupIds: {
            type: 'ID',
            list: true as const,
            label: [{ languageCode: LanguageCode.en, value: 'Restrict to customer groups' }],
            description: [{ languageCode: LanguageCode.en, value: 'Leave empty to allow every customer. Customer group IDs.' }],
        },
    },
    init(injector: Injector) {
        customerService = injector.get(CustomerService);
    },
    destroy() {
        customerService = undefined;
    },
    check: async (ctx: RequestContext, order: Order, args) => {
        const restrictToGroups = (args.allowedCustomerGroupIds ?? []).length > 0;
        let customerGroupIds: ID[] = [];
        if (restrictToGroups && order.customer?.id && customerService) {
            try {
                const groups = await customerService.getCustomerGroups(ctx, order.customer.id);
                customerGroupIds = groups.map(g => g.id);
            } catch {
                customerGroupIds = [];
            }
        }
        return evaluateBankTransferEligibility(
            {
                totalWithTax: order.totalWithTax,
                currencyCode: order.currencyCode,
                isGuest: !ctx.activeUserId,
                customerGroupIds,
            },
            args,
        );
    },
});
