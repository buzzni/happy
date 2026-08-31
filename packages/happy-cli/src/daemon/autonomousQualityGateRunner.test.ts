import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
    MAX_AUTONOMOUS_GATE_OUTPUT_BYTES,
    runAutonomousQualityGatePhase,
} from './autonomousQualityGateRunner';

const phase = (command: string, timeoutMs = 5_000) => ({
    name: 'test' as const,
    command,
    timeoutMs,
});

describe('runAutonomousQualityGatePhase', () => {
    it('reports pass and non-zero failure with separate output tails', async () => {
        await expect(runAutonomousQualityGatePhase(phase('printf passed'), { cwd: process.cwd() }))
            .resolves.toMatchObject({ status: 'passed', exitCode: 0, stdoutTail: 'passed' });

        await expect(runAutonomousQualityGatePhase(phase('printf partial; printf failed >&2; exit 7'), {
            cwd: process.cwd(),
        })).resolves.toMatchObject({
            status: 'failed',
            exitCode: 7,
            stdoutTail: 'partial',
            stderrTail: 'failed',
        });
    });

    it('bounds output while retaining the diagnostic tail', async () => {
        const result = await runAutonomousQualityGatePhase(
            phase(`printf 'x%.0s' {1..${MAX_AUTONOMOUS_GATE_OUTPUT_BYTES + 20}}`),
            { cwd: process.cwd() },
        );

        expect(Buffer.byteLength(result.stdoutTail)).toBe(MAX_AUTONOMOUS_GATE_OUTPUT_BYTES);
        expect(result.stdoutTail).toMatch(/^x+$/);
        expect(result.outputTruncated).toBe(true);
    });

    it('kills the whole process group on timeout', async () => {
        const cwd = await mkdtemp(join(process.cwd(), '.happy-gate-runner-'));
        try {
            const result = await runAutonomousQualityGatePhase(
                phase("trap '' TERM; sleep 30 & child=$!; printf \"$child\"; wait", 100),
                { cwd, killGraceMs: 50 },
            );

            expect(result).toMatchObject({ status: 'timed-out', timedOut: true, exitCode: null });
            const childPid = Number(result.stdoutTail);
            expect(Number.isInteger(childPid)).toBe(true);
            expect(() => process.kill(childPid, 0)).toThrow();
        } finally {
            await rm(cwd, { recursive: true, force: true });
        }
    });

    it('honors an already-aborted signal without spawning work', async () => {
        const controller = new AbortController();
        controller.abort();

        await expect(runAutonomousQualityGatePhase(phase('printf should-not-run'), {
            cwd: process.cwd(),
            signal: controller.signal,
        })).resolves.toMatchObject({ status: 'aborted', timedOut: false, exitCode: null });
    });

    it('passes a start phase after readiness and tears down its process tree', async () => {
        const port = await availablePort();
        const command = `node -e 'require("http").createServer((_q,r)=>r.end("ok")).listen(${port})'`;
        const result = await runAutonomousQualityGatePhase({
            name: 'start',
            command,
            timeoutMs: 5_000,
            readinessUrl: `http://127.0.0.1:${port}/`,
        }, { cwd: process.cwd(), killGraceMs: 50 });

        expect(result).toMatchObject({ status: 'passed', exitCode: 0, timedOut: false });
        await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
    });
});

async function availablePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('failed to allocate port');
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    return address.port;
}
