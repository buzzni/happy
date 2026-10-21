// Shared reader health for the bus reader fence: each replica records, in a
// small Redis hash, when its own stream reader last succeeded. A replica only
// fences itself when some other replica is reading fine, so a problem that
// stalls every reader (shared Redis egress throttling) never drains them all.

export const BUS_READER_HEALTH_KEY = 'happy:bus:reader-health:account';
const FRESH_MS = 15_000;
const STALE_MS = 60 * 60_000;

function readAt(value: string | undefined): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function countHealthyPeerReaders(entries: Record<string, string>, selfId: string, now: number, freshMs = FRESH_MS): number {
    let healthy = 0;
    for (const [id, value] of Object.entries(entries)) {
        if (id === selfId) continue;
        const at = readAt(value);
        if (at > 0 && now - at <= freshMs) healthy += 1;
    }
    return healthy;
}

export function staleReaderFields(entries: Record<string, string>, selfId: string, now: number, staleMs = STALE_MS): string[] {
    return Object.entries(entries)
        .filter(([id, value]) => id !== selfId && (readAt(value) === 0 || now - readAt(value) > staleMs))
        .map(([id]) => id);
}
