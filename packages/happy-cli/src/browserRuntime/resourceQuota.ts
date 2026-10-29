/** Browser-local resource admission. No allocation, eviction, or authority is owned here. */
export interface BrowserResources {
    version: 1
    hostAvailableBytes: number
    memoryLimitBytes: number
    memoryUsedBytes: number
    cpuLimit: number
    pidsLimit: number
    pidsUsed: number
    /** cgroup cumulative usage; optional on older samplers. */
    cpuUsageUsec?: number
}
export interface QuotaReading {
    limit: number
    mode: 'automatic'
    reason: 'resources-available' | 'resource-pressure' | 'measurement-unavailable' | 'stabilizing'
    sampledAtMs?: number
}
const MiB = 1024 * 1024
export const RESOURCE_QUOTA_CEILING = 16
const WINDOW_BYTES = 256 * MiB
const BROWSER_RESERVE = 256 * MiB
const HOST_RESERVE = 2 * 1024 * MiB
const STALE_MS = 30_000
const INTERVAL_MS = 10_000
function valid(value: unknown): value is BrowserResources {
    if (!value || typeof value !== 'object') return false
    const r = value as BrowserResources
    return r.version === 1 && ['hostAvailableBytes', 'memoryLimitBytes', 'memoryUsedBytes', 'cpuLimit', 'pidsLimit', 'pidsUsed']
        .every(k => Number.isFinite(r[k as keyof BrowserResources]) && Number(r[k as keyof BrowserResources]) >= 0)
        && r.memoryLimitBytes > 0 && r.cpuLimit > 0 && r.pidsLimit > 0
        && (r.cpuUsageUsec === undefined || (Number.isFinite(r.cpuUsageUsec) && r.cpuUsageUsec >= 0))
}
/** Samples are timestamped by the runtime when received, not by the remote browser clock. */
export class ResourceQuota {
    private sample?: BrowserResources
    private sampledAt?: number
    private growthAt?: number
    private lastSafeLimit?: number
    private growth: number
    private cpuBusy = false
    private sampledWindows = 0
    constructor(private readonly fallback: number) { this.growth = fallback }
    observe(value: unknown, now: number, windows = 0): void {
        if (!valid(value)) { this.sample = undefined; this.growthAt = undefined; this.growth = Math.min(this.fallback, this.lastSafeLimit ?? this.fallback); this.cpuBusy = false; return }
        const elapsed = this.sampledAt === undefined ? 0 : now - this.sampledAt
        this.cpuBusy = Boolean(this.sample?.cpuUsageUsec !== undefined && value.cpuUsageUsec !== undefined && elapsed > 0
            && (value.cpuUsageUsec - this.sample.cpuUsageUsec) / (elapsed * 1000 * value.cpuLimit) >= 0.9)
        const continuous = this.sample && elapsed >= 0 && elapsed <= STALE_MS
            && !(this.sample.cpuUsageUsec !== undefined && value.cpuUsageUsec !== undefined && value.cpuUsageUsec < this.sample.cpuUsageUsec)
        if (!continuous || this.cpuBusy) {
            this.growth = Math.min(this.fallback, this.lastSafeLimit ?? this.fallback)
            this.growthAt = now
        } else if (now - (this.growthAt ?? now) >= INTERVAL_MS) {
            this.growth = Math.min(RESOURCE_QUOTA_CEILING, this.growth + 2)
            this.growthAt = now
        }
        this.sample = value; this.sampledAt = now; this.sampledWindows = windows
        this.growth = Math.min(this.growth, this.read(now, windows, 0).limit)
    }
    /** otherReservations includes other profiles' allocated/empty spaces, conservatively reserved again. */
    read(now: number, windows: number, otherReservations: number): QuotaReading {
        if (!this.sample || this.sampledAt === undefined || now < this.sampledAt || now - this.sampledAt > STALE_MS)
            return { limit: Math.min(this.fallback, this.lastSafeLimit ?? this.fallback), mode: 'automatic', reason: 'measurement-unavailable', ...(this.sampledAt !== undefined ? { sampledAtMs: this.sampledAt } : {}) }
        const r = this.sample
        const headroom = Math.max(0, Math.min(
            Math.floor((r.memoryLimitBytes - r.memoryUsedBytes - BROWSER_RESERVE) / WINDOW_BYTES),
            Math.floor((r.hostAvailableBytes - HOST_RESERVE) / WINDOW_BYTES) - otherReservations,
            Math.floor((r.pidsLimit - r.pidsUsed - 16) / 8),
        ))
        const bound = Math.max(0, Math.min(RESOURCE_QUOTA_CEILING,
            Math.floor((r.memoryLimitBytes - BROWSER_RESERVE) / WINDOW_BYTES), Math.floor(r.cpuLimit * 4),
            Math.min(windows, this.sampledWindows) + (this.cpuBusy ? 0 : headroom)))
        const limit = Math.min(this.growth, bound)
        this.lastSafeLimit = limit
        return { limit, mode: 'automatic', sampledAtMs: this.sampledAt,
            reason: this.cpuBusy || headroom === 0 ? 'resource-pressure' : this.growth < bound ? 'stabilizing' : 'resources-available' }
    }
}

/** Preferences survive restart but never profile reassignment. A profile is shared across its owner's organizations. */
export const quotaPreferenceKey = (profileId: string, principalId: string, assignmentId?: string): string => JSON.stringify([profileId, principalId, assignmentId ?? ''])

/** Legacy images keep fixed limits; telemetry loss after pressure must not reopen admission. */
export function resourceAdmissionLimit(reading: QuotaReading | undefined, fixed: number): number {
    return !reading || (reading.reason === 'measurement-unavailable' && reading.sampledAtMs === undefined) ? fixed : reading.limit
}
