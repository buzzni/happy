import { appendFile, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CheckpointLedger } from './checkpointLedger';
import { CheckpointStore, resolveCheckpointStoreLayout } from './checkpointStore';

describe('CheckpointLedger', () => {
    let fixtureRoot: string;
    let checkpointRoot: string;
    let projectPath: string;
    const binding = {
        sessionId: 'session-1',
        projectId: 'project-1',
        worktreeId: null,
    };

    beforeEach(async () => {
        fixtureRoot = await mkdtemp(join(tmpdir(), 'happy-checkpoint-ledger-'));
        checkpointRoot = join(fixtureRoot, 'checkpoints');
        projectPath = join(fixtureRoot, 'project');
        await mkdir(projectPath);
        await writeFile(join(projectPath, 'tracked.txt'), 'before');
        await new CheckpointStore(checkpointRoot).snapshotTurn({
            ...binding,
            operationId: 'turn-1',
            projectPath,
        });
    });

    afterEach(async () => {
        await rm(fixtureRoot, { recursive: true, force: true });
    });

    it('replays durable write and delete provenance after restart', async () => {
        const ledger = new CheckpointLedger(checkpointRoot);
        await writeFile(join(projectPath, 'tracked.txt'), 'agent version');
        const written = await ledger.recordMutation({
            ...binding,
            operationId: 'turn-1',
            mutationId: 'mutation-1',
            projectPath,
            path: 'tracked.txt',
            action: 'written',
        });
        await unlink(join(projectPath, 'tracked.txt'));
        const deleted = await ledger.recordMutation({
            ...binding,
            operationId: 'turn-1',
            mutationId: 'mutation-2',
            projectPath,
            path: 'tracked.txt',
            action: 'deleted',
        });

        const replayed = await new CheckpointLedger(checkpointRoot).readRecords({
            ...binding,
            projectPath,
        });

        expect(written.contentHash).toMatch(/^[a-f0-9]{64}$/);
        expect(deleted.contentHash).toBeNull();
        expect(replayed).toEqual([written, deleted]);
    });

    it('appends one record for an idempotent mutation retry and rejects key reuse', async () => {
        const ledger = new CheckpointLedger(checkpointRoot);
        await writeFile(join(projectPath, 'tracked.txt'), 'agent version');
        const request = {
            ...binding,
            operationId: 'turn-1',
            mutationId: 'mutation-1',
            projectPath,
            path: 'tracked.txt',
            action: 'written' as const,
        };

        const first = await ledger.recordMutation(request);
        const retry = await ledger.recordMutation(request);
        await expect(ledger.recordMutation({
            ...request,
            path: 'other.txt',
        })).rejects.toThrow('ledger idempotency key conflict');

        expect(retry).toEqual(first);
        expect(await ledger.readRecords({ ...binding, projectPath })).toHaveLength(1);
    });

    it('serializes an idempotent retry across ledger instances', async () => {
        await writeFile(join(projectPath, 'tracked.txt'), 'agent version');
        const request = {
            ...binding,
            operationId: 'turn-1',
            mutationId: 'mutation-1',
            projectPath,
            path: 'tracked.txt',
            action: 'written' as const,
        };

        const [first, retry] = await Promise.all([
            new CheckpointLedger(checkpointRoot).recordMutation(request),
            new CheckpointLedger(checkpointRoot).recordMutation(request),
        ]);

        const layout = resolveCheckpointStoreLayout({ checkpointRoot, ...binding });
        expect(retry).toEqual(first);
        expect((await readFile(layout.ledgerFile, 'utf8')).trim().split('\n')).toHaveLength(1);
    });

    it('drops a crash-partial tail before appending the next valid record', async () => {
        const ledger = new CheckpointLedger(checkpointRoot);
        await writeFile(join(projectPath, 'tracked.txt'), 'first');
        await ledger.recordMutation({
            ...binding,
            operationId: 'turn-1',
            mutationId: 'mutation-1',
            projectPath,
            path: 'tracked.txt',
            action: 'written',
        });
        const layout = resolveCheckpointStoreLayout({ checkpointRoot, ...binding });
        await appendFile(layout.ledgerFile, '{"schemaVersion":1,"operationId":"partial');
        await writeFile(join(projectPath, 'tracked.txt'), 'second');

        await new CheckpointLedger(checkpointRoot).recordMutation({
            ...binding,
            operationId: 'turn-2',
            mutationId: 'mutation-2',
            projectPath,
            path: 'tracked.txt',
            action: 'written',
        });

        const contents = await readFile(layout.ledgerFile, 'utf8');
        expect(contents).not.toContain('partial');
        expect(contents.trim().split('\n')).toHaveLength(2);
        expect(await ledger.readRecords({ ...binding, projectPath })).toHaveLength(2);
    });

    it('requires a prior snapshot binding and rejects paths outside the project', async () => {
        const unbound = new CheckpointLedger(join(fixtureRoot, 'unbound-checkpoints'));
        await expect(unbound.recordMutation({
            ...binding,
            operationId: 'turn-1',
            mutationId: 'mutation-1',
            projectPath,
            path: 'tracked.txt',
            action: 'written',
        })).rejects.toThrow('checkpoint binding is required before ledger writes');

        await expect(new CheckpointLedger(checkpointRoot).recordMutation({
            ...binding,
            operationId: 'turn-1',
            mutationId: 'mutation-1',
            projectPath,
            path: '../outside.txt',
            action: 'written',
        })).rejects.toThrow('ledger path must be project-relative');
    });

    it('fails closed on a complete journal record with an unsafe identifier or path', async () => {
        const layout = resolveCheckpointStoreLayout({ checkpointRoot, ...binding });
        await mkdir(join(layout.gitDirectory, 'ledgers'), { recursive: true });
        await appendFile(layout.ledgerFile, `${JSON.stringify({
            schemaVersion: 1,
            operationId: 'turn\n1',
            mutationId: 'mutation-1',
            path: '../outside.txt',
            action: 'written',
            contentHash: 'a'.repeat(64),
            timestamp: 1,
        })}\n`);

        await expect(new CheckpointLedger(checkpointRoot).readRecords({
            ...binding,
            projectPath,
        })).rejects.toThrow('checkpoint ledger contains a corrupt record');
    });
});
