/**
 * The CLI side of the Studio work machine transfer API (aplus-dev-studio specs/work-machine-migration
 * plan 5.6) and the presigned object transfers it hands out.
 *
 * Every Studio request carries the job's `wmt_` transfer token. Part transfers are retried with
 * exponential backoff, each attempt on a freshly presigned URL (they expire within 15 minutes).
 * An integrity mismatch is never retried: the same object would fail the same way.
 * Errors name the step and status only; URLs and tokens are credentials.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { getCheckpointObject } from '@/managed/checkpoint/managedCheckpointObjectStore';

export const workMachineIdentifier = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const deviceProofSchema = z.object({
    issuedAt: z.number().int().positive(),
    publicKey: z.string().regex(/^[A-Za-z0-9_-]+$/).max(200),
    signature: z.string().regex(/^[A-Za-z0-9_-]+$/).max(200),
}).strict();
export type WorkMachineDeviceProof = z.infer<typeof deviceProofSchema>;

const planSchema = z.object({
    jobId: workMachineIdentifier,
    machineId: workMachineIdentifier,
    generation: z.number().int().min(1).max(2_147_483_647),
    archiveVersion: z.union([z.number().int().nonnegative(), workMachineIdentifier]),
    approval: z.unknown(),
    sessions: z.array(z.object({ sessionId: workMachineIdentifier })).max(5000),
    projectPaths: z.array(z.string()).max(1000),
    expiresAt: z.number().int().positive(),
});
export type WorkMachineTransferPlan = z.infer<typeof planSchema>;
const signedManifestSchema = z.object({ manifestB64: z.string().regex(/^[A-Za-z0-9_-]+$/), proof: deviceProofSchema });
export type WorkMachineSignedManifest = z.infer<typeof signedManifestSchema>;
const presignedSchema = z.object({ url: z.string().url(), expiresAt: z.number() });

export type WorkMachinePart = { n: number; size: number; sha256: string };
type PartMethod = 'PUT' | 'HEAD' | 'GET';

export class WorkMachineTransferError extends Error {
    constructor(message: string, readonly retryable: boolean) {
        super(message);
        this.name = 'WorkMachineTransferError';
    }
}

const ATTEMPTS = 5;

export function openWorkMachineTransfer(input: {
    studioUrl: string;
    jobId: string;
    token: string;
    fetch?: typeof fetch;
    sleep?: (ms: number) => Promise<unknown>;
}) {
    const request = input.fetch ?? fetch;
    const sleep = input.sleep ?? delay;
    const url = new URL(input.studioUrl);
    if (url.search || url.hash || url.username || url.password || (url.protocol !== 'https:'
        && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
        throw new Error('The Studio URL must be https (or http on localhost) without credentials or query');
    }
    if (!input.token.startsWith('wmt_') || input.token.length > 4096) throw new Error('The transfer token must be a wmt_ token');
    const base = `${url.origin}${url.pathname.replace(/\/+$/, '')}/api/work-machine-migrations/${workMachineIdentifier.parse(input.jobId)}/transfer`;

    async function retry<T>(step: string, work: () => Promise<T>): Promise<T> {
        for (let attempt = 1; ; attempt += 1) {
            try {
                return await work();
            } catch (error) {
                const retryable = !(error instanceof WorkMachineTransferError) || error.retryable;
                if (!retryable || attempt >= ATTEMPTS) {
                    throw error instanceof WorkMachineTransferError ? error : new WorkMachineTransferError(`${step} failed`, false);
                }
                await sleep(1_000 * 2 ** (attempt - 1));
            }
        }
    }

    async function studio(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
        let response: Response;
        try {
            response = await request(`${base}/${path}`, {
                method,
                headers: { authorization: `Bearer ${input.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
                body: body === undefined ? undefined : JSON.stringify(body),
                redirect: 'error',
                signal: AbortSignal.timeout(30_000),
            });
        } catch {
            throw new WorkMachineTransferError(`Studio ${method} ${path} could not be reached`, true);
        }
        if (!response.ok) {
            await response.body?.cancel();
            throw new WorkMachineTransferError(`Studio ${method} ${path} returned ${response.status}`, response.status >= 500 || response.status === 429);
        }
        return response;
    }

    async function studioJson<T>(method: 'GET' | 'POST', path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
        const response = await studio(method, path, body);
        const parsed = schema.safeParse(await response.json().catch(() => null));
        if (!parsed.success) throw new WorkMachineTransferError(`Studio ${method} ${path} returned an unexpected body`, false);
        return parsed.data;
    }

    const presign = async (n: number, body: { method: PartMethod; size?: number; sha256?: string }) =>
        (await studioJson('POST', `parts/${n}`, presignedSchema, body)).url;

    return {
        plan: () => retry('Studio plan', () => studioJson('GET', 'plan', planSchema)),
        manifest: () => retry('Studio manifest', () => studioJson('GET', 'manifest', signedManifestSchema)),
        submitManifest: (body: WorkMachineSignedManifest) => retry('Studio manifest submission', async () => {
            await (await studio('POST', 'manifest', body)).body?.cancel();
        }),
        restored: (body: { deviceId: string; dataEncryptionKey: string; proof: WorkMachineDeviceProof; manifestSha256: string }) =>
            retry('Studio restored report', async () => { await (await studio('POST', 'restored', body)).body?.cancel(); }),

        /**
         * Uploads one byte range of `file`, unless the store already holds it: same size and a digest
         * of those bytes, an MD5 ETag or a sha256 checksum. A store that reports neither (an opaque
         * ETag under SSE-KMS or multipart) gets the part again: an old part of the same size would
         * otherwise stay and fail every import.
         */
        uploadPart: (part: WorkMachinePart & { file: string; start: number; md5: string }) => retry(`Upload of part ${part.n}`, async () => {
            const head = await request(await presign(part.n, { method: 'HEAD' }), { method: 'HEAD', redirect: 'error' }).catch(() => null);
            const etag = head?.headers.get('etag')?.replace(/^W\//, '').replace(/"/g, '');
            const sha256 = head?.headers.get('x-amz-checksum-sha256');
            const vouched = (!!etag && /^[a-f0-9]{32}$/.test(etag) && etag === part.md5)
                || (!!sha256 && Buffer.from(sha256, 'base64').toString('hex') === part.sha256);
            if (head?.ok && Number(head.headers.get('content-length')) === part.size && vouched) return 'skipped' as const;
            const target = await presign(part.n, { method: 'PUT', size: part.size, sha256: part.sha256 });
            const source = createReadStream(part.file, { start: part.start, end: part.start + part.size - 1 });
            try {
                const response = await request(target, {
                    method: 'PUT',
                    body: Readable.toWeb(source) as ReadableStream,
                    duplex: 'half',
                    headers: { 'content-length': String(part.size), 'content-type': 'application/octet-stream' },
                    redirect: 'error',
                } as RequestInit);
                await response.body?.cancel();
                if (!response.ok) throw new WorkMachineTransferError(`Upload of part ${part.n} returned ${response.status}`, true);
            } catch (error) {
                throw error instanceof WorkMachineTransferError ? error : new WorkMachineTransferError(`Upload of part ${part.n} failed`, true);
            } finally {
                source.destroy();
            }
            return 'uploaded' as const;
        }),

        /** Downloads one part to `destination` (which must not exist) and verifies it against the signed manifest. */
        downloadPart: (part: WorkMachinePart, destination: string) => retry(`Download of part ${part.n}`, async () => {
            const source = await presign(part.n, { method: 'GET' });
            const received = await getCheckpointObject({ url: source, destination, fetchImpl: request }).catch(() => {
                throw new WorkMachineTransferError(`Download of part ${part.n} failed`, true);
            });
            if (received.bytes !== part.size || received.sha256 !== part.sha256) {
                await rm(destination, { force: true });
                throw new WorkMachineTransferError(`Transfer part ${part.n} failed its integrity check`, false);
            }
        }),
    };
}

/** sha256 (hex) and md5 (hex) of a byte range. */
export async function digestRange(file: string, start: number, size: number): Promise<{ sha256: string; md5: string }> {
    const sha256 = createHash('sha256');
    const md5 = createHash('md5');
    if (size > 0) {
        for await (const chunk of createReadStream(file, { start, end: start + size - 1 })) {
            sha256.update(chunk as Buffer);
            md5.update(chunk as Buffer);
        }
    }
    return { sha256: sha256.digest('hex'), md5: md5.digest('hex') };
}
