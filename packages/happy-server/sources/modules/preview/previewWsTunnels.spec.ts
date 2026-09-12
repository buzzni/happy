import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    addTunnel,
    approveTunnel,
    deleteTunnel,
    hasTunnel,
    deliverDaemonData,
    deliverDaemonClose,
    dropTunnelsOwnedBy,
    applyRemoteData,
    applyRemoteClose,
    _resetPreviewTunnelsForTest,
} from './previewWsTunnels';

function fakeBrowserSocket() {
    return {
        writable: true,
        written: [] as string[],
        ended: false,
        destroyed: false,
        write(buf: Buffer) { this.written.push(buf.toString()); return true; },
        end() { this.ended = true; },
        destroy() { this.destroyed = true; },
    };
}

const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('preview WS tunnels — local delivery', () => {
    beforeEach(() => _resetPreviewTunnelsForTest());

    it('shouldWriteDaemonBytesStraightToABrowserSocketOnThisReplica', () => {
        const socket = fakeBrowserSocket();
        addTunnel('t1', socket as any, 'daemon-1');
        approveTunnel('t1', 'daemon-1');
        const broadcast = vi.fn();

        deliverDaemonData('t1', b64('hello'), broadcast, 'daemon-1');

        expect(socket.written).toEqual(['hello']);
        // No fan-out when the tunnel is right here — every replica would
        // otherwise pay for every HMR frame.
        expect(broadcast).not.toHaveBeenCalled();
    });

    it('shouldEndTheBrowserSocketOnALocalClose', () => {
        const socket = fakeBrowserSocket();
        addTunnel('t1', socket as any, 'daemon-1');
        approveTunnel('t1', 'daemon-1');
        const broadcast = vi.fn();

        deliverDaemonClose('t1', broadcast);

        expect(socket.ended).toBe(true);
        expect(hasTunnel('t1')).toBe(false);
        expect(broadcast).not.toHaveBeenCalled();
    });

    it('shouldNotWriteToASocketThatIsNoLongerWritable', () => {
        const socket = fakeBrowserSocket();
        socket.writable = false;
        addTunnel('t1', socket as any, 'daemon-1');
        approveTunnel('t1', 'daemon-1');

        deliverDaemonData('t1', b64('x'), vi.fn(), 'daemon-1');

        expect(socket.written).toEqual([]);
    });
});

describe('preview WS tunnels — approval gate', () => {
    beforeEach(() => _resetPreviewTunnelsForTest());

    it('holds daemon bytes back until the binding is approved', () => {
        // The daemon can start streaming the upstream's 101 and its first
        // frames before its ack reaches us. Writing those through would mean
        // a tunnel we are about to refuse has already delivered content.
        const socket = fakeBrowserSocket();
        addTunnel('t1', socket as any, 'daemon-1');

        deliverDaemonData('t1', b64('early'), vi.fn(), 'daemon-1');
        expect(socket.written).toEqual([]);

        expect(approveTunnel('t1', 'daemon-1')).toBe(true);
        expect(socket.written).toEqual(['early']);

        deliverDaemonData('t1', b64('later'), vi.fn(), 'daemon-1');
        expect(socket.written).toEqual(['early', 'later']);
    });

    it('drops the buffer instead of delivering it when the tunnel is refused', () => {
        const socket = fakeBrowserSocket();
        addTunnel('t1', socket as any, 'daemon-1');
        deliverDaemonData('t1', b64('early'), vi.fn(), 'daemon-1');

        deleteTunnel('t1');
        approveTunnel('t1', 'daemon-1');

        expect(socket.written).toEqual([]);
    });

    it('ignores bytes from any daemon other than the one this tunnel is for', () => {
        // Tunnel ids are per candidate, so a second daemon writing here is
        // either confused or hostile; either way its bytes are not this
        // tunnel's content.
        const socket = fakeBrowserSocket();
        addTunnel('t1', socket as any, 'daemon-1');
        approveTunnel('t1', 'daemon-1');

        deliverDaemonData('t1', b64('from-someone-else'), vi.fn(), 'daemon-2');

        expect(socket.written).toEqual([]);
    });

    it('refuses an approval from a daemon the tunnel was not opened with', () => {
        const socket = fakeBrowserSocket();
        addTunnel('t1', socket as any, 'daemon-1');

        expect(approveTunnel('t1', 'daemon-2')).toBe(false);
        deliverDaemonData('t1', b64('x'), vi.fn(), 'daemon-2');
        expect(socket.written).toEqual([]);
    });

    it('fails the tunnel closed when a daemon floods the pre-approval buffer', () => {
        // Unbounded buffering would let an unapproved daemon spend the
        // server's memory; dropping the tunnel is the safe direction.
        const socket = fakeBrowserSocket();
        addTunnel('t1', socket as any, 'daemon-1');
        const big = b64('x'.repeat(64 * 1024));

        for (let i = 0; i < 16; i += 1) deliverDaemonData('t1', big, vi.fn(), 'daemon-1');

        expect(hasTunnel('t1')).toBe(false);
        expect(socket.written).toEqual([]);
        expect(socket.destroyed).toBe(true);
    });

    it('refuses a bound tunnel\'s frame that arrives without a sender', () => {
        // A peer replica running an older build relays the frame without the
        // sender field. For a bound tunnel that is not a compatibility case
        // to wave through — it is the same-daemon pin being bypassed by
        // whichever replica is oldest.
        const socket = fakeBrowserSocket();
        addTunnel('t1', socket as any, 'daemon-1', true);
        approveTunnel('t1', 'daemon-1');

        applyRemoteData({ tunnelId: 't1', dataB64: b64('no-sender') } as any);

        expect(socket.written).toEqual([]);
    });

    it('still delivers an unbound tunnel\'s frame from a replica that sends no sender', () => {
        // Legacy tunnels have no same-daemon claim to protect, and a mixed
        // -version cluster must keep working for them.
        const socket = fakeBrowserSocket();
        addTunnel('t1', socket as any, 'daemon-1', false);
        approveTunnel('t1', 'daemon-1');

        applyRemoteData({ tunnelId: 't1', dataB64: b64('legacy') } as any);

        expect(socket.written).toEqual(['legacy']);
    });

    it('refuses a mismatched sender on an unbound tunnel too, when one is given', () => {
        const socket = fakeBrowserSocket();
        addTunnel('t1', socket as any, 'daemon-1', false);
        approveTunnel('t1', 'daemon-1');

        applyRemoteData({ tunnelId: 't1', dataB64: b64('x'), fromDaemonSocketId: 'daemon-2' });

        expect(socket.written).toEqual([]);
    });

    it('does not hand a pending tunnel to a peer replica', () => {
        // A pending tunnel's browser socket is right here; broadcasting the
        // frame would ask every other replica to write bytes we are holding
        // back on purpose.
        const socket = fakeBrowserSocket();
        addTunnel('t1', socket as any, 'daemon-1');
        const broadcast = vi.fn();

        deliverDaemonData('t1', b64('early'), broadcast, 'daemon-1');

        expect(broadcast).not.toHaveBeenCalled();
    });
});

describe('preview WS tunnels — cross-replica delivery', () => {
    beforeEach(() => _resetPreviewTunnelsForTest());

    it('shouldBroadcastWhenTheTunnelBelongsToAnotherReplica', () => {
        // The daemon frame lands on the daemon's replica, which owns no browser
        // socket for this tunnel. The browser's TCP socket is pinned to the
        // replica that accepted the upgrade, so bytes have to be handed over.
        const broadcast = vi.fn();

        deliverDaemonData('elsewhere', b64('hello'), broadcast, 'daemon-1');

        expect(broadcast).toHaveBeenCalledWith('preview-ws-data', {
            tunnelId: 'elsewhere',
            dataB64: b64('hello'),
            // The owning replica needs the sender to apply the same pin.
            fromDaemonSocketId: 'daemon-1',
        });
    });

    it('shouldBroadcastACloseForATunnelOwnedElsewhere', () => {
        const broadcast = vi.fn();
        deliverDaemonClose('elsewhere', broadcast);
        expect(broadcast).toHaveBeenCalledWith('preview-ws-close', { tunnelId: 'elsewhere' });
    });

    it('shouldWriteBytesArrivingFromAnotherReplica', () => {
        const socket = fakeBrowserSocket();
        addTunnel('t1', socket as any, 'daemon-1');
        approveTunnel('t1', 'daemon-1');

        applyRemoteData({ tunnelId: 't1', dataB64: b64('remote') });

        expect(socket.written).toEqual(['remote']);
    });

    it('shouldIgnoreRemoteFramesForTunnelsThisReplicaDoesNotOwn', () => {
        // Every replica receives the broadcast; only the owner acts.
        expect(() => applyRemoteData({ tunnelId: 'nope', dataB64: b64('x') })).not.toThrow();
        expect(() => applyRemoteClose({ tunnelId: 'nope' })).not.toThrow();
    });

    it('shouldCloseALocalTunnelOnARemoteClose', () => {
        const socket = fakeBrowserSocket();
        addTunnel('t1', socket as any, 'daemon-1');
        approveTunnel('t1', 'daemon-1');

        applyRemoteClose({ tunnelId: 't1' });

        expect(socket.ended).toBe(true);
        expect(hasTunnel('t1')).toBe(false);
    });
});

describe('preview WS tunnels — daemon disconnect', () => {
    beforeEach(() => _resetPreviewTunnelsForTest());

    it('shouldDestroyOnlyTheTunnelsOwnedByThatDaemonSocket', () => {
        // When a daemon drops, its live tunnels are dead: closeAll() emits land
        // on a disconnected socket, so without this the browser sockets leak.
        const mine = fakeBrowserSocket();
        const other = fakeBrowserSocket();
        addTunnel('t1', mine as any, 'daemon-1');
        approveTunnel('t1', 'daemon-1');
        addTunnel('t2', other as any, 'daemon-2');
        approveTunnel('t2', 'daemon-2');

        const dropped = dropTunnelsOwnedBy('daemon-1');

        expect(dropped).toEqual(['t1']);
        expect(mine.destroyed).toBe(true);
        expect(other.destroyed).toBe(false);
        expect(hasTunnel('t1')).toBe(false);
        expect(hasTunnel('t2')).toBe(true);
    });

    it('shouldLeaveUnownedTunnelsAloneWhileTheyAreStillOpening', () => {
        // A pending tunnel belongs to the candidate it was opened for, so an
        // *unrelated* daemon's disconnect must not sweep it.
        const opening = fakeBrowserSocket();
        addTunnel('t1', opening as any, 'daemon-2');

        expect(dropTunnelsOwnedBy('daemon-1')).toEqual([]);
        expect(opening.destroyed).toBe(false);
    });

    it('sweeps a pending tunnel when the daemon it was opened for disconnects', () => {
        // The candidate is known at registration now, so a tunnel still
        // waiting on that daemon's ack is just as dead as an approved one —
        // and it holds a browser socket.
        const opening = fakeBrowserSocket();
        addTunnel('t1', opening as any, 'daemon-1');

        expect(dropTunnelsOwnedBy('daemon-1')).toEqual(['t1']);
        expect(opening.destroyed).toBe(true);
    });

    it('shouldReportDeleteResultSoTeardownOnlyNotifiesTheDaemonOnce', () => {
        addTunnel('t1', fakeBrowserSocket() as any, 'daemon-1');
        expect(deleteTunnel('t1')).toBe(true);
        expect(deleteTunnel('t1')).toBe(false);
    });
});
