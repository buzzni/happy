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

export function createRedisClient(env: RedisClientEnv = process.env): Redis {
    const options = resolveRedisClientOptions(env);
    const client = typeof options === 'string' ? new Redis(options) : new Redis(options);

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

    return client;
}
