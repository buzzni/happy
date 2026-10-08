import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTypedMachineRunHandler } from './typedMachineRun';
import { probeProcessGroup, signalProcessGroup } from '../../daemon/managedProcessGroup';

async function waitForTerminal(handler: ReturnType<typeof createTypedMachineRunHandler>, operationId: string) {
    for (let attempt = 0; attempt < 100; attempt++) {
        const status = await handler({ version: 1, action: 'status', operationId });
        if (status.action === 'status' && status.state !== 'running') return status;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`operation did not reach a terminal state: ${operationId}`);
}

describe('typed machine-run handler', () => {
    it('runs argv without a shell and returns bounded output through status', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-machine-run-'));
        try {
            const handler = createTypedMachineRunHandler(root);
            const started = await handler({ version: 1, action: 'start', executable: 'printf', args: ['typed'], cwd: root, timeoutMs: 2_000 });
            expect(started.action).toBe('start');
            if (started.action !== 'start') return;
            await new Promise((resolve) => setTimeout(resolve, 100));
            await expect(handler({ version: 1, action: 'status', operationId: started.operationId })).resolves.toMatchObject({ state: 'passed', stdout: 'typed', exitCode: 0 });
            const status = await handler({ version: 1, action: 'status', operationId: started.operationId });
            expect(status.action === 'status' && status.descendantsReaped).toBe(false);
            expect(status.action === 'status' && status.remoteMayContinue).toBe(true);
            expect(status.action === 'status' && status.processGroupEvidence.kind).toBe('no-local-trace');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('rejects shell interpreters, shell-shaped args, and paths outside the workspace', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-machine-run-'));
        try {
            const handler = createTypedMachineRunHandler(root);
            await expect(handler({ version: 1, action: 'start', executable: 'sh', args: ['-c', 'id'] })).rejects.toThrow('MACHINE_RUN_INVALID');
            await expect(handler({ version: 1, action: 'start', executable: 'printf', args: ['ok;id'] })).rejects.toThrow('MACHINE_RUN_INVALID');
            await expect(handler({ version: 1, action: 'start', executable: 'printf', args: ['ok'], cwd: '/' })).rejects.toThrow('MACHINE_RUN_PATH_DENIED');
            await expect(handler({ version: 1, action: 'start', executable: 'printf', args: ['ok'], cwd: join(root, 'missing') })).rejects.toThrow('MACHINE_RUN_PATH_DENIED');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('caps output and exposes cancellation as a terminal state', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-machine-run-'));
        try {
            const handler = createTypedMachineRunHandler(root);
            const started = await handler({ version: 1, action: 'start', executable: 'printf', args: ['123456789'], cwd: root, outputLimitBytes: 4 });
            if (started.action !== 'start') return;
            await new Promise((resolve) => setTimeout(resolve, 100));
            await expect(handler({ version: 1, action: 'status', operationId: started.operationId })).resolves.toMatchObject({ truncated: true, stdout: '1234' });
            const waiting = await handler({ version: 1, action: 'start', executable: 'sleep', args: ['2'], cwd: root, timeoutMs: 2_000 });
            if (waiting.action !== 'start') return;
            await expect(handler({ version: 1, action: 'cancel', operationId: waiting.operationId })).resolves.toMatchObject({ action: 'cancel', state: 'cancelled', descendantsReaped: false, remoteMayContinue: true });
            await new Promise((resolve) => setTimeout(resolve, 100));
            await expect(handler({ version: 1, action: 'status', operationId: waiting.operationId })).resolves.toMatchObject({ state: 'cancelled', descendantsReaped: false, remoteMayContinue: true, processGroupEvidence: { kind: 'no-local-trace' } });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('escalates a SIGTERM-ignoring process group to SIGKILL after grace', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-machine-run-'));
        try {
            const handler = createTypedMachineRunHandler(root);
            const started = await handler({ version: 1, action: 'start', executable: 'ruby', args: ['-e', 'Signal.trap(:TERM, "IGNORE").tap { sleep 5 }'], cwd: root, timeoutMs: 20, timeoutGraceMs: 20 });
            if (started.action !== 'start') return;
            await new Promise((resolve) => setTimeout(resolve, 150));
            await expect(handler({ version: 1, action: 'status', operationId: started.operationId })).resolves.toMatchObject({ state: 'failed', timedOut: true, descendantsReaped: false, remoteMayContinue: true, processGroupEvidence: { kind: 'no-local-trace' } });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('enforces an active operation quota while retaining terminal results', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-machine-run-'));
        const operationIds: string[] = [];
        const handler = createTypedMachineRunHandler(root);
        try {
            for (let index = 0; index < 32; index++) {
                const started = await handler({ version: 1, action: 'start', executable: 'sleep', args: ['5'], cwd: root });
                if (started.action === 'start') operationIds.push(started.operationId);
            }
            await expect(handler({ version: 1, action: 'start', executable: 'sleep', args: ['5'], cwd: root })).rejects.toThrow('MACHINE_RUN_QUOTA_EXCEEDED');
            for (const operationId of operationIds) await handler({ version: 1, action: 'cancel', operationId });
            await expect(handler({ version: 1, action: 'start', executable: 'printf', args: ['blocked'], cwd: root })).rejects.toThrow('MACHINE_RUN_QUOTA_EXCEEDED');
            await new Promise((resolve) => setTimeout(resolve, 150));
            const completed = await handler({ version: 1, action: 'start', executable: 'printf', args: ['retained'], cwd: root });
            expect(completed.action).toBe('start');
        } finally {
            for (const operationId of operationIds) {
                try { await handler({ version: 1, action: 'cancel', operationId }); } catch { /* already exited */ }
            }
            await rm(root, { recursive: true, force: true });
        }
    });

    it('bounds terminal retention even when remote continuation remains unresolved', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-machine-run-'));
        const handler = createTypedMachineRunHandler(root);
        const operationIds: string[] = [];
        try {
            for (let index = 0; index < 129; index++) {
                const started = await handler({ version: 1, action: 'start', executable: 'printf', args: [String(index)], cwd: root, timeoutMs: 2_000 });
                if (started.action !== 'start') throw new Error('machine-run start did not return an operation');
                operationIds.push(started.operationId);
                const terminal = await waitForTerminal(handler, started.operationId);
                expect(terminal.remoteMayContinue).toBe(true);
                expect(terminal.descendantsReaped).toBe(false);
                expect(terminal.processGroupEvidence).toEqual({ kind: 'no-local-trace' });
            }

            // A status request runs retention before looking up the operation.
            await expect(handler({ version: 1, action: 'status', operationId: operationIds.at(-1)! })).resolves.toMatchObject({ state: 'passed' });
            await expect(handler({ version: 1, action: 'status', operationId: operationIds[0] })).rejects.toThrow('MACHINE_RUN_NOT_FOUND');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('does not let spawn failures exhaust the active-operation quota', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-machine-run-'));
        const handler = createTypedMachineRunHandler(root);
        try {
            const ids: string[] = [];
            for (let index = 0; index < 32; index++) {
                const started = await handler({ version: 1, action: 'start', executable: 'definitely-missing-machine-run-binary', args: [], cwd: root, timeoutMs: 2_000 });
                if (started.action !== 'start') throw new Error('machine-run start did not return an operation');
                ids.push(started.operationId);
            }
            for (const id of ids) await waitForTerminal(handler, id);
            await expect(handler({ version: 1, action: 'start', executable: 'definitely-missing-machine-run-binary', args: [], cwd: root, timeoutMs: 2_000 })).resolves.toMatchObject({ action: 'start', state: 'accepted' });
            for (const id of ids) await expect(handler({ version: 1, action: 'status', operationId: id })).resolves.toMatchObject({ state: 'failed' });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('keeps a surviving-leader observation as no-local-trace evidence', () => {
        const deps = { kill: (target: number, signal: NodeJS.Signals | 0) => { if (signal === 0) throw Object.assign(new Error('gone leader'), { code: 'ESRCH' }); }, sleep: async () => {}, now: Date.now };
        expect(probeProcessGroup(4242, deps)).toEqual({ kind: 'no-local-trace' });
    });

    it('keeps unknown signal failures indeterminate', () => {
        const deps = { kill: () => { throw Object.assign(new Error('unexpected'), { code: 'EIO' }); }, sleep: async () => {}, now: Date.now };
        expect(signalProcessGroup(4242, 'SIGTERM', deps)).toEqual({ kind: 'indeterminate', detail: 'EIO' });
        expect(probeProcessGroup(4242, deps)).toEqual({ kind: 'indeterminate', detail: 'EIO' });
    });
});
