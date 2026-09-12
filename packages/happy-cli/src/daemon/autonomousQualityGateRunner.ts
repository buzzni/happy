import { spawn, type ChildProcess } from 'node:child_process';
import type { AutonomousQualityGateStartRequestV1 } from '../api/autonomousQualityGateProtocol';

export const MAX_AUTONOMOUS_GATE_OUTPUT_BYTES = 8 * 1_024;
const DEFAULT_KILL_GRACE_MS = 1_000;

export type AutonomousQualityGatePhasePlan = AutonomousQualityGateStartRequestV1['plan']['phases'][number];
export type AutonomousQualityGatePhaseStatus = 'passed' | 'failed' | 'timed-out' | 'aborted';

export interface AutonomousQualityGatePhaseResult {
    name: AutonomousQualityGatePhasePlan['name'];
    status: AutonomousQualityGatePhaseStatus;
    exitCode: number | null;
    timedOut: boolean;
    durationMs: number;
    stdoutTail: string;
    stderrTail: string;
    outputTruncated: boolean;
}

export function runAutonomousQualityGatePhase(
    phase: AutonomousQualityGatePhasePlan,
    options: {
        cwd: string;
        signal?: AbortSignal;
        killGraceMs?: number;
        now?: () => number;
    },
): Promise<AutonomousQualityGatePhaseResult> {
    const now = options.now ?? Date.now;
    const startedAt = now();
    if (options.signal?.aborted) {
        return Promise.resolve(emptyResult(phase.name, 'aborted', startedAt, now));
    }

    return new Promise((resolve) => {
        const stdout = new OutputTail(MAX_AUTONOMOUS_GATE_OUTPUT_BYTES);
        const stderr = new OutputTail(MAX_AUTONOMOUS_GATE_OUTPUT_BYTES);
        let forcedStatus: 'timed-out' | 'aborted' | undefined;
        let settled = false;
        let killTimer: NodeJS.Timeout | undefined;
        let timeout: NodeJS.Timeout | undefined;
        let readinessTimer: NodeJS.Timeout | undefined;
        let teardownPollTimer: NodeJS.Timeout | undefined;
        let pendingClose: { exitCode: number | null; error?: Error } | undefined;
        let forceSent = false;
        let startPassed = false;
        let child: ChildProcess;

        const finish = (exitCode: number | null, error?: Error) => {
            if (settled) return;
            settled = true;
            if (timeout) clearTimeout(timeout);
            if (killTimer) clearTimeout(killTimer);
            if (readinessTimer) clearTimeout(readinessTimer);
            if (teardownPollTimer) clearTimeout(teardownPollTimer);
            options.signal?.removeEventListener('abort', abort);
            if (error) stderr.append(Buffer.from(error.message));
            const status = forcedStatus
                ?? (startPassed || (phase.name !== 'start' && exitCode === 0 && !error) ? 'passed' : 'failed');
            resolve({
                name: phase.name,
                status,
                exitCode: forcedStatus ? null : startPassed ? 0 : exitCode,
                timedOut: forcedStatus === 'timed-out',
                durationMs: Math.max(0, now() - startedAt),
                stdoutTail: stdout.text(),
                stderrTail: stderr.text(),
                outputTruncated: stdout.truncated || stderr.truncated,
            });
        };
        const stop = (status: 'timed-out' | 'aborted') => {
            if (settled || forcedStatus) return;
            forcedStatus = status;
            killProcessTree(child, false);
            scheduleForcedTeardown();
        };
        const abort = () => stop('aborted');
        const finishAfterForcedTeardown = (attempt = 0) => {
            if (!pendingClose) return;
            if (processTreeAlive(child) && attempt < 100) {
                teardownPollTimer = setTimeout(() => finishAfterForcedTeardown(attempt + 1), 10);
                return;
            }
            const close = pendingClose;
            pendingClose = undefined;
            finish(close.exitCode, close.error);
        };
        const scheduleForcedTeardown = () => {
            if (killTimer || forceSent) return;
            killTimer = setTimeout(() => {
                killTimer = undefined;
                forceSent = true;
                killProcessTree(child, true);
                finishAfterForcedTeardown();
            }, options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
        };
        const close = (exitCode: number | null, error?: Error) => {
            if ((forcedStatus || startPassed) && processTreeAlive(child)) {
                pendingClose = { exitCode, ...(error ? { error } : {}) };
                if (forceSent) finishAfterForcedTeardown();
                return;
            }
            finish(exitCode, error);
        };

        try {
            child = spawn('bash', ['-lc', phase.command], {
                cwd: options.cwd,
                detached: process.platform !== 'win32',
                env: process.env,
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });
        } catch (error) {
            finish(null, error instanceof Error ? error : new Error(String(error)));
            return;
        }
        child.stdout?.on('data', (chunk: Buffer) => stdout.append(chunk));
        child.stderr?.on('data', (chunk: Buffer) => stderr.append(chunk));
        child.once('error', error => close(null, error));
        child.once('close', code => close(code));
        options.signal?.addEventListener('abort', abort, { once: true });
        timeout = setTimeout(() => stop('timed-out'), phase.timeoutMs);
        if (phase.name === 'start') {
            const ready = () => {
                if (settled || forcedStatus) return;
                startPassed = true;
                if (timeout) {
                    clearTimeout(timeout);
                    timeout = undefined;
                }
                killProcessTree(child, false);
                scheduleForcedTeardown();
            };
            if (!phase.readinessUrl) {
                readinessTimer = setTimeout(ready, 1_000);
            } else {
                const poll = async () => {
                    if (settled || forcedStatus) return;
                    try {
                        await fetch(phase.readinessUrl!, { signal: AbortSignal.timeout(2_000) });
                        ready();
                    } catch {
                        if (!settled && !forcedStatus) readinessTimer = setTimeout(poll, 250);
                    }
                };
                void poll();
            }
        }
    });
}

class OutputTail {
    private value = Buffer.alloc(0);
    truncated = false;

    constructor(private readonly maxBytes: number) {}

    append(chunk: Buffer): void {
        const combined = Buffer.concat([this.value, chunk]);
        if (combined.length > this.maxBytes) {
            this.truncated = true;
            this.value = combined.subarray(combined.length - this.maxBytes);
            return;
        }
        this.value = combined;
    }

    text(): string {
        return this.value.toString('utf8').trim();
    }
}

function emptyResult(
    name: AutonomousQualityGatePhasePlan['name'],
    status: 'aborted',
    startedAt: number,
    now: () => number,
): AutonomousQualityGatePhaseResult {
    return {
        name,
        status,
        exitCode: null,
        timedOut: false,
        durationMs: Math.max(0, now() - startedAt),
        stdoutTail: '',
        stderrTail: '',
        outputTruncated: false,
    };
}

function killProcessTree(child: ChildProcess, force: boolean): void {
    if (!child.pid) return;
    if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/t', ...(force ? ['/f'] : [])], {
            stdio: 'ignore',
            windowsHide: true,
        }).unref();
        return;
    }
    try {
        process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
    } catch {
        try { child.kill(force ? 'SIGKILL' : 'SIGTERM'); } catch { /* already exited */ }
    }
}

function processTreeAlive(child: ChildProcess): boolean {
    if (!child.pid) return false;
    if (process.platform === 'win32') return child.exitCode === null;
    try {
        process.kill(-child.pid, 0);
        return true;
    } catch {
        return false;
    }
}
