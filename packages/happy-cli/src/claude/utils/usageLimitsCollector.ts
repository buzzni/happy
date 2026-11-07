/**
 * Collects one Claude query's plan rate-limit readings into at most one agent-state patch per turn
 * (Saycode specs/cli-usage-limits-snapshot R8-b, R8-d).
 *
 * `rate_limit_event`s are buffered and taken at each result. The first result also seeds every window
 * from `get_usage` — the query has nothing to ask before its first turn — and that patch replaces the
 * stored windows, so a provider restarted on another account does not keep the previous one's. A turn
 * whose readings would not change what this query already published publishes nothing.
 *
 * Lives as long as the query (one `claudeRemote` run). Never blocks the turn: the seed is bounded and
 * every failure only drops that reading.
 */
import { logger } from '@/ui/logger';
import type { UsageLimits, UsageLimitWindow } from '@/api/types';
import { fromRateLimitEvent, mergeUsageLimits, windowsFromGetUsage, type RateLimitEventInfo, type UnboundRateLimit, type UsageLimitsPatch } from './usageLimits';

const SEED_TIMEOUT_MS = 10_000;
const USAGE_METHOD = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET';

/**
 * The query's `get_usage` without the seven-day transcript scan (the `/btw` side question asks the same
 * way). Experimental in the SDK, so checked at runtime: without it there is no seed, only events.
 */
export function usageReaderOf(query: unknown): (() => Promise<unknown>) | null {
    const read = (query as Record<string, unknown> | null)?.[USAGE_METHOD];
    return typeof read === 'function' ? () => read.call(query, { skipBehaviors: true }) : null;
}

/** Field by field: an event and the seed spell the same window with keys in a different order. */
const signature = (limits: UsageLimits) => JSON.stringify(limits.windows.map(w => [w.id, w.status ?? null, w.utilization, w.resetsAt]));

export function createUsageLimitsCollector(deps: {
    readUsage: (() => Promise<unknown>) | null;
    publish: (patch: UsageLimitsPatch) => void;
    now?: () => number;
}) {
    const now = deps.now ?? Date.now;
    let pendingWindows = new Map<string, UsageLimitWindow>();
    let pendingUnbound: UnboundRateLimit | undefined;
    let seeded = false;
    /** What this query's published patches add up to; a patch that leaves it unchanged is not sent. */
    let published: UsageLimits | null = null;
    let chain: Promise<void> = Promise.resolve();

    const seed = async (): Promise<UsageLimitWindow[] | null> => {
        if (!deps.readUsage) return null;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const usage = await Promise.race([
                deps.readUsage(),
                new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), SEED_TIMEOUT_MS); }),
            ]) as { rate_limits_available?: unknown; rate_limits?: unknown } | null;
            if (usage?.rate_limits_available !== true || !usage.rate_limits || typeof usage.rate_limits !== 'object') return null;
            return windowsFromGetUsage(usage.rate_limits as Record<string, unknown>);
        } catch (error) {
            // Unavailable for API key / Bedrock / Vertex sessions, or the query already closed.
            logger.debug('[usageLimits] get_usage seed failed (ignored)', error);
            return null;
        } finally {
            clearTimeout(timer);
        }
    };

    const flush = async (windows: Map<string, UsageLimitWindow>, unbound: UnboundRateLimit | undefined) => {
        let replace = false;
        if (!seeded) {
            seeded = true;
            const seededWindows = await seed();
            // A full answer replaces the stored windows even when it lists none: they were the previous account's.
            replace = seededWindows !== null;
            for (const window of seededWindows ?? []) {
                const event = windows.get(window.id);
                // The turn's event is fresher, but an allowed one carries no percent and some no reset: take the seed's.
                windows.set(window.id, event ? { ...event, utilization: event.utilization ?? window.utilization, resetsAt: event.resetsAt ?? window.resetsAt } : window);
            }
        }
        if (windows.size === 0 && !unbound && !replace) return;
        const patch: UsageLimitsPatch = { capturedAt: now(), windows: [...windows.values()], ...(unbound ? { unbound } : {}), ...(replace ? { replace } : {}) };
        const next = mergeUsageLimits(published, patch);
        if (published && signature(next) === signature(published)) return;
        deps.publish(patch);
        published = next;
    };

    return {
        observe(message: unknown): void {
            const event = message as { type?: unknown; rate_limit_info?: RateLimitEventInfo } | null;
            if (event?.type !== 'rate_limit_event' || !event.rate_limit_info) return;
            const reading = fromRateLimitEvent(event.rate_limit_info);
            if (reading.window) pendingWindows.set(reading.window.id, reading.window);
            if (reading.unbound) pendingUnbound = reading.unbound;
        },
        /**
         * Takes this turn's events now — later ones belong to the next turn — and publishes after any
         * earlier turn's, so a pending seed cannot reorder or mix two turns' patches.
         */
        turnEnded(): Promise<void> {
            const windows = pendingWindows, unbound = pendingUnbound;
            pendingWindows = new Map();
            pendingUnbound = undefined;
            chain = chain.then(() => flush(windows, unbound)).catch((error) => {
                logger.debug('[usageLimits] publish failed (ignored)', error);
            });
            return chain;
        },
    };
}
