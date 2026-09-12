/**
 * Preparing a managed volume at boot, end to end.
 *
 * The restore itself belongs to `CheckpointRestoreExecutor`: it owns the plan,
 * the ledger binding, the safety checkpoint and the exclusion policy. What it
 * does **not** provide is what a boot producer needs around it, and an audit of
 * that pipeline is the reason each of these exists:
 *
 *  - its serialization is an in-process `Map` keyed by project path, so two
 *    daemons on one volume are not excluded from each other;
 *  - it never calls `fsync`, so a crash after a successful restore can leave a
 *    completion record standing over files that never reached the disk;
 *  - `partial` is a normal result, so "it returned" is not "it completed".
 *
 * The producer closes those three, then publishes the root-protected record.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { prepareManagedVolume, type ManagedRestorePort } from '@/managed/managedRuntimeBootstrap';
import { readManagedRestoreState, type ManagedVolumeIdentity } from '@/managed/managedRestoreState';
import { probeIsolationBackendUnavailable, type ManagedProvisioningDeps } from '@/daemon/managedRuntimeIdentity';

let base: string;
let stateDir: string;
let workspace: string;

const DAEMON_UID = process.getuid?.() ?? 0;
const VOLUME: ManagedVolumeIdentity = {
    volumeId: 'vol_abc123', deviceUuid: 'uuid-1', createdByThisOperation: true,
};
const EXISTING: ManagedVolumeIdentity = { ...VOLUME, createdByThisOperation: false };

function deps(): ManagedProvisioningDeps {
    return {
        getuid: () => DAEMON_UID,
        lstatDir: () => ({ uid: 0, mode: 0o40755, isDirectory: true, isSymbolicLink: false }),
        statGate: () => null,
        probeIsolationBackend: probeIsolationBackendUnavailable,
    };
}

const checkpoint = { checkpointId: 'ckpt-1', plan: { entries: [] }, binding: { runId: 'r' } };

type RestoreResult = Awaited<ReturnType<ManagedRestorePort['execute']>>;

function restorePort(
    result: RestoreResult = { status: 'completed', entries: [] },
): ManagedRestorePort & { execute: ReturnType<typeof vi.fn> } {
    return { execute: vi.fn(async () => result) };
}

/** A lock a second producer would also have to take. */
function lockPort() {
    let held = 0;
    let maxHeld = 0;
    return {
        maxHeld: () => maxHeld,
        withLock: async <T>(action: () => Promise<T>): Promise<T> => {
            held += 1;
            maxHeld = Math.max(maxHeld, held);
            try {
                return await action();
            } finally {
                held -= 1;
            }
        },
    };
}

beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'managed-boot-'));
    stateDir = join(base, 'state');
    workspace = join(base, 'project');
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    mkdirSync(workspace, { recursive: true });
});

afterEach(() => {
    rmSync(base, { recursive: true, force: true });
});

describe('preparing a managed volume at boot', () => {
    it('restores, verifies, flushes and only then records', async () => {
        const restore = restorePort();
        const lock = lockPort();
        const synced: string[] = [];

        const state = await prepareManagedVolume({
            stateDir, workspace, volume: VOLUME, checkpoint, restore,
            withProducerLock: lock.withLock,
            syncDirectory: async (path: string) => { synced.push(path); },
            deps: deps(),
        });

        expect(restore.execute).toHaveBeenCalledTimes(1);
        expect(state).toMatchObject({ status: 'restored', checkpointId: 'ckpt-1' });
        // The workspace reached the disk before the record claiming it did.
        expect(synced).toContain(workspace);
        expect(readManagedRestoreState({ stateDir, volume: VOLUME, deps: deps() })).toEqual(state);
    });

    it('holds one lock across the whole producer, not just the restore', async () => {
        // The executor serializes within a process. Two daemons on one volume
        // are two processes, and the window that matters spans the restore,
        // the verification and the publish together.
        const lock = lockPort();
        const order: string[] = [];
        const restore: ManagedRestorePort = {
            execute: vi.fn(async () => {
                order.push('restore');
                return { status: 'completed' as const, entries: [] };
            }),
        };
        await prepareManagedVolume({
            stateDir, workspace, volume: VOLUME, checkpoint, restore,
            withProducerLock: async <T>(action: () => Promise<T>) => {
                order.push('lock-taken');
                const value = await lock.withLock(action);
                order.push('lock-released');
                return value;
            },
            syncDirectory: async () => {},
            deps: deps(),
        });
        expect(order).toEqual(['lock-taken', 'restore', 'lock-released']);
        expect(lock.maxHeld()).toBe(1);
    });

    it.each([
        ['partial', { status: 'partial', entries: [] }],
        ['stale-plan', { status: 'stale-plan' }],
        ['cancelled', { status: 'cancelled' }],
    ] as Array<[string, RestoreResult]>)('records nothing when the restore came back %s', async (_name, result) => {
        // `partial` is a normal result of that executor, not an exception. A
        // producer that treated "it returned" as "it completed" would publish a
        // record over a workspace missing files nobody will notice.
        await expect(prepareManagedVolume({
            stateDir, workspace, volume: VOLUME, checkpoint, restore: restorePort(result),
            withProducerLock: lockPort().withLock,
            syncDirectory: async () => {},
            deps: deps(),
        })).rejects.toThrow(/restore did not complete/i);
        expect(readManagedRestoreState({ stateDir, volume: VOLUME, deps: deps() }))
            .toMatchObject({ status: 'pending' });
    });

    it('records nothing when an entry failed inside a completed restore', async () => {
        const result: RestoreResult = {
            status: 'completed',
            entries: [{ outcome: 'failed' }],
        };
        await expect(prepareManagedVolume({
            stateDir, workspace, volume: VOLUME, checkpoint, restore: restorePort(result),
            withProducerLock: lockPort().withLock,
            syncDirectory: async () => {},
            deps: deps(),
        })).rejects.toThrow(/entr/i);
        expect(readManagedRestoreState({ stateDir, volume: VOLUME, deps: deps() }))
            .toMatchObject({ status: 'pending' });
    });

    it('records an empty initialisation without calling the restore at all', async () => {
        const restore = restorePort();
        const state = await prepareManagedVolume({
            stateDir, workspace, volume: VOLUME, checkpoint: null, restore,
            withProducerLock: lockPort().withLock,
            syncDirectory: async () => {},
            deps: deps(),
        });
        expect(restore.execute).not.toHaveBeenCalled();
        expect(state.status).toBe('empty-initialized');
    });

    it('adopts a prepared volume without restoring over it', async () => {
        await prepareManagedVolume({
            stateDir, workspace, volume: VOLUME, checkpoint, restore: restorePort(),
            withProducerLock: lockPort().withLock,
            syncDirectory: async () => {},
            deps: deps(),
        });
        const second = restorePort();
        const state = await prepareManagedVolume({
            stateDir, workspace, volume: EXISTING, checkpoint, restore: second,
            withProducerLock: lockPort().withLock,
            syncDirectory: async () => {},
            deps: deps(),
        });
        // The volume already holds work; restoring over it would destroy it.
        expect(second.execute).not.toHaveBeenCalled();
        expect(state).toMatchObject({ status: 'restored', checkpointId: 'ckpt-1' });
    });

    it('refuses to touch a volume this operation did not create', async () => {
        const restore = restorePort();
        await expect(prepareManagedVolume({
            stateDir, workspace, volume: EXISTING, checkpoint, restore,
            withProducerLock: lockPort().withLock,
            syncDirectory: async () => {},
            deps: deps(),
        })).rejects.toThrow(/not created by this operation/i);
        expect(restore.execute).not.toHaveBeenCalled();
    });

    it('leaves no record when flushing the workspace fails', async () => {
        await expect(prepareManagedVolume({
            stateDir, workspace, volume: VOLUME, checkpoint, restore: restorePort(),
            withProducerLock: lockPort().withLock,
            syncDirectory: async () => { throw new Error('device full'); },
            deps: deps(),
        })).rejects.toThrow(/device full/);
        expect(existsSync(join(stateDir, 'restore-manifest.json'))).toBe(false);
    });
});

/**
 * The producer with nothing injected: a real checkpoint store lock, a real
 * flush of a real tree, and a real record on disk.
 */
describe('preparing a volume with the real boundary', () => {
    it('flushes the restored tree and publishes the record', async () => {
        const { execFileSync } = await import('node:child_process');
        const checkpointRoot = join(base, 'checkpoints');
        mkdirSync(join(checkpointRoot, 'store'), { recursive: true });
        execFileSync('git', ['init', '--bare', '--quiet', join(checkpointRoot, 'store')]);

        const { writeFileSync } = await import('node:fs');
        mkdirSync(join(workspace, 'nested'), { recursive: true });
        writeFileSync(join(workspace, 'nested', 'restored.txt'), 'from the checkpoint');

        const state = await prepareManagedVolume({
            stateDir,
            workspace,
            volume: VOLUME,
            checkpoint,
            restore: restorePort(),
            checkpointRoot,
            deps: deps(),
        });

        expect(state).toMatchObject({ status: 'restored', checkpointId: 'ckpt-1' });
        expect(readManagedRestoreState({ stateDir, volume: VOLUME, deps: deps() })).toEqual(state);
        // The file the restore produced is still there and readable.
        expect(statSync(join(workspace, 'nested', 'restored.txt')).size).toBeGreaterThan(0);
    }, 60_000);

    it('publishes nothing when the restore did not complete', async () => {
        const { execFileSync } = await import('node:child_process');
        const checkpointRoot = join(base, 'checkpoints');
        mkdirSync(join(checkpointRoot, 'store'), { recursive: true });
        execFileSync('git', ['init', '--bare', '--quiet', join(checkpointRoot, 'store')]);

        await expect(prepareManagedVolume({
            stateDir,
            workspace,
            volume: VOLUME,
            checkpoint,
            restore: restorePort({ status: 'partial', entries: [] }),
            checkpointRoot,
            deps: deps(),
        })).rejects.toThrow(/did not complete/i);
        expect(existsSync(join(stateDir, 'restore-manifest.json'))).toBe(false);
    }, 60_000);
});
