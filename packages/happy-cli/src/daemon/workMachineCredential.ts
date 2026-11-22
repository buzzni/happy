import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import { z } from 'zod';
import { replacePrivateFile } from '@/persistence';
import { credentialFileLockPath, withCredentialLock } from '@/utils/credentialLock';
import { loadOrCreateDeviceKeys, type DeviceKeys } from './deviceKeys';

const identifier = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/);
const ed25519SpkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');

export const workMachineExecutionBindingSchema = z.object({
    accountId: identifier,
    machineId: identifier,
    generation: z.number().int().min(1).max(2_147_483_647),
    deviceId: z.string().regex(/^[a-zA-Z0-9_-]{43}$/),
    serverOrigin: z.string(),
}).strict();
export type WorkMachineExecutionBinding = z.infer<typeof workMachineExecutionBindingSchema>;

const credentialSchema = z.object({
    token: z.string().startsWith('wmx_').max(4096),
    expiresAt: z.number().int().positive(),
});
export type WorkMachineCredential = z.infer<typeof credentialSchema>;
export type WorkMachineSessionCredentials = {
    sessionId: string;
    initial: WorkMachineCredential;
    renew: () => Promise<WorkMachineCredential>;
};
const bindingPath = (home: string) => join(home, 'work-machine-execution.json');

export async function readWorkMachineExecutionBinding(home: string): Promise<WorkMachineExecutionBinding | null> {
    const file = await open(bindingPath(home), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        .catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return null;
            throw new Error('Work machine execution binding is unreadable');
        });
    if (!file) return null;
    try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 2_048) {
            throw new Error('Invalid binding file');
        }
        return workMachineExecutionBindingSchema.parse(JSON.parse(await file.readFile('utf8')));
    } catch {
        throw new Error('Work machine execution binding is invalid');
    } finally {
        await file.close();
    }
}

export async function saveWorkMachineExecutionBinding(home: string, input: WorkMachineExecutionBinding): Promise<void> {
    const next = workMachineExecutionBindingSchema.parse(input);
    const path = bindingPath(home);
    await withCredentialLock(credentialFileLockPath(path), async () => {
        const current = await readWorkMachineExecutionBinding(home);
        if (current && (next.accountId !== current.accountId || next.machineId !== current.machineId
            || next.serverOrigin !== current.serverOrigin || next.deviceId !== current.deviceId
            || next.generation < current.generation)) throw new Error('Work machine execution binding conflicts with the current device');
        await replacePrivateFile(path, JSON.stringify(next));
    });
}

export class WorkMachineRenewalError extends Error {
    constructor(readonly revoked: boolean) {
        super(revoked ? 'Work machine execution authorization was rejected' : 'Work machine credential renewal failed');
    }
}

export function workMachineSigningIdentity(signingPublicKey: Uint8Array) {
    const der = Buffer.concat([ed25519SpkiPrefix, signingPublicKey]);
    return { deviceId: createHash('sha256').update(der).digest('base64url'), publicKey: der.toString('base64url') };
}

async function withDeviceKeys<T>(home: string, machineId: string, work: (keys: DeviceKeys) => T): Promise<T> {
    const keys = await loadOrCreateDeviceKeys(home, identifier.parse(machineId));
    try {
        return work(keys);
    } finally {
        keys.signing.secretKey.fill(0);
        keys.recipient.secretKey.fill(0);
    }
}

export async function getWorkMachineDeviceId(home: string, machineId: string): Promise<string> {
    return withDeviceKeys(home, machineId, keys => workMachineSigningIdentity(keys.signing.publicKey).deviceId);
}

export async function prepareWorkMachineDevice(home: string, machineId: string) {
    let sessionIds: string[] = [];
    const inventory = await open(join(home, 'sessions.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        .catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return null;
            throw new Error('Work machine session inventory is unreadable');
        });
    if (inventory) {
        try {
            const stat = await inventory.stat();
            if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.()
                || (stat.mode & 0o077) !== 0 || stat.size > 64 * 1024 ** 2) throw new Error();
            const stored = z.object({
                sessions: z.record(identifier, z.unknown()),
                corruptStoreBackup: z.never().optional(),
                preparedMachineLaunches: z.record(z.string(), z.unknown()).optional(),
            }).parse(JSON.parse(await inventory.readFile('utf8')));
            sessionIds = Object.keys(stored.sessions).sort();
            if (sessionIds.length > 5000 || Object.keys(stored.preparedMachineLaunches ?? {}).length > 0) throw new Error();
        } catch {
            throw new Error('Work machine session inventory is invalid or incomplete');
        } finally {
            await inventory.close();
        }
    }
    return withDeviceKeys(home, machineId, keys => {
        const { deviceId, publicKey } = workMachineSigningIdentity(keys.signing.publicKey);
        const issuedAt = Date.now();
        const message = Buffer.from(JSON.stringify(['happy-work-machine-enrollment-v2', machineId, deviceId, issuedAt, sessionIds]));
        const signature = Buffer.from(nacl.sign.detached(message, keys.signing.secretKey)).toString('base64url');
        return { machineId, deviceId, sessionIds, proof: { publicKey, issuedAt, signature } };
    });
}

export async function openWorkMachineCredentials(
    home: string, serverUrl: string, configuredBinding: WorkMachineExecutionBinding, request: typeof fetch = fetch,
) {
    const { machineId, accountId, generation, deviceId, serverOrigin } = workMachineExecutionBindingSchema.parse(configuredBinding);
    const url = new URL(serverUrl);
    if (url.origin !== serverOrigin || url.pathname !== '/' || url.search || url.hash || url.username || url.password || (url.protocol !== 'https:'
        && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
        throw new Error('Work machine execution authorization belongs to a different or insecure Happy server');
    }
    if (await getWorkMachineDeviceId(home, machineId) !== deviceId) {
        throw new Error('Work machine execution authorization belongs to a different device');
    }
    const endpoint = `${url.origin}/v1/work-machines/${machineId}/execution-renewal`;
    return {
        async renew(sessionId?: string): Promise<WorkMachineCredential> {
            if (sessionId !== undefined) identifier.parse(sessionId);
            const issuedAt = Date.now();
            const nonce = randomUUID();
            const { publicKey, signature } = await withDeviceKeys(home, machineId, keys => {
                const identity = workMachineSigningIdentity(keys.signing.publicKey);
                if (identity.deviceId !== deviceId) throw new WorkMachineRenewalError(true);
                const message = Buffer.from(JSON.stringify([
                    'happy-work-machine-renew-v1', accountId, machineId, deviceId, generation, sessionId ?? null, issuedAt, nonce,
                ]));
                return {
                    publicKey: identity.publicKey,
                    signature: Buffer.from(nacl.sign.detached(message, keys.signing.secretKey)).toString('base64url'),
                };
            });
            let reply: Response;
            try {
                reply = await request(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        accountId, deviceId, generation, ...(sessionId ? { sessionId } : {}), issuedAt, nonce, publicKey, signature,
                    }),
                    signal: AbortSignal.timeout(8_000),
                    redirect: 'error',
                });
            } catch {
                throw new WorkMachineRenewalError(false);
            }
            if (!reply.ok) {
                await reply.body?.cancel();
                throw new WorkMachineRenewalError(reply.status === 403);
            }
            const parsed = credentialSchema.safeParse(await reply.json().catch(() => null));
            if (!parsed.success || parsed.data.expiresAt <= Date.now() || parsed.data.expiresAt > issuedAt + 310_000) {
                throw new WorkMachineRenewalError(false);
            }
            return parsed.data;
        },
    };
}

export async function openWorkMachineSessionCredentials(
    home: string, serverUrl: string, sessionId: string | undefined, request?: typeof fetch,
): Promise<WorkMachineSessionCredentials | null> {
    const binding = await readWorkMachineExecutionBinding(home);
    if (!binding) return null;
    if (!sessionId) throw new Error('Work machine provider startup requires an existing session');
    const device = await openWorkMachineCredentials(home, serverUrl, binding, request);
    const renew = () => device.renew(sessionId);
    return { sessionId, initial: await renew(), renew };
}

export function watchWorkMachineCredential(input: {
    initial: WorkMachineCredential;
    renew: () => Promise<WorkMachineCredential>;
    apply: (credential: WorkMachineCredential) => void;
    stop: (reason: 'revoked' | 'expired') => void;
    retrying: () => void;
}): () => void {
    let current = input.initial;
    let disposed = false;
    let refreshTimer: NodeJS.Timeout | undefined;
    let expiryTimer: NodeJS.Timeout | undefined;
    const dispose = () => {
        disposed = true;
        clearTimeout(refreshTimer);
        clearTimeout(expiryTimer);
    };
    const stop = (reason: 'revoked' | 'expired') => {
        if (disposed) return;
        dispose();
        input.stop(reason);
    };
    const refresh = async () => {
        let next: WorkMachineCredential;
        try {
            next = await input.renew();
            if (next.expiresAt <= current.expiresAt) throw new WorkMachineRenewalError(false);
        } catch (error) {
            if (disposed) return;
            if (error instanceof WorkMachineRenewalError && error.revoked) return stop('revoked');
            input.retrying();
            refreshTimer = setTimeout(() => void refresh(), 5_000).unref();
            return;
        }
        if (disposed) return;
        if (Date.now() >= current.expiresAt) return stop('expired');
        current = next;
        input.apply(next);
        schedule();
    };
    const schedule = () => {
        clearTimeout(expiryTimer);
        expiryTimer = setTimeout(() => stop('expired'), current.expiresAt - Date.now()).unref();
        refreshTimer = setTimeout(() => void refresh(), Math.max(0, current.expiresAt - Date.now() - 60_000)).unref();
    };
    schedule();
    return dispose;
}
