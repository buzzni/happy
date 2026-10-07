import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { probeProcessGroup, signalProcessGroup, type ProcessGroupEvidence, type SignalOutcome } from '../../daemon/managedProcessGroup';
import { validatePath } from './pathSecurity';

export type TypedMachineRunRequest =
    | { version: 1; action: 'start'; executable: string; args: string[]; cwd?: string; env?: Record<string, string>; timeoutMs?: number; timeoutGraceMs?: number; outputLimitBytes?: number }
    | { version: 1; action: 'status'; operationId: string }
    | { version: 1; action: 'cancel'; operationId: string };

export type TypedMachineRunResponse =
    | { version: 1; action: 'start'; operationId: string; state: 'accepted' }
    | { version: 1; action: 'status'; operationId: string; state: 'running' | 'passed' | 'failed' | 'cancelled'; stdout: string; stderr: string; exitCode: number | null; truncated: boolean; timedOut: boolean; remoteMayContinue: boolean; descendantsReaped: boolean; processGroupEvidence: ProcessGroupEvidence }
    | { version: 1; action: 'cancel'; operationId: string; state: 'cancelled' | 'already-terminal'; remoteMayContinue: boolean; descendantsReaped: boolean; processGroupEvidence: ProcessGroupEvidence };

export interface TypedMachineRunHandlerOptions {
    /** Override the platform in tests or an embedding host. */
    platform?: NodeJS.Platform;
    /** Environment owned by the adapter. Defaults to PATH only. */
    baseEnvironment?: Record<string, string>;
    /** A trusted profile may render its workspace root as an absolute argv value. */
    allowAbsoluteArguments?: boolean;
    /** A trusted structured profile may pass shell-looking text as argv data (shell remains false). */
    allowStructuredArguments?: boolean;
}

export const MACHINE_RUN_MAX_OUTPUT_BYTES = 1024 * 1024;
export const MACHINE_RUN_MAX_TIMEOUT_MS = 5 * 60 * 1000;
export const MACHINE_RUN_MAX_TIMEOUT_GRACE_MS = 30_000;

type Operation = {
    process: ChildProcess;
    state: 'running' | 'passed' | 'failed' | 'cancelled';
    stdout: Buffer;
    stderr: Buffer;
    outputLimitBytes: number;
    truncated: boolean;
    timedOut: boolean;
    exitCode: number | null;
    remoteMayContinue: boolean;
    descendantsReaped: boolean;
    processGroupEvidence: ProcessGroupEvidence;
    childClosed: boolean;
    terminationSettled: boolean;
    signalError?: string;
    finishedAt: number;
    termination?: Promise<void>;
};

const MAX_OUTPUT_BYTES = MACHINE_RUN_MAX_OUTPUT_BYTES;
const MAX_TIMEOUT_MS = MACHINE_RUN_MAX_TIMEOUT_MS;
const MAX_TIMEOUT_GRACE_MS = MACHINE_RUN_MAX_TIMEOUT_GRACE_MS;
const DEFAULT_TIMEOUT_GRACE_MS = 2_000;
const MAX_ACTIVE_OPERATIONS = 32;
const MAX_RETAINED_OPERATIONS = 128;
const OPERATION_RETENTION_MS = 15 * 60 * 1000;
const MAX_ARGS = 64;
const SAFE_EXECUTABLE = /^[a-z][a-z0-9._-]*$/;
const FORBIDDEN_EXECUTABLE = /^(?:sh|bash|zsh|fish|cmd|powershell|pwsh|node|python|python3|npm|npx|env|xargs|ssh|tmux)$/i;
const FORBIDDEN_FLAG = /^(?:--from|--wake|--interactive|--tty|--tui|-i)$/;
const SHELL_SYNTAX = /[\x00-\x1f;&|`$<>]/;
const DANGEROUS_ENV = /^(?:PATH|LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|DYLD_|NODE_OPTIONS|BASH_ENV|GIT_SSH_COMMAND|GIT_CONFIG_|PYTHONSTARTUP)/;

function invalid(message: string): Error { return new Error(`MACHINE_RUN_INVALID: ${message}`); }

function assertRequest(value: unknown, options: TypedMachineRunHandlerOptions = {}): asserts value is TypedMachineRunRequest {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('request must be an object');
    const request = value as Record<string, unknown>;
    if (request.version !== 1) throw invalid('unsupported version');
    if (request.action !== 'start' && request.action !== 'status' && request.action !== 'cancel') throw invalid('unsupported action');
    if (request.action !== 'start') {
        if (typeof request.operationId !== 'string' || !request.operationId) throw invalid('operationId is required');
        return;
    }
    if (typeof request.executable !== 'string' || !SAFE_EXECUTABLE.test(request.executable) || FORBIDDEN_EXECUTABLE.test(request.executable)) throw invalid('unsupported executable');
    const allowAbsoluteArguments = options.allowAbsoluteArguments === true;
    const rejectShellSyntax = options.allowStructuredArguments !== true;
    if (!Array.isArray(request.args) || request.args.length > MAX_ARGS || request.args.some((arg) => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0') || (rejectShellSyntax && SHELL_SYNTAX.test(arg)) || FORBIDDEN_FLAG.test(arg) || (!allowAbsoluteArguments && (arg.startsWith('/') || /^[A-Za-z]:[\\/]/.test(arg))))) throw invalid('unsafe args');
    if (request.cwd !== undefined && typeof request.cwd !== 'string') throw invalid('cwd must be a string');
    if (request.env !== undefined && (!request.env || typeof request.env !== 'object' || Array.isArray(request.env))) throw invalid('env must be an object');
    const env = request.env as Record<string, unknown> | undefined;
    if (env && Object.keys(env).some((key) => !/^[A-Z][A-Z0-9_]*$/.test(key) || DANGEROUS_ENV.test(key) || typeof env[key] !== 'string' || SHELL_SYNTAX.test(env[key] as string))) throw invalid('unsafe env');
    if (request.timeoutMs !== undefined && (typeof request.timeoutMs !== 'number' || !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > MAX_TIMEOUT_MS)) throw invalid('invalid timeout');
    if (request.timeoutGraceMs !== undefined && (typeof request.timeoutGraceMs !== 'number' || !Number.isSafeInteger(request.timeoutGraceMs) || request.timeoutGraceMs < 1 || request.timeoutGraceMs > MAX_TIMEOUT_GRACE_MS)) throw invalid('invalid timeout grace');
    if (request.outputLimitBytes !== undefined && (typeof request.outputLimitBytes !== 'number' || !Number.isSafeInteger(request.outputLimitBytes) || request.outputLimitBytes < 1 || request.outputLimitBytes > MAX_OUTPUT_BYTES)) throw invalid('invalid output limit');
}

function append(output: Buffer, chunk: Buffer, limit: number): { value: Buffer; truncated: boolean } {
    if (output.length >= limit) return { value: output, truncated: true };
    const remaining = limit - output.length;
    return chunk.length <= remaining ? { value: Buffer.concat([output, chunk]), truncated: false } : { value: Buffer.concat([output, chunk.subarray(0, remaining)]), truncated: true };
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): SignalOutcome {
    if (!child.pid) return { kind: 'indeterminate', detail: 'child has no pid' };
    return signalProcessGroup(child.pid, signal);
}

export function createTypedMachineRunHandler(workingDirectory: string, options: TypedMachineRunHandlerOptions = {}) {
    const operations = new Map<string, Operation>();
    const refreshEvidence = (operation: Operation) => {
        if (!operation.process.pid) operation.processGroupEvidence = { kind: 'indeterminate', detail: 'child has no pid' };
        else operation.processGroupEvidence = probeProcessGroup(operation.process.pid);
        if (operation.signalError) operation.processGroupEvidence = { kind: 'indeterminate', detail: operation.signalError };
        // Group absence is only local evidence: setsid can move descendants elsewhere.
        operation.descendantsReaped = false;
        operation.remoteMayContinue = true;
    };
    const unresolved = (operation: Operation) => operation.state === 'running' || !operation.childClosed || !operation.terminationSettled || operation.processGroupEvidence.kind !== 'no-local-trace';
    const reapExpired = () => {
        const cutoff = Date.now() - OPERATION_RETENTION_MS;
        for (const [id, operation] of operations) if (!unresolved(operation) && operation.finishedAt < cutoff) operations.delete(id);
        const terminal = [...operations.entries()].filter(([, operation]) => !unresolved(operation));
        if (terminal.length > MAX_RETAINED_OPERATIONS) {
            terminal.sort(([, a], [, b]) => a.finishedAt - b.finishedAt);
            for (const [id] of terminal.slice(0, terminal.length - MAX_RETAINED_OPERATIONS)) operations.delete(id);
        }
    };
    const terminate = (operation: Operation, graceMs: number): Promise<void> => {
        if (operation.termination) return operation.termination;
        operation.termination = (async () => {
            const term = signalGroup(operation.process, 'SIGTERM');
            if (term.kind === 'indeterminate') operation.signalError = term.detail;
            await new Promise<void>((resolve) => {
                if (operation.childClosed) return resolve();
                const timer = setTimeout(resolve, graceMs);
                operation.process.once('close', () => { clearTimeout(timer); resolve(); });
            });
            refreshEvidence(operation);
            if (operation.processGroupEvidence.kind === 'alive' || operation.processGroupEvidence.kind === 'alive-foreign') {
                const kill = signalGroup(operation.process, 'SIGKILL');
                if (kill.kind === 'indeterminate') operation.signalError = kill.detail;
                await new Promise((resolve) => setTimeout(resolve, Math.min(graceMs, 1_000)));
                refreshEvidence(operation);
            }
            operation.terminationSettled = true;
        })();
        return operation.termination;
    };
    return async (input: unknown): Promise<TypedMachineRunResponse> => {
        assertRequest(input, options);
        if ((options.platform ?? process.platform) === 'win32') throw new Error('MACHINE_RUN_UNSUPPORTED_PLATFORM: Windows Job backend is required');
        reapExpired();
        if (input.action === 'status' || input.action === 'cancel') {
            const operation = operations.get(input.operationId);
            if (!operation) throw new Error('MACHINE_RUN_NOT_FOUND: operationId is unknown');
            refreshEvidence(operation);
            if (input.action === 'cancel') {
                if (operation.state !== 'running') return { version: 1, action: 'cancel', operationId: input.operationId, state: 'already-terminal', remoteMayContinue: operation.remoteMayContinue, descendantsReaped: operation.descendantsReaped, processGroupEvidence: operation.processGroupEvidence };
                operation.state = 'cancelled';
                void terminate(operation, DEFAULT_TIMEOUT_GRACE_MS);
                return { version: 1, action: 'cancel', operationId: input.operationId, state: 'cancelled', remoteMayContinue: operation.remoteMayContinue, descendantsReaped: operation.descendantsReaped, processGroupEvidence: operation.processGroupEvidence };
            }
            return { version: 1, action: 'status', operationId: input.operationId, state: operation.state, stdout: operation.stdout.toString('utf8'), stderr: operation.stderr.toString('utf8'), exitCode: operation.exitCode, truncated: operation.truncated, timedOut: operation.timedOut, remoteMayContinue: operation.remoteMayContinue, descendantsReaped: operation.descendantsReaped, processGroupEvidence: operation.processGroupEvidence };
        }
        if ([...operations.values()].filter(unresolved).length >= MAX_ACTIVE_OPERATIONS) throw new Error('MACHINE_RUN_QUOTA_EXCEEDED: too many active operations');
        const cwd = input.cwd ? validatePath(input.cwd, workingDirectory) : { valid: true as const, resolvedPath: workingDirectory };
        if (!cwd.valid || !cwd.resolvedPath) throw new Error(`MACHINE_RUN_PATH_DENIED: ${cwd.error}`);
        const outputLimitBytes = input.outputLimitBytes ?? MAX_OUTPUT_BYTES;
        const child = spawn(input.executable, input.args, { cwd: cwd.resolvedPath, shell: false, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '', ...(options.baseEnvironment ?? {}), ...(input.env ?? {}) } });
        const operationId = randomUUID();
        const operation: Operation = { process: child, state: 'running', stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), outputLimitBytes, truncated: false, timedOut: false, exitCode: null, remoteMayContinue: true, descendantsReaped: false, processGroupEvidence: { kind: 'alive' }, childClosed: false, terminationSettled: false, finishedAt: Number.POSITIVE_INFINITY };
        operations.set(operationId, operation);
        child.stdout?.on('data', (chunk: Buffer) => { const result = append(operation.stdout, chunk, Math.max(0, outputLimitBytes - operation.stderr.length)); operation.stdout = result.value; operation.truncated ||= result.truncated; });
        child.stderr?.on('data', (chunk: Buffer) => { const result = append(operation.stderr, chunk, Math.max(0, outputLimitBytes - operation.stdout.length)); operation.stderr = result.value; operation.truncated ||= result.truncated; });
        child.once('error', (error) => { operation.state = 'failed'; const result = append(operation.stderr, Buffer.from(error.message), Math.max(0, outputLimitBytes - operation.stdout.length)); operation.stderr = result.value; operation.truncated ||= result.truncated; });
        child.once('close', (code) => { operation.childClosed = true; operation.exitCode = typeof code === 'number' ? code : null; if (operation.state === 'running') operation.state = code === 0 ? 'passed' : 'failed'; refreshEvidence(operation); operation.finishedAt = Date.now(); if (operation.processGroupEvidence.kind !== 'no-local-trace') void terminate(operation, DEFAULT_TIMEOUT_GRACE_MS); });
        const timer = setTimeout(() => { if (operation.state !== 'running') return; operation.timedOut = true; operation.state = 'failed'; operation.finishedAt = Date.now(); void terminate(operation, input.timeoutGraceMs ?? DEFAULT_TIMEOUT_GRACE_MS); }, input.timeoutMs ?? 30_000);
        child.once('close', () => clearTimeout(timer));
        return { version: 1, action: 'start', operationId, state: 'accepted' };
    };
}
