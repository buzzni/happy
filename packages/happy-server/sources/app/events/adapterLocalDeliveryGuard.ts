// Local-delivery guard for socket.io cluster adapters (redis-streams-adapter).
//
// socket.io-adapter's ClusterAdapter.broadcast awaits the redis publish FIRST
// and, when that publish rejects, returns from its catch WITHOUT calling
// super.broadcast — so a failing redis publish (e.g. the connection landed on
// a read-only replica → every XADD gets READONLY) or a hanging one (ioredis
// offline queue while disconnected) silently stops delivery to LOCAL sockets
// too. Every update/ephemeral room event blacks out for every client while
// direct socket emits (RPC acks) keep working. Observed in production on
// 2026-07-09: same-process user-scoped listener received 0/20 events.
//
// The wrapper makes publishAndReturnOffset always settle quickly: failures and
// hangs resolve to a dummy offset after a throttled error log, so broadcast
// falls through to local delivery. Remote replicas read the stream and would
// miss such packets — strictly better than nobody receiving them, and the
// deployment runs a single replica today.

export const ADAPTER_PUBLISH_TIMEOUT_MS = 2000;
const WARN_THROTTLE_MS = 30_000;

export function guardClusterAdapterLocalDelivery(
    adapter: unknown,
    logError: (message: string) => void,
    publishTimeoutMs: number = ADAPTER_PUBLISH_TIMEOUT_MS,
): boolean {
    const target = adapter as {
        publishAndReturnOffset?: (message: unknown) => Promise<string>;
    } | null | undefined;
    if (!target || typeof target.publishAndReturnOffset !== 'function') {
        return false;
    }
    const original = target.publishAndReturnOffset.bind(target);
    let lastWarnAt = 0;
    target.publishAndReturnOffset = async (message: unknown): Promise<string> => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        try {
            return await Promise.race([
                original(message),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(
                        () => reject(new Error(`redis publish timed out after ${publishTimeoutMs}ms`)),
                        publishTimeoutMs,
                    );
                }),
            ]);
        } catch (err) {
            const now = Date.now();
            if (now - lastWarnAt >= WARN_THROTTLE_MS) {
                lastWarnAt = now;
                const reason = err instanceof Error ? err.message : String(err);
                logError(`socket.io redis publish failed; delivering to local sockets only: ${reason}`);
            }
            return '0-0';
        } finally {
            if (timer) {
                clearTimeout(timer);
            }
        }
    };
    return true;
}
