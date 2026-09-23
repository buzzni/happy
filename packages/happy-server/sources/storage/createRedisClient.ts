import { Redis, type RedisOptions } from 'ioredis';
import { createLogThrottle, redisErrorCode } from '@/app/monitoring/redisHealth';
import { redisClientErrorsCounter } from '@/app/monitoring/metrics2';
import { log } from '@/utils/log';

export interface RedisClientEnv {
    REDIS_URL?: string;
    REDIS_SENTINELS?: string;
    REDIS_SENTINEL_MASTER_NAME?: string;
}

export function isRedisConfigured(env: RedisClientEnv): boolean {
    return Boolean(env.REDIS_URL) || Boolean(env.REDIS_SENTINELS && env.REDIS_SENTINEL_MASTER_NAME);
}

function parseSentinels(raw: string): Array<{ host: string; port: number }> {
    return raw.split(',').map((entry) => {
        const [host, port] = entry.trim().split(':');
        return { host, port: Number(port) };
    });
}

/**
 * A plain `REDIS_URL` connects to one fixed host. After a Sentinel failover
 * that host can become a demoted replica, and ioredis keeps retrying it
 * forever — writes fail with -READONLY with no automatic recovery (root
 * cause of the happy-server-horizontal-scale outage: the Socket.IO Redis
 * streams adapter bus went silently dead for 4h). Sentinel mode instead asks
 * the Sentinel quorum for the current master and follows +switch-master
 * events, so failover is transparent to the client.
 */
export function resolveRedisClientOptions(env: RedisClientEnv): RedisOptions | string {
    if (env.REDIS_SENTINELS && env.REDIS_SENTINEL_MASTER_NAME) {
        return {
            sentinels: parseSentinels(env.REDIS_SENTINELS),
            name: env.REDIS_SENTINEL_MASTER_NAME,
            role: 'master',
            // Belt-and-suspenders for the moment between failover and the
            // client's next sentinel resolution: force a reconnect (which
            // re-asks Sentinel for the master) instead of retrying the
            // stale connection.
            reconnectOnError(err: Error) {
                return err.message.includes('READONLY') ? 2 : false;
            },
        };
    }
    if (env.REDIS_URL) {
        return env.REDIS_URL;
    }
    throw new Error('REDIS_URL or REDIS_SENTINELS+REDIS_SENTINEL_MASTER_NAME must be set');
}

/*
 * A half-open connection never answers and never errors: with requests always
 * in flight (the streams adapter polls every 100ms) TCP keepalive does not
 * apply, and the kernel only gives up after its retransmission limit — ~17
 * minutes on 2026-09-23, during which every Redis-backed path in prod hung.
 * `commandTimeout` bounds each caller; the stall check replaces the
 * connection, because a timed-out command alone leaves it in place.
 */
export interface RedisStallTiming {
    commandTimeoutMs: number;
    stallCheckIntervalMs: number;
}

const DEFAULT_STALL_TIMING: RedisStallTiming = { commandTimeoutMs: 5_000, stallCheckIntervalMs: 5_000 };

/**
 * One timed-out PING is a slow moment, not a stall: a fork for RDB, a long
 * single-threaded command, a GC pause. The connection is still there and its
 * next command answers. Replacing it on that one late reply buys nothing and
 * costs a window in which the client is not `ready` and commands sit in the
 * offline queue until their own `commandTimeout`. A stall is silence that
 * persists, so only this many consecutive timed-out PINGs count as one.
 */
const STALL_PINGS_BEFORE_RECONNECT = 3;

export function createRedisClient(env: RedisClientEnv = process.env, timing: RedisStallTiming = DEFAULT_STALL_TIMING): Redis {
    const options = resolveRedisClientOptions(env);
    const stallOptions = {
        commandTimeout: timing.commandTimeoutMs,
        // ioredis would otherwise resend, on the next connection, every command
        // the dropped one never answered — including ones `commandTimeout`
        // already reported as failed. A caller told "failed" must not have its
        // bus message (e.g. an RPC request) delivered seconds later.
        autoResendUnfulfilledCommands: false,
    };
    const client = typeof options === 'string'
        ? new Redis(options, stallOptions)
        : new Redis({ ...options, ...stallOptions });

    // ioredis emits `error` for connection-level failures. Without a listener
    // these were entirely invisible — the server logged one Redis line in 10
    // hours while the bus was down. Command-level failures (-READONLY) do NOT
    // arrive here; those are instrumented at the call site (see
    // app/monitoring/redisHealth.ts instrumentStreamWrites).
    const shouldLog = createLogThrottle(60_000);
    client.on('error', (error: unknown) => {
        const code = redisErrorCode(error);
        redisClientErrorsCounter.inc({ code });
        if (shouldLog(code)) {
            log({ module: 'redis', level: 'error' }, `redis client error (${code}, throttled to 1/min): ${error}`);
        }
    });

    const shouldLogStall = createLogThrottle(60_000);
    let checking = false;
    let stalledPings = 0;
    const stallCheck = setInterval(() => {
        if (checking || client.status !== 'ready') return;
        checking = true;
        client.ping().then(() => {
            stalledPings = 0;
        }, (error: unknown) => {
            // Any other failure is a live connection reporting an error, or
            // one already being torn down; only silence means a stall.
            if (!(error instanceof Error && error.message === 'Command timed out') || client.status !== 'ready') {
                stalledPings = 0;
                return;
            }
            if (++stalledPings < STALL_PINGS_BEFORE_RECONNECT) return;
            stalledPings = 0;
            redisClientErrorsCounter.inc({ code: 'STALL' });
            if (shouldLogStall('stall')) {
                log({ module: 'redis', level: 'error' },
                    `redis connection stopped answering for ${timing.commandTimeoutMs}ms, ${STALL_PINGS_BEFORE_RECONNECT} pings in a row (throttled to 1/min) — reconnecting`);
            }
            // Ends the socket, destroying it after `disconnectTimeout` if the
            // peer never acknowledges; the close then reconnects (and, under
            // Sentinel, re-resolves the master).
            client.disconnect(true);
        }).finally(() => { checking = false; });
    }, timing.stallCheckIntervalMs);
    stallCheck.unref();
    client.on('end', () => clearInterval(stallCheck));

    return client;
}
