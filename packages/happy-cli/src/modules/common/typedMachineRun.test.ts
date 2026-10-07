import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTypedMachineRunHandler } from './typedMachineRun';

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
            expect(status.action === 'status' && status.descendantsReaped).toBe(true);
            expect(status.action === 'status' && status.remoteMayContinue).toBe(false);
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
            await expect(handler({ version: 1, action: 'cancel', operationId: waiting.operationId })).resolves.toMatchObject({ action: 'cancel', state: 'cancelled' });
            await new Promise((resolve) => setTimeout(resolve, 100));
            await expect(handler({ version: 1, action: 'status', operationId: waiting.operationId })).resolves.toMatchObject({ state: 'cancelled', descendantsReaped: true, remoteMayContinue: false });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('escalates a timed out process group after the configured grace period', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happy-machine-run-'));
        try {
            const handler = createTypedMachineRunHandler(root);
            const started = await handler({ version: 1, action: 'start', executable: 'sleep', args: ['5'], cwd: root, timeoutMs: 20, timeoutGraceMs: 20 });
            if (started.action !== 'start') return;
            await new Promise((resolve) => setTimeout(resolve, 150));
            await expect(handler({ version: 1, action: 'status', operationId: started.operationId })).resolves.toMatchObject({ state: 'failed', timedOut: true, descendantsReaped: true, remoteMayContinue: false });
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
            const completed = await handler({ version: 1, action: 'start', executable: 'printf', args: ['retained'], cwd: root });
            expect(completed.action).toBe('start');
        } finally {
            for (const operationId of operationIds) {
                try { await handler({ version: 1, action: 'cancel', operationId }); } catch { /* already exited */ }
            }
            await rm(root, { recursive: true, force: true });
        }
    });
});
