/**
 * Where a managed daemon keeps its own state, and which layouts it refuses.
 *
 * The state directory holds **root's** records — the launcher binding, the volume
 * seal, the adopted credential, the restore record — and it is `0755 root:root` so
 * that nothing else can replace them. The daemon's receipt store cannot live in
 * that directory and also be writable by a non-root daemon: "the daemon may write
 * here" and "root's records live here" would be one permission.
 *
 * So the store gets a leaf of its own, and this module answers the only question
 * that has to be settled before it is used: is this runtime's state in a layout
 * that can be read at all?
 *
 * ## Refuse, never migrate
 *
 * A runtime whose receipts and lease are still in the old place is **refused**.
 * It is not moved:
 *
 *  - three renames cannot promise "nothing moved" when the second one fails, and
 *    a half-moved store is worse than a boot that stopped;
 *  - an empty leaf beside a populated old layout is not an empty runtime. Reading
 *    it would restart receipt de-duplication and read `lease.json` as epoch 0 /
 *    seq 0, which re-admits requests that were already spent and accepts leases
 *    that were already superseded;
 *  - nothing here chowns or rewrites existing state. The bytes are left exactly
 *    where they are, for a deliberate migration to deal with.
 *
 * Both layouts present is its own refusal rather than a preference: whichever
 * store were chosen, the other's receipts and lease would be invisible.
 */
import { lstatSync } from 'node:fs';
import { join } from 'node:path';

/** The daemon's own leaf inside the runtime state directory. */
export const MANAGED_DAEMON_STATE_LEAF = 'daemon';

/** Paths the old layout used, directly inside the state directory. */
const LEGACY_ENTRIES = ['receipts', 'tmp', 'lease.json'] as const;

export function managedDaemonStateDir(stateDir: string): string {
    return join(stateDir, MANAGED_DAEMON_STATE_LEAF);
}

export type ManagedDaemonStateLayout =
    | { usable: true }
    | {
        usable: false;
        reason:
            /** Receipts or a lease are still in the state root. */
            | 'state-layout-old'
            /** Both layouts exist; choosing one hides the other's records. */
            | 'state-layout-dual'
            /** The layout cannot be read, or the leaf is not a directory. */
            | 'state-layout-unusable';
        /** A fixed classifier: an entry name or a code, never a path. */
        detail: string;
    };

/** `lstat`, so a link is a fact rather than something followed. */
function entryKind(path: string): 'absent' | 'dir' | 'file' | 'symlink' | 'unreadable' {
    try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) return 'symlink';
        if (stat.isDirectory()) return 'dir';
        return 'file';
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unreadable';
    }
}

/**
 * Reads the layout. Creates nothing, moves nothing, changes no owner.
 *
 * Provisioning the leaf belongs to the privileged boot; this runs in the daemon,
 * under the writer lock it already holds, before the store is opened.
 */
export function inspectManagedDaemonStateLayout(stateDir: string): ManagedDaemonStateLayout {
    const root = entryKind(stateDir);
    if (root !== 'dir') {
        // 못 읽는 것은 "깨끗하다" 가 아니다 — 아무도 확인하지 않은 배치다.
        return {
            usable: false,
            reason: 'state-layout-unusable',
            detail: `state dir: ${root === 'absent' ? 'ENOENT' : root}`,
        };
    }

    const leaf = entryKind(managedDaemonStateDir(stateDir));
    if (leaf === 'symlink' || leaf === 'file' || leaf === 'unreadable') {
        return {
            usable: false,
            reason: 'state-layout-unusable',
            detail: `${MANAGED_DAEMON_STATE_LEAF}: ${leaf === 'file' ? 'not a directory' : leaf}`,
        };
    }

    for (const entry of LEGACY_ENTRIES) {
        const kind = entryKind(join(stateDir, entry));
        if (kind === 'absent') continue;
        /*
         * 링크든 파일이든 디렉터리든 같은 사실이다: 옛 배치의 그 자리에 무언가
         * 있다. 따라가서 무엇인지 보는 것은 이 결정에 필요하지 않고, 따라가는
         * 순간 확인되지 않은 곳의 바이트를 읽게 된다.
         */
        return {
            usable: false,
            reason: leaf === 'dir' ? 'state-layout-dual' : 'state-layout-old',
            detail: entry,
        };
    }

    return { usable: true };
}

/** What a `lstat` of the leaf amounts to, as a value this module can judge. */
export type ManagedDaemonLeafStat =
    | { kind: 'absent' }
    | { kind: 'symlink' }
    | { kind: 'file' }
    | { kind: 'unreadable' }
    | { kind: 'dir'; uid: number; gid: number; mode: number };

export type ManagedDaemonLeafDecision =
    | { ok: true; create: boolean }
    | { ok: false; detail: 'owner' | 'mode' | 'not-a-directory' | 'symlink' | 'unreadable' };

/**
 * Create the leaf, or verify the one that is already there. **Never correct it.**
 *
 * A later boot can find a leaf that already holds a live store — and nothing in
 * the boot holds the daemon's writer lock, so the daemon may be writing into it at
 * that moment. `chmod`/`chown` on that directory would mutate state this boot did
 * not write, and there is no way back from it. A real Linux probe showed exactly
 * that: an existing leaf's owner moved `2001 → 2003` and its mode `0750 → 0700`
 * because provisioning "fixed" what it found.
 *
 * So: absent ⇒ create. Present with exactly the expected owner and mode ⇒ accept
 * and touch nothing. Anything else ⇒ refuse, and let a person decide.
 */
export function inspectManagedDaemonStateLeaf(
    stat: ManagedDaemonLeafStat,
    account: { uid: number; gid: number },
    mode = 0o700,
): ManagedDaemonLeafDecision {
    if (stat.kind === 'absent') return { ok: true, create: true };
    if (stat.kind === 'symlink') return { ok: false, detail: 'symlink' };
    if (stat.kind === 'file') return { ok: false, detail: 'not-a-directory' };
    if (stat.kind === 'unreadable') return { ok: false, detail: 'unreadable' };
    // 정확히 기대한 소유자여야 한다 — root 소유도 여기서는 통과가 아니다. 그것이
    // 옛 배치와 같은 권한이기 때문이다.
    if (stat.uid !== account.uid || stat.gid !== account.gid) return { ok: false, detail: 'owner' };
    // 모드는 하위 비트만 비교한다: `lstat` 의 mode 는 파일 형식 비트를 포함한다.
    if ((stat.mode & 0o7777) !== mode) return { ok: false, detail: 'mode' };
    return { ok: true, create: false };
}
