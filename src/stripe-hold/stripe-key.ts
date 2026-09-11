import { ID, PaymentMethod, RequestContext, TransactionalConnection } from '@vendure/core';
import { STRIPE_HOLD_HANDLER_CODE } from './hold-utils';
import { effectiveStripeHoldOptions } from './runtime';

/**
 * Stripe credentials live on the channel's Vendure Stripe PaymentMethod
 * (handler `stripe`, arg `apiKey`) — the hold handler has no args of its
 * own, so a channel with one Stripe account needs one secret in one
 * place. Mirrors the AVS lookup in the fraud-prevention plugin.
 */

function argValue(method: PaymentMethod, name: string): string | undefined {
    const v = method.handler?.args?.find(a => a.name === name)?.value;
    return v ? String(v) : undefined;
}

function inChannel(method: PaymentMethod, channelId: ID | undefined): boolean {
    if (channelId === undefined || channelId === null) return true;
    return (method.channels || []).some(ch => String(ch.id) === String(channelId));
}

/** Every PaymentMethod (any channel) whose handler is `code`. Uses the raw
 *  connection so crons can list without a channel ctx. */
export async function findMethodsByHandler(connection: TransactionalConnection, handlerCode: string): Promise<PaymentMethod[]> {
    const all = await connection.rawConnection.getRepository(PaymentMethod).find({ relations: ['channels'] });
    return all.filter(m => m.handler?.code === handlerCode);
}

/** Stripe secret key for the ctx channel, or undefined when the channel
 *  has no enabled Stripe method. A disabled method is still honoured as a
 *  last resort so an admin toggling the card method off does not orphan
 *  holds that still need capturing. */
export async function getStripeKeyForChannel(ctx: RequestContext, connection: TransactionalConnection): Promise<string | undefined> {
    const methods = (await findMethodsByHandler(connection, 'stripe')).filter(m => inChannel(m, ctx.channelId));
    const pick = methods.find(m => m.enabled && argValue(m, 'apiKey')) || methods.find(m => argValue(m, 'apiKey'));
    return pick ? argValue(pick, 'apiKey') : undefined;
}

/** Stripe secret key for an explicit channel id (cron / webhook paths). */
export async function getStripeKeyForChannelId(connection: TransactionalConnection, channelId: ID): Promise<string | undefined> {
    const methods = (await findMethodsByHandler(connection, 'stripe')).filter(m => inChannel(m, channelId));
    const pick = methods.find(m => m.enabled && argValue(m, 'apiKey')) || methods.find(m => argValue(m, 'apiKey'));
    return pick ? argValue(pick, 'apiKey') : undefined;
}

/** The channel's PaymentMethod that uses the `stripe-hold` handler.
 *  Ties are broken by `options.stripe.holdMethodCode`, then enabled first. */
export async function getHoldPaymentMethodForChannel(
    connection: TransactionalConnection, channelId: ID,
): Promise<PaymentMethod | undefined> {
    const { holdMethodCode } = effectiveStripeHoldOptions();
    const methods = (await findMethodsByHandler(connection, STRIPE_HOLD_HANDLER_CODE)).filter(m => inChannel(m, channelId));
    return methods.find(m => m.code === holdMethodCode && m.enabled)
        || methods.find(m => m.enabled)
        || methods.find(m => m.code === holdMethodCode)
        || methods[0];
}

/** Codes of every PaymentMethod (all channels) backed by the hold handler. */
export async function getHoldMethodCodes(connection: TransactionalConnection): Promise<string[]> {
    return (await findMethodsByHandler(connection, STRIPE_HOLD_HANDLER_CODE)).map(m => m.code);
}
