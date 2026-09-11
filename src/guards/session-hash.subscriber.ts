import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { EventBus, Logger, Order, OrderEvent, TransactionalConnection } from '@vendure/core';
import { Subscription } from 'rxjs';
import { GUARDS_LOGGER_CTX } from './constants';
import { CG_SESSION_HASH_FIELD, decideSessionHashWrite, readStoredSessionHash } from './session-hash';

/**
 * Stores `sha256(session token)` on every order created through the Shop API
 * so `SessionBoundOrderByCodeAccessStrategy` can later match the placing
 * session. Register as a provider of the plugin module.
 *
 * Writes go straight to the Order repository (no `OrderEvent` is re-published)
 * so the subscriber cannot feed itself, and other subscribers see no noise.
 */
@Injectable()
export class SessionHashSubscriber implements OnApplicationBootstrap, OnModuleDestroy {
    private subscription: Subscription | undefined;

    constructor(
        private readonly eventBus: EventBus,
        private readonly connection: TransactionalConnection,
    ) {}

    onApplicationBootstrap(): void {
        this.subscription = this.eventBus.ofType(OrderEvent).subscribe(event => {
            this.handle(event).catch(err => {
                const message = err instanceof Error ? err.message : String(err);
                Logger.error(
                    `Could not bind order ${event.entity?.id ?? '?'} to its session: ${message}`,
                    GUARDS_LOGGER_CTX,
                );
            });
        });
    }

    onModuleDestroy(): void {
        this.subscription?.unsubscribe();
        this.subscription = undefined;
    }

    /** Returns `true` when a hash was written. Exposed for tests / hosts. */
    async handle(event: OrderEvent): Promise<boolean> {
        const order = event.entity;
        if (!order || order.id === undefined || order.id === null) return false;
        const hash = decideSessionHashWrite({
            apiType: event.ctx.apiType,
            type: event.type,
            existingHash: readStoredSessionHash(order),
            sessionToken: event.ctx.session?.token,
        });
        if (!hash) return false;
        await this.connection
            .getRepository(event.ctx, Order)
            .update({ id: order.id }, { customFields: { [CG_SESSION_HASH_FIELD]: hash } } as any);
        if (order.customFields && typeof order.customFields === 'object') {
            (order.customFields as Record<string, unknown>)[CG_SESSION_HASH_FIELD] = hash;
        }
        Logger.debug(`Order ${order.id} bound to session ${hash.slice(0, 12)}…`, GUARDS_LOGGER_CTX);
        return true;
    }
}
