/**
 * Plan rate-limit windows from Claude's two sources, in the shape the session's agent state carries
 * (Saycode specs/cli-usage-limits-snapshot R8-a, after slopus/happy `claude/utils/usageLimits.ts`).
 *
 * - `rate_limit_event` (pushed): the one window that currently binds. `rateLimitType` may be absent,
 *   utilization is a 0-1 fraction and `resetsAt` is unix seconds.
 * - `get_usage` (pulled): every window. Utilization is 0-100, `resets_at` is ISO 8601, no status.
 *
 * Pure: the account switcher reads the same events (setupTokenUsageTracker), so nothing here keeps
 * state or changes its input.
 */
import type { UsageLimits, UsageLimitWindow, UsageLimitWindowStatus } from '@/api/types';

/** A `rate_limit_event` without a window id: it applies to whichever window currently binds. */
export type UnboundRateLimit = Omit<UsageLimitWindow, 'id' | 'status'> & { status: UsageLimitWindowStatus };

/** One turn's change, merged into agent state by the launcher. */
export type UsageLimitsPatch = {
    capturedAt: number;
    windows: UsageLimitWindow[];
    unbound?: UnboundRateLimit;
    /** A full `get_usage` snapshot: windows the provider stopped reporting are dropped, not kept with a stale status. */
    replace?: boolean;
};

export type RateLimitEventInfo = {
    status: UsageLimitWindowStatus;
    rateLimitType?: string;
    utilization?: number;
    resetsAt?: number;
};

const STATUSES = new Set<unknown>(['allowed', 'allowed_warning', 'rejected']);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const clampPercent = (value: number) => Math.min(100, Math.max(0, value));

export function synthesizeStatus(utilization: number | null | undefined): UsageLimitWindowStatus | undefined {
    if (!finite(utilization)) return undefined;
    if (utilization >= 100) return 'rejected';
    if (utilization >= 90) return 'allowed_warning';
    return 'allowed';
}

/** A fraction becomes a percent; a value already above 1 is taken as a percent (misreading ~1% as ~100% is the safe side). */
function eventPercent(utilization: number | undefined): number | null {
    if (!finite(utilization)) return null;
    return clampPercent(Math.round((utilization <= 1 ? utilization * 100 : utilization) * 10) / 10);
}

/** Unix seconds, or milliseconds should the provider switch units. A time no date can hold reads as none. */
function eventResetIso(resetsAt: number | undefined): string | null {
    if (!finite(resetsAt) || resetsAt <= 0) return null;
    const date = new Date(resetsAt < 1e12 ? resetsAt * 1000 : resetsAt);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function isoOrNull(value: unknown): string | null {
    if (typeof value !== 'string' || !value) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function windowsFromGetUsage(rateLimits: Record<string, unknown>): UsageLimitWindow[] {
    const windows: UsageLimitWindow[] = [];
    for (const [id, value] of Object.entries(rateLimits)) {
        // Overage spend, not a plan window.
        if (id === 'extra_usage' || !value || typeof value !== 'object') continue;
        if (!('utilization' in value) && !('resets_at' in value)) continue;
        const raw = value as { utilization?: unknown; resets_at?: unknown };
        const utilization = finite(raw.utilization) ? clampPercent(raw.utilization) : null;
        const status = synthesizeStatus(utilization);
        windows.push({ id, utilization, resetsAt: isoOrNull(raw.resets_at), ...(status ? { status } : {}) });
    }
    return windows;
}

/**
 * An event from a newer CLI with a status this build cannot represent says nothing (`{}`), and so does one about
 * overage: that is spend beyond the plan, which the seed leaves out too (`extra_usage`).
 */
export function fromRateLimitEvent(info: RateLimitEventInfo): { window?: UsageLimitWindow; unbound?: UnboundRateLimit } {
    if (!STATUSES.has(info.status) || info.rateLimitType === 'overage') return {};
    const reading = { status: info.status, utilization: eventPercent(info.utilization), resetsAt: eventResetIso(info.resetsAt) };
    return typeof info.rateLimitType === 'string' && info.rateLimitType ? { window: { id: info.rateLimitType, ...reading } } : { unbound: reading };
}

/** Windows from a state another build may have written: only the readable ones, as this build's shape. */
function readableWindows(current: UsageLimits | null | undefined): UsageLimitWindow[] {
    if (!Array.isArray(current?.windows)) return [];
    return current.windows.flatMap((raw: unknown) => {
        const w = raw as Partial<Record<keyof UsageLimitWindow, unknown>> | null;
        if (!w || typeof w !== 'object' || typeof w.id !== 'string' || !w.id) return [];
        const window: UsageLimitWindow = { id: w.id, utilization: finite(w.utilization) ? w.utilization : null, resetsAt: isoOrNull(w.resetsAt) };
        if (STATUSES.has(w.status)) window.status = w.status as UsageLimitWindowStatus;
        return [window];
    });
}

/**
 * Runs inside `updateAgentState`'s read-modify-write, so `current` is the latest persisted value and a
 * version-mismatch retry merges again on top of it; applying the same patch twice gives the same result.
 */
export function mergeUsageLimits(current: UsageLimits | null | undefined, patch: UsageLimitsPatch): UsageLimits {
    const windows = patch.replace ? [] : readableWindows(current);
    for (const incoming of patch.windows) {
        const index = windows.findIndex(w => w.id === incoming.id);
        if (index < 0) {
            windows.push(incoming);
            continue;
        }
        // An allowed event carries no utilization: keep the percent the seed gave, take status and reset from the event.
        windows[index] = {
            ...incoming,
            utilization: incoming.utilization ?? windows[index].utilization,
            resetsAt: incoming.resetsAt ?? windows[index].resetsAt,
        };
    }
    if (patch.unbound) {
        // No window id: apply its status and reset to the window closest to its limit rather than hide a refusal.
        let target = -1;
        for (let i = 0; i < windows.length; i++) {
            const u = windows[i].utilization;
            if (u !== null && (target < 0 || u > windows[target].utilization!)) target = i;
        }
        // Nothing to attach it to: one synthetic `plan` window, upserted rather than added every turn.
        if (target < 0) target = windows.findIndex(w => w.id === 'plan');
        const prior = target >= 0 ? windows[target] : { id: 'plan', utilization: null, resetsAt: null };
        const updated = {
            ...prior,
            status: patch.unbound.status,
            // Its percent is the binding window's, which is unknown: only the synthetic window takes it. Writing it
            // into a guessed window would also change which window the same patch picks when a write retries.
            utilization: prior.id === 'plan' ? patch.unbound.utilization ?? prior.utilization : prior.utilization,
            resetsAt: patch.unbound.resetsAt ?? prior.resetsAt,
        };
        if (target >= 0) windows[target] = updated; else windows.push(updated);
    }
    return { capturedAt: patch.capturedAt, windows };
}
