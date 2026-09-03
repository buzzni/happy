import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CheckpointProtectionStateStore } from './checkpointProtectionState';

describe('CheckpointProtectionStateStore', () => {
    let root: string;
    let projectPath: string;
    const binding = {
        sessionId: 'session-1',
        projectId: 'project-1',
        worktreeId: null,
    } as const;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'happy-checkpoint-protection-'));
        projectPath = join(root, 'project');
        await mkdir(projectPath);
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it('durably records only relative excluded paths and retry warnings', async () => {
        const store = new CheckpointProtectionStateStore(join(root, 'checkpoints'));

        await store.reportPending({
            ...binding,
            projectPath,
            operationId: 'turn-1',
            source: 'policy-drift',
            excluded: [{ path: '.env.production', reason: 'secret' }],
        });

        await expect(new CheckpointProtectionStateStore(join(root, 'checkpoints')).read({
            ...binding,
            projectPath,
        })).resolves.toEqual({
            protection: { status: 'protected' },
            pendingDecision: {
                operationId: 'turn-1',
                source: 'policy-drift',
                excluded: [{ path: '.env.production', reason: 'secret' }],
                warnings: {
                    partialExecutionPossible: true,
                    externalSideEffectsMayRepeat: true,
                },
            },
        });
    });

    it('keeps protection enabled on cancel and rejects a stale operation decision', async () => {
        const store = new CheckpointProtectionStateStore(join(root, 'checkpoints'));
        await store.reportPending({
            ...binding,
            projectPath,
            operationId: 'turn-current',
            source: 'turn-apply',
            excluded: [{ path: 'large.bin', reason: 'too-large' }],
        });

        await expect(store.resolveDecision({
            ...binding,
            projectPath,
            operationId: 'turn-stale',
            decision: 'cancel',
        })).rejects.toThrow('pending operation mismatch');
        await expect(store.resolveDecision({
            ...binding,
            projectPath,
            operationId: 'turn-current',
            decision: 'cancel',
        })).resolves.toEqual({ protection: { status: 'protected' }, pendingDecision: null });
    });

    it('persists explicit protection disable across store instances', async () => {
        const checkpointRoot = join(root, 'checkpoints');
        const store = new CheckpointProtectionStateStore(checkpointRoot);
        await store.reportPending({
            ...binding,
            projectPath,
            operationId: 'turn-1',
            source: 'policy-drift',
            excluded: [],
        });

        await expect(store.resolveDecision({
            ...binding,
            projectPath,
            operationId: 'turn-1',
            decision: 'disable-protection',
        })).resolves.toEqual({
            protection: { status: 'unavailable', reason: 'excluded-path' },
            pendingDecision: null,
        });
        await expect(new CheckpointProtectionStateStore(checkpointRoot).read({
            ...binding,
            projectPath,
        })).resolves.toEqual({
            protection: { status: 'unavailable', reason: 'excluded-path' },
            pendingDecision: null,
        });
    });

    it.each([
        '/absolute',
        '../outside',
        'C:outside.txt',
        'safe\0secret',
    ])('rejects an unsafe pending path: %j', async (path) => {
        const store = new CheckpointProtectionStateStore(join(root, 'checkpoints'));
        await expect(store.reportPending({
            ...binding,
            projectPath,
            operationId: 'turn-1',
            source: 'policy-drift',
            excluded: [{ path, reason: 'secret' }],
        })).rejects.toThrow('project-relative');
    });
});
