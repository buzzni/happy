/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary 4b-3 preview stage 2 — `spawn-with-sealed-env`.
 *
 * The server sends no command to a strict machine and the browser should not see the merged
 * secrets. The server seals a preview's env for this machine (`@slopus/happy-wire`
 * sealedSpawnEnv); the browser sends the command and the sealed env on the customer lane; this
 * handler opens it, checks it and runs the command with it. The env reaches the process as process
 * env or a 0600 file, never as command text, and is never logged or returned.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { exec, type ExecOptions } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
    SEALED_SPAWN_ENV_FILE_VARIABLE,
    SEALED_SPAWN_ENV_KEY_LABEL,
    SEALED_SPAWN_ENV_WINDOW_MS,
    readSealedSpawnEnvPayload,
    type SealedSpawnEnvPayload,
} from '@slopus/happy-wire';
import { deriveServerRpcKey } from '@/api/encryption';
import { RpcNonceGuard } from '@/api/rpc/rpcNonceGuard';
import { logger } from '@/ui/logger';
import { validatePath } from './pathSecurity';

const execAsync = promisify(exec);
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

function sealKey(laneKey: Uint8Array): Buffer {
    return createHmac('sha256', laneKey).update(SEALED_SPAWN_ENV_KEY_LABEL).digest();
}

/** The server's side of the seal, here so the format has one reference next to its reader. */
export function sealSpawnEnv(laneKey: Uint8Array, payload: SealedSpawnEnvPayload): string {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', sealKey(laneKey), nonce);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString('base64');
}

/** The opened JSON, or null when it was not sealed for this machine key. */
export function openSealedSpawnEnv(machineKey: Uint8Array, sealedBase64: string): unknown | null {
    try {
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(sealedBase64)) return null;
        const bytes = Buffer.from(sealedBase64, 'base64');
        if (bytes.length <= NONCE_BYTES + TAG_BYTES) return null;
        const decipher = createDecipheriv('aes-256-gcm', sealKey(deriveServerRpcKey(machineKey)), bytes.subarray(0, NONCE_BYTES));
        decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
        const plaintext = Buffer.concat([decipher.update(bytes.subarray(NONCE_BYTES, bytes.length - TAG_BYTES)), decipher.final()]);
        return JSON.parse(plaintext.toString('utf8'));
    } catch {
        return null;
    }
}

export type SealedSpawnEnvRequest = {
    command: string;
    cwd: string;
    timeout?: number;
    sealedEnv: string;
    envDelivery: 'process' | 'file';
};

export type SealedSpawnEnvResponse = {
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
    error?: string;
    errorCode?: string;
    rejectedNames?: string[];
};

type MachineKeyView = { id: string; encryptionKey: Uint8Array; encryptionVariant: 'legacy' | 'dataKey' };

function refused(errorCode: string, error: string, extra: Partial<SealedSpawnEnvResponse> = {}): SealedSpawnEnvResponse {
    return { success: false, stdout: '', stderr: '', exitCode: -1, error, errorCode, ...extra };
}

/** docker `--env-file` lines, as the web's own env file: empty values dropped, no line breaks. */
function envFileContent(env: Record<string, string>): string {
    return Object.entries(env)
        .filter(([, value]) => value !== '')
        .map(([key, value]) => `${key}=${value.replace(/\r?\n/g, '')}`)
        .join('\n');
}

function isRequest(value: unknown): value is SealedSpawnEnvRequest {
    if (!value || typeof value !== 'object') return false;
    const request = value as Record<string, unknown>;
    return typeof request.command === 'string' && request.command.length > 0
        && typeof request.cwd === 'string' && request.cwd.length > 0
        && typeof request.sealedEnv === 'string'
        && (request.envDelivery === 'process' || request.envDelivery === 'file')
        && (request.timeout === undefined || (typeof request.timeout === 'number' && request.timeout > 0));
}

export function createSealedSpawnEnvHandler(deps: {
    machine: () => MachineKeyView;
    allowedRoot: string;
    now?: () => number;
}): (request: SealedSpawnEnvRequest) => Promise<SealedSpawnEnvResponse> {
    const now = deps.now ?? Date.now;
    const nonces = new RpcNonceGuard({ windowMs: SEALED_SPAWN_ENV_WINDOW_MS, maxEntries: 10_000, whenFull: 'refuse' });

    return async (request) => {
        if (!isRequest(request)) return refused('INVALID_REQUEST', 'command, cwd, sealedEnv and envDelivery are required');
        const machine = deps.machine();
        if (machine.encryptionVariant !== 'dataKey') return refused('SEALED_ENV_UNSUPPORTED', 'This machine has no machine key to open a sealed env with');

        const cwd = validatePath(request.cwd, deps.allowedRoot);
        if (!cwd.valid || !cwd.resolvedPath) return refused('PATH_DENIED', cwd.error ?? 'Access denied');

        const opened = openSealedSpawnEnv(machine.encryptionKey, request.sealedEnv);
        if (opened === null) return refused('SEALED_ENV_UNREADABLE', 'The env was not sealed for this machine');
        const at = now();
        const payload = readSealedSpawnEnvPayload(opened, { machineId: machine.id, now: at });
        if (!payload.ok) {
            return payload.code === 'SEALED_ENV_RESERVED_NAME'
                ? refused(payload.code, 'The sealed env sets a reserved name', { rejectedNames: payload.names })
                : refused(payload.code, 'The sealed env was refused');
        }
        const issuedAt = (opened as { issuedAt: number }).issuedAt;
        const admission = nonces.admit(payload.nonce, issuedAt, at);
        if (admission === 'replayed') return refused('SEALED_ENV_REPLAYED', 'This sealed env was already used');
        if (admission === 'full') return refused('SEALED_ENV_BUSY', 'Too many sealed envs in the window');

        let envDir: string | null = null;
        try {
            const env: NodeJS.ProcessEnv = { ...process.env };
            if (request.envDelivery === 'process') {
                Object.assign(env, payload.env);
            } else {
                envDir = await mkdtemp(join(tmpdir(), 'happy-sealed-env-'));
                const file = join(envDir, 'env');
                await writeFile(file, envFileContent(payload.env), { mode: 0o600 });
                env[SEALED_SPAWN_ENV_FILE_VARIABLE] = file;
            }
            const options: ExecOptions = { cwd: cwd.resolvedPath, timeout: request.timeout ?? 30_000, windowsHide: true, env };
            logger.debug('[sealed-spawn-env] running', { cwd: options.cwd, delivery: request.envDelivery, names: Object.keys(payload.env).length });
            const { stdout, stderr } = await execAsync(request.command, options);
            return { success: true, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), exitCode: 0 };
        } catch (error) {
            const execError = error as { stdout?: unknown; stderr?: unknown; code?: unknown; killed?: boolean; message?: string };
            const timedOut = execError.code === 'ETIMEDOUT' || execError.killed === true;
            return {
                success: false,
                stdout: String(execError.stdout ?? ''),
                stderr: String(execError.stderr ?? execError.message ?? ''),
                exitCode: typeof execError.code === 'number' ? execError.code : timedOut ? -1 : 1,
                error: timedOut ? 'Command timed out' : execError.message || 'Command failed',
            };
        } finally {
            if (envDir) await rm(envDir, { recursive: true, force: true });
        }
    };
}
