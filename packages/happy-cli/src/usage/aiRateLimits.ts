/**
 * The run account's five-hour and weekly rate-limit windows, in the shape a usage
 * event carries (aplus specs/org-member-ai-plan-usage P10).
 *
 * Nothing is fetched for this: Claude's windows are what the session already
 * holds from `rate_limit_event` / `get_usage` (src/claude/utils/usageLimits.ts),
 * Codex's are the `account/rateLimits/updated` notifications its app-server sends.
 * Model-specific windows (`seven_day_opus`, …) are not the account limit and are left out.
 */
import type { UsageRateLimitsV1, UsageRateLimitWindowV1 } from '@slopus/happy-wire';
import type { UsageLimits } from '@/api/types';

const FIVE_HOUR_MINUTES = 300;
const WEEK_MINUTES = 7 * 24 * 60;

function percent(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null;
}

function withWindows(fiveHour: UsageRateLimitWindowV1 | null, weekly: UsageRateLimitWindowV1 | null): UsageRateLimitsV1 | null {
    if (!fiveHour && !weekly) return null;
    return { ...(fiveHour ? { fiveHour } : {}), ...(weekly ? { weekly } : {}) };
}

export function claudeRateLimits(limits: UsageLimits | null | undefined): UsageRateLimitsV1 | null {
    const window = (id: string): UsageRateLimitWindowV1 | null => {
        const found = limits?.windows.find((candidate) => candidate.id === id);
        const usedPercent = percent(found?.utilization);
        if (!found || usedPercent === null) return null;
        const resetsAt = found.resetsAt ? Date.parse(found.resetsAt) : NaN;
        return { usedPercent, resetsAt: Number.isFinite(resetsAt) ? resetsAt : null };
    };
    return withWindows(window('five_hour'), window('seven_day'));
}

/** `rateLimits` of Codex's `account/rateLimits/updated` (`RateLimitSnapshot` in its v2 protocol). */
export function codexRateLimits(snapshot: unknown): UsageRateLimitsV1 | null {
    const raw = (snapshot ?? {}) as { primary?: unknown; secondary?: unknown };
    const read = (value: unknown) => {
        const window = value as { usedPercent?: unknown; windowDurationMins?: unknown; resetsAt?: unknown } | null | undefined;
        const usedPercent = percent(window?.usedPercent);
        if (!window || usedPercent === null) return null;
        // Unix seconds, or milliseconds should Codex switch units.
        const resetsAt = typeof window.resetsAt === 'number' && Number.isFinite(window.resetsAt) && window.resetsAt > 0
            ? (window.resetsAt < 1e12 ? window.resetsAt * 1000 : window.resetsAt)
            : null;
        return { minutes: window.windowDurationMins, value: { usedPercent, resetsAt } };
    };
    const windows = [read(raw.primary), read(raw.secondary)];
    const byDuration = (minutes: number) => windows.find((window) => window?.minutes === minutes)?.value ?? null;
    const knownDurations = windows.some((window) => typeof window?.minutes === 'number');
    if (knownDurations) return withWindows(byDuration(FIVE_HOUR_MINUTES), byDuration(WEEK_MINUTES));
    return withWindows(windows[0]?.value ?? null, windows[1]?.value ?? null);
}
