import { vi } from 'vitest';

/**
 * Lightweight stand-ins for TransactionalConnection / OrderService /
 * RequestContextService used by the service unit tests. No database: the
 * repositories are in-memory row lists with just enough of TypeORM's
 * `findOne` / query-builder surface to satisfy the services.
 */

type Row = Record<string, any>;

function matches(row: Row, where: Row | undefined): boolean {
    if (!where) return true;
    return Object.entries(where).every(([k, v]) => String(row[k]) === String(v));
}

export class FakeQueryBuilder {
    private filters: Array<(row: Row) => boolean> = [];
    constructor(private rows: () => Row[], private override?: () => Row | null | undefined) {}
    leftJoinAndSelect() { return this; }
    leftJoin() { return this; }
    setLock() { return this; }
    orderBy() { return this; }
    limit() { return this; }
    where(expr: string, params: Row = {}) { this.filters = [this.filter(expr, params)]; return this; }
    andWhere(expr: string, params: Row = {}) { this.filters.push(this.filter(expr, params)); return this; }
    private filter(expr: string, params: Row): (row: Row) => boolean {
        const eq = expr.match(/^\w+\.(\w+)\s*=\s*:(\w+)$/);
        if (eq) return row => String(row[eq[1]]) === String(params[eq[2]]);
        const inList = expr.match(/^\w+\.(\w+)\s+IN\s*\(:\.\.\.(\w+)\)$/);
        if (inList) return row => (params[inList[2]] || []).map(String).includes(String(row[inList[1]]));
        return () => true;
    }
    async getOne(): Promise<Row | null> {
        if (this.override) {
            const o = this.override();
            if (o !== undefined) return o;
        }
        return this.rows().find(r => this.filters.every(f => f(r))) || null;
    }
    async getMany(): Promise<Row[]> {
        return this.rows().filter(r => this.filters.every(f => f(r)));
    }
}

export class FakeRepo {
    rows: Row[] = [];
    /** When set, `createQueryBuilder().getOne()` returns this instead of matching rows (undefined = fall through). */
    lockOverride?: () => Row | null | undefined;
    find = vi.fn(async (opts?: { where?: Row }) => this.rows.filter(r => matches(r, opts?.where)));
    findOne = vi.fn(async (opts?: { where?: Row }) => this.rows.find(r => matches(r, opts?.where)) || null);
    createQueryBuilder = vi.fn(() => new FakeQueryBuilder(() => this.rows, this.lockOverride));
}

export interface FakeConnectionOptions {
    /** Raw `query(sql, params)` handler; defaults to `[]`. */
    query?: (sql: string, params?: any[]) => any;
    dbType?: string;
}

export class FakeConnection {
    readonly repos = new Map<any, FakeRepo>();
    /** Chronological trace of transaction boundaries + anything tests push. */
    readonly log: string[] = [];
    readonly queries: Array<{ sql: string; params: any[] }> = [];
    readonly rawConnection: any;
    inTransaction = 0;

    constructor(opts: FakeConnectionOptions = {}) {
        this.rawConnection = {
            options: { type: opts.dbType || 'mysql' },
            getRepository: (entity: any) => this.repo(entity),
            query: vi.fn(async (sql: string, params: any[] = []) => {
                this.queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
                return opts.query ? await opts.query(sql, params) : [];
            }),
        };
    }

    repo(entity: any): FakeRepo {
        let r = this.repos.get(entity);
        if (!r) { r = new FakeRepo(); this.repos.set(entity, r); }
        return r;
    }

    getRepository(_ctx: any, entity: any): FakeRepo { return this.repo(entity); }

    withTransaction = vi.fn(async (ctx: any, fn: (ctx: any) => Promise<any>) => {
        this.inTransaction++;
        this.log.push('tx:start');
        try {
            return await fn(ctx);
        } finally {
            this.inTransaction--;
            this.log.push('tx:end');
        }
    });

    /** SQL statements run so far that match `re` (whitespace-normalised). */
    ran(re: RegExp): Array<{ sql: string; params: any[] }> { return this.queries.filter(q => re.test(q.sql)); }
}

export function fakeOrderService(conn?: FakeConnection) {
    const svc = {
        findOneByCode: vi.fn(async () => null as any),
        findOne: vi.fn(async () => null as any),
        transitionToState: vi.fn(async () => ({ state: 'ArrangingPayment' } as any)),
        addPaymentToOrder: vi.fn(async () => null as any),
        settlePayment: vi.fn(async (_ctx: any, paymentId: any) => { conn?.log.push(`settle:${paymentId}`); return { id: paymentId, state: 'Settled' } as any; }),
        cancelPayment: vi.fn(async (_ctx: any, paymentId: any) => { conn?.log.push(`cancelPayment:${paymentId}`); return { id: paymentId, state: 'Cancelled' } as any; }),
        cancelOrder: vi.fn(async (_ctx: any, input: any) => { conn?.log.push(`cancelOrder:${input.orderId}`); return { id: input.orderId, state: 'Cancelled' } as any; }),
    };
    return svc;
}

export function fakeRequestContextService(channels: Array<{ id: any; token: string; code: string }>) {
    return {
        create: vi.fn(async (input: { apiType: string; channelOrToken?: any; languageCode?: string; req?: any }) => {
            const token = typeof input.channelOrToken === 'string' ? input.channelOrToken : input.channelOrToken?.token;
            const ch = channels.find(c => c.token === token) || channels[0];
            return { apiType: input.apiType, channelId: ch?.id, channel: ch, languageCode: input.languageCode, req: input.req };
        }),
    };
}

export function fakeChannelService(channels: Array<{ id: any; token: string; code: string }>) {
    return {
        getChannelFromToken: vi.fn(async (token: string) => {
            const ch = channels.find(c => c.token === token);
            if (!ch) throw new Error('channel not found');
            return ch;
        }),
    };
}

/** An error result as `isGraphQlErrorResult` recognises it. */
export function errorResult(message: string, errorCode = 'ERROR', extra: Row = {}): any {
    return { __typename: errorCode, errorCode, message, ...extra };
}

export async function flushAsync(): Promise<void> {
    await new Promise(r => setTimeout(r, 5));
}
