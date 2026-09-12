/**
 * The daemon's own leaf, and the layouts it refuses to interpret.
 *
 * Phase 1 of the non-root daemon work is only this: the daemon writes in one
 * place it could own, and a runtime whose state is still in the old place is
 * **refused** rather than migrated. Several renames cannot promise "nothing
 * moved" when one of them fails, and a half-moved receipt store is worse than a
 * boot that stops: an empty leaf beside a populated old layout restarts receipt
 * de-duplication and reads epoch 0 / seq 0, which re-admits spent requests and
 * accepts stale leases.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
    managedDaemonStateDir,
    inspectManagedDaemonStateLayout,
    inspectManagedDaemonStateLeaf,
} from './managedDaemonStateLayout';
import { createManagedReceiptStore, managedOperationKey } from './managedReceiptStore';
import { probeIsolationBackendUnavailable, trustedPathRefusal } from './managedRuntimeIdentity';

const created: string[] = [];

function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), 'daemon-leaf-'));
    created.push(dir);
    return dir;
}

afterEach(() => {
    // The fixtures are temp directories; nothing here is chowned or moved.
    created.length = 0;
});

describe('where the daemon may write', () => {
    it('shouldPutTheStoreInALeafOfItsOwnRatherThanTheStateRoot', () => {
        // The state directory holds root's records. The daemon's store must not
        // share a directory with them, or "the daemon may write here" and "root
        // records live here" become one permission.
        expect(managedDaemonStateDir('/var/lib/saycode')).toBe('/var/lib/saycode/daemon');
    });
});

describe('layouts the daemon refuses to interpret', () => {
    it('shouldAcceptAStateDirectoryWithNothingButTheLeaf', () => {
        const stateDir = scratch();
        mkdirSync(join(stateDir, 'daemon'), { mode: 0o700 });
        expect(inspectManagedDaemonStateLayout(stateDir)).toEqual({ usable: true });
    });

    it('shouldAcceptAStateDirectoryWhereTheLeafDoesNotExistYet', () => {
        // The boot creates it; a first start before that is not a bad layout.
        expect(inspectManagedDaemonStateLayout(scratch())).toEqual({ usable: true });
    });

    for (const legacy of ['receipts', 'tmp', 'lease.json']) {
        it(`shouldRefuseWhenTheOldLayoutStillHolds ${legacy}`, () => {
            const stateDir = scratch();
            if (legacy === 'lease.json') writeFileSync(join(stateDir, legacy), '{}\n');
            else mkdirSync(join(stateDir, legacy), { mode: 0o700 });

            expect(inspectManagedDaemonStateLayout(stateDir))
                .toEqual({ usable: false, reason: 'state-layout-old', detail: legacy });
        });
    }

    it('shouldRefuseWhenBothLayoutsArePresentRatherThanChoosingOne', () => {
        /*
         * Two stores for one runtime: whichever is read, the other's receipts
         * and lease are invisible. Choosing silently is how a spent request gets
         * admitted a second time.
         */
        const stateDir = scratch();
        mkdirSync(join(stateDir, 'daemon'), { mode: 0o700 });
        mkdirSync(join(stateDir, 'receipts'), { mode: 0o700 });
        expect(inspectManagedDaemonStateLayout(stateDir))
            .toEqual({ usable: false, reason: 'state-layout-dual', detail: 'receipts' });
    });

    it('shouldRefuseALeafThatIsNotADirectory', () => {
        const stateDir = scratch();
        writeFileSync(join(stateDir, 'daemon'), 'not a directory\n');
        expect(inspectManagedDaemonStateLayout(stateDir))
            .toEqual({ usable: false, reason: 'state-layout-unusable', detail: 'daemon: not a directory' });
    });

    it('shouldRefuseALeafThatIsASymlinkRatherThanFollowIt', () => {
        // A link means the bytes are somewhere nobody checked.
        const stateDir = scratch();
        const elsewhere = scratch();
        symlinkSync(elsewhere, join(stateDir, 'daemon'));
        expect(inspectManagedDaemonStateLayout(stateDir))
            .toEqual({ usable: false, reason: 'state-layout-unusable', detail: 'daemon: symlink' });
    });

    it('shouldRefuseALegacyPathThatIsASymlink', () => {
        const stateDir = scratch();
        symlinkSync(scratch(), join(stateDir, 'receipts'));
        expect(inspectManagedDaemonStateLayout(stateDir))
            .toEqual({ usable: false, reason: 'state-layout-old', detail: 'receipts' });
    });

    it('shouldRefuseAStateDirectoryItCannotRead', () => {
        // Not knowing is not "clear". A state directory that cannot be listed is
        // a layout nobody has established.
        expect(inspectManagedDaemonStateLayout(join(scratch(), 'absent')))
            .toEqual({ usable: false, reason: 'state-layout-unusable', detail: 'state dir: ENOENT' });
    });
});

describe('the store in the leaf, and who may own it', () => {
    /*
     * Layout B's failure, reproduced and then shown fixed: `writeLease` renames
     * into the **store root**, so a store rooted at the `0755 root` state
     * directory cannot be written by anything that is not root. Rooted at a leaf
     * the writer owns, every operation succeeds.
     *
     * No uid is changed here. The property under test is "the store writes inside
     * its own root", which is what makes a non-root daemon possible at all.
     */
    it('shouldWriteReceiptsAndTheLeaseInsideItsOwnRoot', () => {
        const stateDir = scratch();
        const leaf = managedDaemonStateDir(stateDir);
        mkdirSync(leaf, { mode: 0o700 });
        const store = createManagedReceiptStore(leaf, { assertHeld: () => {} });

        const key = managedOperationKey({ runId: 'run-1', attemptId: 'attempt-1' });
        expect(store.claim({
            requestKey: key,
            runId: 'run-1',
            attemptId: 'attempt-1',
            epoch: 0,
            workspaceId: 'ws-1',
            projectId: 'pr-1',
            spawnPayloadDigest: 'a'.repeat(64),
            now: 1,
        }).kind).toBe('created');
        store.writeLease({ epoch: 1, renewalSeq: 1, updatedAt: 1 });
        expect(store.readLease()).toMatchObject({ kind: 'ok' });

        // 그리고 그 바이트는 leaf 안에 있다 — state 루트가 아니라.
        expect(existsSync(join(leaf, 'lease.json'))).toBe(true);
        expect(existsSync(join(stateDir, 'lease.json'))).toBe(false);
        expect(existsSync(join(leaf, 'receipts'))).toBe(true);
    });

    it('shouldNotAcceptTheRunningUidAsEvidenceOfTheConfiguredOwner', () => {
        /*
         * `componentRefusal` accepts a component owned by root **or** the subject
         * uid it is given, and every caller passes `deps.getuid()` — the *running*
         * uid. So the same directory answers differently depending on who asks,
         * and while the daemon is still root, `getuid() === 0` would accept a
         * root-owned leaf that the **configured** daemon account does not own.
         *
         * The stats are injected rather than taken from disk: a real temp
         * directory sits under a world-writable `/tmp`, which refuses for an
         * unrelated reason and would hide the one under test.
         */
        const leafPath = '/var/lib/saycode/daemon';
        const deps = {
            getuid: () => 0,
            lstatDir: (path: string) => ({
                // Every component root-owned and not group/world writable: the
                // layout this slice creates while the daemon is still root.
                uid: 0,
                mode: path === leafPath ? 0o40700 : 0o40755,
                isDirectory: true,
                isSymbolicLink: false,
            }),
            statGate: () => null,
            probeIsolationBackend: probeIsolationBackendUnavailable,
        };

        // 실행 uid(0)로 물으면 통과한다 — 소유자가 root 이므로.
        expect(trustedPathRefusal(leafPath, deps.getuid(), 'state-dir-unsafe', deps)).toBeNull();
        /*
         * 설정된 계정(999)으로 물어도 **통과한다** — root 소유는 언제나 허용되기
         * 때문이다. 즉 이 검사는 "설정된 계정이 소유한다" 를 확인하지 못한다.
         * 그래서 phase 2 가 leaf 소유권을 확인하려면 이 함수가 아니라 소유자 비교가
         * 필요하다. 아래가 그 사실을 고정한다.
         */
        expect(trustedPathRefusal(leafPath, 999, 'state-dir-unsafe', deps)).toBeNull();

        // 그리고 계정이 소유한 leaf 는 root 호출자에게 거절된다 — 같은 디렉터리,
        // 다른 주체. `getuid()` 는 설정된 소유자를 대신할 수 없다.
        const ownedByAccount = {
            ...deps,
            lstatDir: (path: string) => ({
                uid: path === leafPath ? 999 : 0,
                mode: path === leafPath ? 0o40700 : 0o40755,
                isDirectory: true,
                isSymbolicLink: false,
            }),
        };
        expect(trustedPathRefusal(leafPath, 0, 'state-dir-unsafe', ownedByAccount))
            .toMatchObject({ reason: 'state-dir-unsafe' });
        expect(trustedPathRefusal(leafPath, 999, 'state-dir-unsafe', ownedByAccount)).toBeNull();
    });
});

describe('provisioning the leaf: create, or verify what is already there', () => {
    /*
     * The leaf may already hold a live store. Changing its mode or owner on a
     * later boot would mutate state this boot did not write — and the daemon may
     * be running against it at that moment, since nothing here holds the daemon's
     * writer lock. So provisioning **creates**, and an existing leaf is verified
     * rather than corrected: exactly the expected owner and mode, or a refusal.
     */
    const account = { uid: 999, gid: 999 };

    it('shouldAcceptALeafThatAlreadyHasExactlyTheExpectedOwnerAndMode', () => {
        expect(inspectManagedDaemonStateLeaf({
            kind: 'dir', uid: 999, gid: 999, mode: 0o700,
        }, account)).toEqual({ ok: true, create: false });
    });

    it('shouldAskForCreationWhenTheLeafIsAbsent', () => {
        expect(inspectManagedDaemonStateLeaf({ kind: 'absent' }, account))
            .toEqual({ ok: true, create: true });
    });

    it('shouldRefuseAnExistingLeafOwnedBySomebodyElseRatherThanChownIt', () => {
        // 살아 있는 store 의 소유자를 바꾸는 것은 되돌릴 수 없다.
        expect(inspectManagedDaemonStateLeaf({
            kind: 'dir', uid: 0, gid: 0, mode: 0o700,
        }, account)).toEqual({ ok: false, detail: 'owner' });
    });

    it('shouldRefuseAnExistingLeafWithADifferentModeRatherThanChmodIt', () => {
        expect(inspectManagedDaemonStateLeaf({
            kind: 'dir', uid: 999, gid: 999, mode: 0o750,
        }, account)).toEqual({ ok: false, detail: 'mode' });
    });

    it('shouldRefuseALeafThatIsNotADirectoryOrCannotBeRead', () => {
        expect(inspectManagedDaemonStateLeaf({ kind: 'file' }, account))
            .toEqual({ ok: false, detail: 'not-a-directory' });
        expect(inspectManagedDaemonStateLeaf({ kind: 'symlink' }, account))
            .toEqual({ ok: false, detail: 'symlink' });
        expect(inspectManagedDaemonStateLeaf({ kind: 'unreadable' }, account))
            .toEqual({ ok: false, detail: 'unreadable' });
    });
});
