/**
 * The daemon account, as the image states it.
 *
 * Every refusal here exists because the alternative is a uid nobody chose owning
 * the one directory the daemon may write.
 */
import { describe, expect, it } from 'vitest';

import {
    managedDaemonAccountCollision,
    resolveManagedDaemonAccount,
} from './managedDaemonAccount';

const PASSWD = [
    'root:x:0:0:root:/root:/bin/sh',
    'saycode-provider:x:10601:10601::/nonexistent:/sbin/nologin',
    'saycode-daemon:x:999:999::/var/lib/saycode-daemon:/sbin/nologin',
].join('\n');
const GROUP = ['root:x:0:', 'saycode-provider:x:10601:', 'saycode-daemon:x:999:'].join('\n');

function deps(over: Partial<{ passwd: string | null; group: string | null }> = {}) {
    return {
        readPasswd: () => (over.passwd === undefined ? PASSWD : over.passwd),
        readGroup: () => (over.group === undefined ? GROUP : over.group),
    };
}

describe('resolving the account the image created', () => {
    it('shouldReadTheUidAndGidByName', () => {
        expect(resolveManagedDaemonAccount(deps()))
            .toEqual({ ok: true, account: { uid: 999, gid: 999 } });
    });

    it('shouldRefuseWhenTheImageHasNoSuchUser', () => {
        // 없는 계정에 기본값을 주면, 그 uid 를 고른 것은 아무도 아니다.
        expect(resolveManagedDaemonAccount(deps({ passwd: 'root:x:0:0::/root:/bin/sh' })))
            .toEqual({ ok: false, detail: 'user-absent' });
    });

    it('shouldRefuseWhenTheGroupIsMissingEvenThoughTheUserExists', () => {
        expect(resolveManagedDaemonAccount(deps({ group: 'root:x:0:' })))
            .toEqual({ ok: false, detail: 'group-absent' });
    });

    it('shouldRefuseADatabaseItCannotRead', () => {
        // 읽지 못한 것은 "없다" 가 아니다.
        expect(resolveManagedDaemonAccount(deps({ passwd: null })))
            .toEqual({ ok: false, detail: 'passwd-unreadable' });
        expect(resolveManagedDaemonAccount(deps({ group: null })))
            .toEqual({ ok: false, detail: 'group-unreadable' });
    });

    it('shouldRefuseTwoRecordsForOneName', () => {
        expect(resolveManagedDaemonAccount(deps({
            passwd: `${PASSWD}\nsaycode-daemon:x:1000:1000::/x:/sbin/nologin`,
        }))).toEqual({ ok: false, detail: 'ambiguous' });
    });

    it('shouldRefuseAnAccountThatIsRoot', () => {
        /*
         * uid 0 을 "daemon 계정" 으로 받아들이면 이 슬라이스가 만드는 leaf 는 root
         * 소유가 되고, 그것은 옛 배치와 같은 상태다 — 이름만 다른 같은 권한.
         */
        expect(resolveManagedDaemonAccount(deps({
            passwd: 'saycode-daemon:x:0:0::/x:/sbin/nologin',
            group: 'saycode-daemon:x:0:',
        }))).toEqual({ ok: false, detail: 'ambiguous' });
    });
});

describe('the daemon account may not be the provider or the executor', () => {
    /*
     * The shared resolver separates the **running** uid from the provider and
     * executor uids; it says nothing about the *configured* daemon account. So a
     * marker whose `provider.uid` equals `saycode-daemon`'s uid passes every
     * existing check and then this slice hands that uid a directory holding the
     * receipt store and the lease — i.e. the provider could rewrite the record
     * that decides whether its own generation may still run.
     *
     * Checked before the leaf is provisioned, with the **configured** account as
     * the subject.
     */
    const isolation = { provider: { uid: 10601, gid: 10601 }, executor: { uid: 10602, gid: 10600 } };

    it('shouldAcceptAnAccountThatCollidesWithNeither', () => {
        expect(managedDaemonAccountCollision({ uid: 999, gid: 999 }, isolation)).toBeNull();
    });

    it('shouldRefuseAnAccountWhoseUidIsTheProviderUid', () => {
        expect(managedDaemonAccountCollision({ uid: 10601, gid: 999 }, isolation)).toBe('provider-uid');
    });

    it('shouldRefuseAnAccountWhoseUidIsTheExecutorUid', () => {
        expect(managedDaemonAccountCollision({ uid: 10602, gid: 999 }, isolation)).toBe('executor-uid');
    });

    it('shouldRefuseAnAccountWhoseGidIsAProviderOrExecutorGid', () => {
        /*
         * The gid matters for the same reason: the `0640` group-readable records a
         * later phase introduces would be readable by whoever holds that group.
         * Refused now, before any such file exists.
         */
        expect(managedDaemonAccountCollision({ uid: 999, gid: 10601 }, isolation)).toBe('provider-gid');
        expect(managedDaemonAccountCollision({ uid: 999, gid: 10600 }, isolation)).toBe('executor-gid');
    });
});
