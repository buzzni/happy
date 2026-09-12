/**
 * Which account the managed daemon runs as, read from the image.
 *
 * The account is a property of the image the runtime boots — the user and group
 * are created when the image is built — so it is resolved by **name** from the
 * passwd and group databases, as root, before any agent uid exists. It is trusted
 * for the same reason the helper paths are: root built the image and root is
 * reading it.
 *
 * Deliberately **not** a marker field. A required marker axis is not one change:
 * the parent's composer and producer have to emit it, every marker fixture on both
 * sides changes, and machines already provisioned carry markers without it — which
 * is a migration, not a field. The image keeps the slice inside one repository.
 *
 * Deliberately **not** defaulted. A numeric fallback here would be a uid nobody
 * chose owning the only directory the daemon may write, so an account that is
 * missing or ambiguous is a refusal.
 */

/** The name the image creates. Fixed, because the image and this agree on it. */
export const MANAGED_DAEMON_ACCOUNT_NAME = 'saycode-daemon';

export type ManagedDaemonAccount = { uid: number; gid: number };

export type ManagedDaemonAccountDeps = {
    /** `/etc/passwd` as text, or `null` when it cannot be read. */
    readPasswd: () => string | null;
    /** `/etc/group` as text, or `null` when it cannot be read. */
    readGroup: () => string | null;
};

export type ManagedDaemonAccountOutcome =
    | { ok: true; account: ManagedDaemonAccount }
    | { ok: false; detail: 'passwd-unreadable' | 'group-unreadable' | 'user-absent' | 'group-absent' | 'ambiguous' };

/** One `name:…:id:…` line per record; the first field is the name. */
function idsForName(text: string, name: string, field: number): number[] {
    const found: number[] = [];
    for (const line of text.split('\n')) {
        const columns = line.split(':');
        if (columns[0] !== name) continue;
        const raw = columns[field];
        if (raw === undefined) continue;
        const id = Number(raw);
        // A non-numeric or negative id is not an id. Refused rather than coerced.
        if (!Number.isSafeInteger(id) || id < 0) continue;
        found.push(id);
    }
    return found;
}

export function resolveManagedDaemonAccount(
    deps: ManagedDaemonAccountDeps,
    name: string = MANAGED_DAEMON_ACCOUNT_NAME,
): ManagedDaemonAccountOutcome {
    const passwd = deps.readPasswd();
    if (passwd === null) return { ok: false, detail: 'passwd-unreadable' };
    const group = deps.readGroup();
    if (group === null) return { ok: false, detail: 'group-unreadable' };

    // passwd: name:x:uid:gid:… — the uid is field 2.
    const uids = idsForName(passwd, name, 2);
    if (uids.length === 0) return { ok: false, detail: 'user-absent' };
    // group: name:x:gid:members — the gid is field 2.
    const gids = idsForName(group, name, 2);
    if (gids.length === 0) return { ok: false, detail: 'group-absent' };
    /*
     * 같은 이름에 여러 id 가 있으면 어느 것이 그 계정인지 이 코드가 고를 문제가
     * 아니다. 하나를 고르는 순간, 아무도 의도하지 않은 uid 가 daemon 이 쓸 수 있는
     * 유일한 디렉터리를 소유하게 된다.
     */
    if (uids.length > 1 || gids.length > 1) return { ok: false, detail: 'ambiguous' };
    // 0 은 그 계정이 아니다 — root 가 이미 소유자인 자리를 위한 경로가 아니다.
    if (uids[0] === 0 || gids[0] === 0) return { ok: false, detail: 'ambiguous' };

    return { ok: true, account: { uid: uids[0]!, gid: gids[0]! } };
}

/**
 * Whether the configured daemon account collides with the agent accounts.
 *
 * The shared resolver separates the **running** uid from the provider and
 * executor uids (`checkIsolationStaticPreconditions`); it says nothing about the
 * *configured* daemon account. So a marker whose `provider.uid` equals the daemon
 * account's uid passes every existing check, and then the leaf this slice creates
 * hands that uid the receipt store and `lease.json` — the provider would be able
 * to rewrite the record that decides whether its own generation may still run.
 *
 * The gid is checked for the same reason one step ahead: the `0640`
 * group-readable records a later phase introduces would be readable by whoever
 * holds that group. Refused now, before any such file exists.
 *
 * `null` when there is no collision; otherwise which one, as a fixed classifier.
 */
export function managedDaemonAccountCollision(
    account: ManagedDaemonAccount,
    isolation: {
        provider: { uid: number; gid: number };
        executor: { uid: number; gid: number };
    },
): 'provider-uid' | 'executor-uid' | 'provider-gid' | 'executor-gid' | null {
    if (account.uid === isolation.provider.uid) return 'provider-uid';
    if (account.uid === isolation.executor.uid) return 'executor-uid';
    if (account.gid === isolation.provider.gid) return 'provider-gid';
    if (account.gid === isolation.executor.gid) return 'executor-gid';
    return null;
}
