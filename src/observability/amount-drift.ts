/**
 * Amount-drift detection: a payment that settles for an amount other
 * than the order total means the PaymentIntent was created against a
 * stale cart (coupon applied or line changed after the intent was
 * created). Pure so the rule is unit-testable.
 */
export interface AmountDriftInput {
    /** Amount of the payment that just settled (minor units). */
    paymentAmount: number;
    /** Order total including tax (minor units). */
    orderTotalWithTax: number;
    /**
     * Amounts of the order's OTHER payments that are still live
     * (Settled or Authorized — not Cancelled/Declined/Error). A split
     * payment whose parts add up to the total is not drift.
     */
    otherLivePaymentAmounts?: number[];
}

export interface AmountDriftResult {
    drift: boolean;
    /** paid − total (minor units); negative = under-paid. */
    deltaMinor: number;
    paidMinor: number;
}

export function detectAmountDrift(input: AmountDriftInput): AmountDriftResult {
    const others = (input.otherLivePaymentAmounts || []).filter(n => Number.isFinite(n));
    const paid = Math.round(input.paymentAmount) + others.reduce((a, b) => a + Math.round(b), 0);
    const total = Math.round(input.orderTotalWithTax);
    const single = Math.round(input.paymentAmount) === total;
    const combined = paid === total;
    return { drift: !(single || combined), deltaMinor: paid - total, paidMinor: paid };
}
