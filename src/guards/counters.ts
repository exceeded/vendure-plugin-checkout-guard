/**
 * Usage counters raised from the free-tier guards.
 *
 * The guards module never imports the plugin or a Nest service (the
 * rate-limit handler is plain Express middleware and the order-access
 * strategy is constructed by the host), so counting happens through a
 * sink the plugin installs at bootstrap (`CounterService`). Until it is
 * installed — and in unit tests — `bumpCounter` is a no-op. Never throws.
 */
export type GuardCounterName = 'rate_limit' | 'order_access_denied';

export type CounterSink = (name: GuardCounterName) => void;

let sink: CounterSink | null = null;

/** Install (or remove with `null`) the counter sink. */
export function setCounterSink(fn: CounterSink | null): void {
    sink = fn;
}

/** Fire-and-forget increment of a daily counter; synchronous and swallowed. */
export function bumpCounter(name: GuardCounterName): void {
    if (!sink) return;
    try { sink(name); } catch { /* counting must never affect a request */ }
}
