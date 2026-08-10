import type { Socket } from 'socket.io';
import {
    ackAutomationSync,
    claimAutomationRun,
    heartbeatAutomationRun,
    registerAutomationMachineKey,
    reportAutomationRun,
    startAutomationRun,
    syncAutomations,
} from '@/app/automation/automationExecutionService';
import { inTx } from '@/storage/inTx';

type Callback = (response: { ok: boolean; value?: unknown; error?: string }) => void;

function requiredString(value: unknown): string {
    if (typeof value !== 'string' || value.length === 0) throw new Error('invalid-input');
    return value;
}

function integer(value: unknown, min: number, max: number): number {
    if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new Error('invalid-input');
    return value as number;
}

function bytes(value: unknown, maxBytes: number, exactBytes?: number): Uint8Array<ArrayBuffer> {
    const raw = new Uint8Array(Buffer.from(requiredString(value), 'base64'));
    if (raw.byteLength > maxBytes || (exactBytes !== undefined && raw.byteLength !== exactBytes)) throw new Error('invalid-input');
    return raw;
}

function wire(value: unknown): unknown {
    if (typeof value === 'bigint') return value.toString();
    if (value instanceof Date) return value.getTime();
    if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
    if (Array.isArray(value)) return value.map(wire);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, wire(item)]));
    }
    return value;
}

async function answer(callback: Callback, operation: () => Promise<{ ok: boolean; value?: unknown; error?: string }>) {
    try {
        const result = await operation();
        callback(result.ok ? { ok: true, value: wire(result.value) } : { ok: false, error: result.error });
    } catch {
        callback({ ok: false, error: 'invalid-input' });
    }
}

export function automationSocketHandler(accountId: string, machineId: string, socket: Socket): void {
    const on = (event: string, handler: (data: any, callback: Callback) => Promise<void>) => (socket as any).on(event, handler);

    on('automation-key-register', async (data, callback) => answer(callback, () => inTx((tx) => registerAutomationMachineKey(tx, accountId, machineId, {
        expectedKeyVersion: integer(data?.expectedKeyVersion, 0, Number.MAX_SAFE_INTEGER),
        publicKey: bytes(data?.publicKey, 32, 32),
    }))));

    on('automation-sync', async (data, callback) => answer(callback, () => {
        const afterSeq = BigInt(requiredString(data?.afterSeq));
        if (afterSeq < 0n) throw new Error('invalid-input');
        return inTx((tx) => syncAutomations(tx, accountId, machineId, {
            afterSeq,
            limit: integer(data?.limit, 1, 500),
        }));
    }));

    on('automation-sync-ack', async (data, callback) => answer(callback, () => {
        if (!Array.isArray(data?.items) || data.items.length > 500) throw new Error('invalid-input');
        const items = data.items.map((item: any) => ({
            automationId: requiredString(item?.automationId),
            revision: integer(item?.revision, 1, Number.MAX_SAFE_INTEGER),
        }));
        return inTx((tx) => ackAutomationSync(tx, accountId, machineId, items));
    }));

    on('automation-claim', async (data, callback) => answer(callback, () => inTx((tx) => claimAutomationRun(tx, accountId, machineId, {
        automationId: requiredString(data?.automationId),
        generation: integer(data?.generation, 1, Number.MAX_SAFE_INTEGER),
        scheduledFor: new Date(integer(data?.scheduledFor, 0, Number.MAX_SAFE_INTEGER)),
    }))));

    on('automation-run-start', async (data, callback) => answer(callback, () => inTx((tx) => startAutomationRun(tx, accountId, machineId, {
        runId: requiredString(data?.runId), claimToken: requiredString(data?.claimToken),
    }))));

    on('automation-run-heartbeat', async (data, callback) => answer(callback, () => inTx((tx) => heartbeatAutomationRun(tx, accountId, machineId, {
        runId: requiredString(data?.runId), claimToken: requiredString(data?.claimToken),
    }))));

    on('automation-run-report', async (data, callback) => answer(callback, () => {
        const status = data?.status === 'COMPLETED' || data?.status === 'FAILED' ? data.status : null;
        const outcomes = ['WOKE', 'SILENT', 'SKIPPED_GATE', 'ERROR'] as const;
        const outcome = outcomes.find((candidate) => candidate === data?.outcome);
        if (!status || !outcome) throw new Error('invalid-input');
        return inTx((tx) => reportAutomationRun(tx, accountId, machineId, {
            runId: requiredString(data?.runId),
            claimToken: requiredString(data?.claimToken),
            reportId: requiredString(data?.reportId),
            status,
            outcome,
            sessionId: data?.sessionId === null ? null : requiredString(data?.sessionId),
            detailCiphertext: data?.detailCiphertext === null ? null : bytes(data?.detailCiphertext, 128 * 1024),
        }));
    }));
}
