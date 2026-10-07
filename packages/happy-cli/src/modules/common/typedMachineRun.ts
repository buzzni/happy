import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { validatePath } from './pathSecurity';

export type TypedMachineRunRequest =
    | {
        version: 1;
        action: 'start';
        executable: string;
        args: string[];
        cwd?: string;
        env?: Record<string, string>;
        timeoutMs?: number;
        outputLimitBytes?: number;
    }
    | { version: 1; action: 'status'; operationId: string }
    | { version: 1; action: 'cancel'; operationId: string };

export type TypedMachineRunResponse =
    | { version: 1; action: 'start'; operationId: string; state: 'accepted' }
    | {
        version: 1;
        action: 'status';
        operationId: string;
        state: 'running' | 'passed' | 'failed' | 'cancelled';
        stdout: string;
        stderr: string;
        exitCode: number | null;
        truncated: boolean;
        timedOut: boolean;
    }
    | { version: 1; action: 'cancel'; operationId: string; state: 'cancelled' | 'already-terminal' };

type Operation = {
    process: ChildProcess;
    state: 'running' | 'passed' | 'failed' | 'cancelled';
    stdout: Buffer;
    stderr: Buffer;
    outputLimitBytes: number;
    truncated: boolean;
    timedOut: boolean;
    exitCode: number | null;
};

const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_ARGS = 64;
const SAFE_EXECUTABLE = /^[a-z][a-z0-9._-]*$/;
const FORBIDDEN_EXECUTABLE = /^(?:sh|bash|zsh|fish|cmd|powershell|pwsh|node|python|python3|npm|npx|env|xargs|ssh|tmux)$/i;
const FORBIDDEN_FLAG = /^(?:--from|--wake|--interactive|--tty|--tui|-i)$/;
const SHELL_SYNTAX = /[\x00-\x1f;&|`$<>]/;
const DANGEROUS_ENV = /^(?:PATH|LD_PRELOAD|DYLD_|NODE_OPTIONS|BASH_ENV|GIT_SSH_COMMAND|PYTHONSTARTUP)/;

function invalid(message: string): Error {
    return new Error(`MACHINE_RUN_INVALID: ${message}`);
}

function assertRequest(value: unknown): asserts value is TypedMachineRunRequest {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('request must be an object');
    const request = value as Record<string, unknown>;
    if (request.version !== 1) throw invalid('unsupported version');
    if (request.action !== 'start' && request.action !== 'status' && request.action !== 'cancel') throw invalid('unsupported action');
    if (request.action !== 'start') {
        if (typeof request.operationId !== 'string' || !request.operationId) throw invalid('operationId is required');
        return;
    }
    if (typeof request.executable !== 'string' || !SAFE_EXECUTABLE.test(request.executable) || FORBIDDEN_EXECUTABLE.test(request.executable)) throw invalid('unsupported executable');
    if (!Array.isArray(request.args) || request.args.length > MAX_ARGS || request.args.some((arg) => typeof arg !== 'string' || arg.length > 4096 || SHELL_SYNTAX.test(arg) || FORBIDDEN_FLAG.test(arg) || arg.startsWith('/') || /^[A-Za-z]:[\\/]/.test(arg))) throw invalid('unsafe args');
    if (request.cwd !== undefined && typeof request.cwd !== 'string') throw invalid('cwd must be a string');
    if (request.env !== undefined && (!request.env || typeof request.env !== 'object' || Array.isArray(request.env))) throw invalid('env must be an object');
    const env = request.env as Record<string, unknown> | undefined;
    if (env && Object.keys(env).some((key) => !/^[A-Z][A-Z0-9_]*$/.test(key) || DANGEROUS_ENV.test(key) || typeof env[key] !== 'string' || SHELL_SYNTAX.test(env[key] as string))) throw invalid('unsafe env');
    if (request.timeoutMs !== undefined && (typeof request.timeoutMs !== 'number' || !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > MAX_TIMEOUT_MS)) throw invalid('invalid timeout');
    if (request.outputLimitBytes !== undefined && (typeof request.outputLimitBytes !== 'number' || !Number.isSafeInteger(request.outputLimitBytes) || request.outputLimitBytes < 1 || request.outputLimitBytes > MAX_OUTPUT_BYTES)) throw invalid('invalid output limit');
}

function append(output: Buffer, chunk: Buffer, limit: number): { value: Buffer; truncated: boolean } {
    if (output.length >= limit) return { value: output, truncated: true };
    const remaining = limit - output.length;
    return chunk.length <= remaining
        ? { value: Buffer.concat([output, chunk]), truncated: false }
        : { value: Buffer.concat([output, chunk.subarray(0, remaining)]), truncated: true };
}

function terminate(child: ChildProcess): void {
    const pid = child.pid;
    if (!pid) return;
    try {
        if (process.platform === 'win32') child.kill();
        else process.kill(-pid, 'SIGTERM');
    } catch { /* already exited */ }
}

export function createTypedMachineRunHandler(workingDirectory: string) {
    const operations = new Map<string, Operation>();

    return async (input: unknown): Promise<TypedMachineRunResponse> => {
        assertRequest(input);
        if (process.platform === 'win32') throw new Error('MACHINE_RUN_UNSUPPORTED_PLATFORM: Windows Job backend is required');

        if (input.action === 'status' || input.action === 'cancel') {
            const operation = operations.get(input.operationId);
            if (!operation) throw new Error('MACHINE_RUN_NOT_FOUND: operationId is unknown');
            if (input.action === 'cancel') {
                if (operation.state !== 'running') return { version: 1, action: 'cancel', operationId: input.operationId, state: 'already-terminal' };
                terminate(operation.process);
                operation.state = 'cancelled';
                return { version: 1, action: 'cancel', operationId: input.operationId, state: 'cancelled' };
            }
            return {
                version: 1,
                action: 'status',
                operationId: input.operationId,
                state: operation.state,
                stdout: operation.stdout.toString('utf8'),
                stderr: operation.stderr.toString('utf8'),
                exitCode: operation.exitCode,
                truncated: operation.truncated,
                timedOut: operation.timedOut,
            };
        }

        const cwd = input.cwd ? validatePath(input.cwd, workingDirectory) : { valid: true as const, resolvedPath: workingDirectory };
        if (!cwd.valid || !cwd.resolvedPath) throw new Error(`MACHINE_RUN_PATH_DENIED: ${cwd.error}`);
        const outputLimitBytes = input.outputLimitBytes ?? MAX_OUTPUT_BYTES;
        const child = spawn(input.executable, input.args, {
            cwd: cwd.resolvedPath,
            shell: false,
            detached: true,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { PATH: process.env.PATH ?? '', ...(input.env ?? {}) },
        });
        const operationId = randomUUID();
        const operation: Operation = { process: child, state: 'running', stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), outputLimitBytes, truncated: false, timedOut: false, exitCode: null };
        operations.set(operationId, operation);
        child.stdout?.on('data', (chunk: Buffer) => { const result = append(operation.stdout, chunk, outputLimitBytes); operation.stdout = result.value; operation.truncated ||= result.truncated; });
        child.stderr?.on('data', (chunk: Buffer) => { const result = append(operation.stderr, chunk, outputLimitBytes); operation.stderr = result.value; operation.truncated ||= result.truncated; });
        child.once('error', (error) => { operation.state = 'failed'; operation.stderr = append(operation.stderr, Buffer.from(error.message), outputLimitBytes).value; });
        child.once('close', (code) => { operation.exitCode = typeof code === 'number' ? code : null; if (operation.state === 'running') operation.state = code === 0 ? 'passed' : 'failed'; });
        const timer = setTimeout(() => { if (operation.state !== 'running') return; operation.timedOut = true; terminate(child); operation.state = 'failed'; }, input.timeoutMs ?? 30_000);
        child.once('close', () => clearTimeout(timer));
        return { version: 1, action: 'start', operationId, state: 'accepted' };
    };
}
