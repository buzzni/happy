import { createHmac } from 'node:crypto';
import { AiUsageEventV1Schema, type AiUsageEventV1 } from '@slopus/happy-wire';
import { db } from '@/storage/db';
import { log } from '@/utils/log';

const DELIVERY_LEASE_MS = 30_000;
const BASE_RETRY_MS = 60_000;
const MAX_RETRY_MS = 60 * 60_000;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_REQUEST_TIMEOUT_MS = 25_000;

export type UsageOutboxItem = {
    id: string;
    attemptCount: number;
    event: AiUsageEventV1;
};

export interface UsageOutboxRepository {
    claimDue(now: Date, leaseUntil: Date, limit: number): Promise<UsageOutboxItem[]>;
    markDelivered(id: string, leaseUntil: Date, deliveredAt: Date): Promise<boolean>;
    markFailed(
        id: string,
        leaseUntil: Date,
        attemptCount: number,
        nextAttemptAt: Date,
        error: string,
    ): Promise<boolean>;
}

type UsageFetch = (
    input: string,
    init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number }>;

export function createPrismaUsageOutboxRepository(): UsageOutboxRepository {
    return {
        async claimDue(now, leaseUntil, limit) {
            const due = await db.usageDeliveryOutbox.findMany({
                where: {
                    OR: [
                        { status: 'pending', nextAttemptAt: { lte: now } },
                        { status: 'delivering', leaseUntil: { lte: now } },
                    ],
                },
                orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }],
                take: limit,
                include: { usageEvent: { select: { data: true } } },
            });

            const claimed: UsageOutboxItem[] = [];
            for (const candidate of due) {
                const result = await db.usageDeliveryOutbox.updateMany({
                    where: {
                        id: candidate.id,
                        OR: [
                            { status: 'pending', nextAttemptAt: { lte: now } },
                            { status: 'delivering', leaseUntil: { lte: now } },
                        ],
                    },
                    data: { status: 'delivering', leaseUntil },
                });
                if (result.count !== 1) continue;
                claimed.push({
                    id: candidate.id,
                    attemptCount: candidate.attemptCount,
                    event: AiUsageEventV1Schema.parse(candidate.usageEvent.data),
                });
            }
            return claimed;
        },

        async markDelivered(id, leaseUntil, deliveredAt) {
            const result = await db.usageDeliveryOutbox.updateMany({
                where: { id, status: 'delivering', leaseUntil },
                data: {
                    status: 'delivered',
                    deliveredAt,
                    leaseUntil: null,
                    lastError: null,
                },
            });
            return result.count === 1;
        },

        async markFailed(id, leaseUntil, attemptCount, nextAttemptAt, error) {
            const result = await db.usageDeliveryOutbox.updateMany({
                where: { id, status: 'delivering', leaseUntil },
                data: {
                    status: 'pending',
                    attemptCount,
                    nextAttemptAt,
                    leaseUntil: null,
                    lastError: error,
                },
            });
            return result.count === 1;
        },
    };
}

export async function deliverUsageOutboxBatch(input: {
    repository: UsageOutboxRepository;
    fetchImpl: UsageFetch;
    endpoint: string;
    secret: string;
    now?: Date;
    limit?: number;
    requestTimeoutMs?: number;
}): Promise<{ claimed: number; delivered: number; failed: number; leaseLost: number }> {
    const currentTime = () => input.now ?? new Date();
    const limit = input.limit ?? DEFAULT_BATCH_SIZE;
    let claimed = 0;
    let delivered = 0;
    let failed = 0;
    let leaseLost = 0;

    for (let index = 0; index < limit; index += 1) {
        const claimTime = currentTime();
        const leaseUntil = new Date(claimTime.getTime() + DELIVERY_LEASE_MS);
        const [item] = await input.repository.claimDue(claimTime, leaseUntil, 1);
        if (!item) break;
        claimed += 1;

        const body = JSON.stringify(item.event);
        const timestamp = String(Math.floor(currentTime().getTime() / 1000));
        const signature = createHmac('sha256', input.secret)
            .update(`${timestamp}.${body}`)
            .digest('hex');
        const controller = new AbortController();
        const timeout = setTimeout(
            () => controller.abort(),
            input.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        );
        timeout.unref();
        try {
            let response: { ok: boolean; status: number };
            try {
                response = await input.fetchImpl(input.endpoint, {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        'x-saycode-usage-event-id': item.event.sourceEventId,
                        'x-saycode-usage-signature': `v1=${signature}`,
                        'x-saycode-usage-timestamp': timestamp,
                    },
                    body,
                    signal: controller.signal,
                });
            } finally {
                clearTimeout(timeout);
            }
            if (!response.ok) {
                const error = new Error(`HTTP ${response.status}`);
                error.name = 'UsageDeliveryHttpError';
                throw error;
            }
            if (await input.repository.markDelivered(item.id, leaseUntil, currentTime())) delivered += 1;
            else leaseLost += 1;
        } catch (error) {
            const failedAt = currentTime();
            const attemptCount = item.attemptCount + 1;
            const retryMs = Math.min(BASE_RETRY_MS * (2 ** Math.min(item.attemptCount, 10)), MAX_RETRY_MS);
            const safeError = error instanceof Error && error.name === 'UsageDeliveryHttpError'
                ? error.message
                : 'network-error';
            if (await input.repository.markFailed(
                item.id,
                leaseUntil,
                attemptCount,
                new Date(failedAt.getTime() + retryMs),
                safeError,
            )) failed += 1;
            else leaseLost += 1;
        }
    }

    return { claimed, delivered, failed, leaseLost };
}

export function startUsageOutboxWorker(input: {
    endpoint: string;
    secret: string;
    intervalMs?: number;
    repository?: UsageOutboxRepository;
    fetchImpl?: UsageFetch;
}): { stop(): void; runOnce(): Promise<void> } {
    const repository = input.repository ?? createPrismaUsageOutboxRepository();
    const fetchImpl = input.fetchImpl ?? (fetch as UsageFetch);
    let running = false;

    const runOnce = async () => {
        if (running) return;
        running = true;
        try {
            const result = await deliverUsageOutboxBatch({
                repository,
                fetchImpl,
                endpoint: input.endpoint,
                secret: input.secret,
            });
            if (result.failed > 0) {
                log({ module: 'usage-outbox', level: 'warn' },
                    `Usage delivery batch had ${result.failed} retryable failure(s)`);
            }
            if (result.leaseLost > 0) {
                log({ module: 'usage-outbox', level: 'warn' },
                    `Usage delivery batch lost ${result.leaseLost} lease(s) before persistence`);
            }
        } catch (error) {
            log({ module: 'usage-outbox', level: 'error' }, `Usage delivery worker failed: ${error}`);
        } finally {
            running = false;
        }
    };

    const timer = setInterval(() => void runOnce(), input.intervalMs ?? 5_000);
    timer.unref();
    void runOnce();
    return {
        stop: () => clearInterval(timer),
        runOnce,
    };
}
