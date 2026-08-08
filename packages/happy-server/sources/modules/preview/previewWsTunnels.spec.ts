import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    addTunnel,
    setTunnelOwner,
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
        addTunnel('t1', socket as any);
        setTunnelOwner('t1', 'daemon-1');
        const broadcast = vi.fn();

        deliverDaemonData('t1', b64('hello'), broadcast);

        expect(socket.written).toEqual(['hello']);
        // No fan-out when the tunnel is right here — every replica would
        // otherwise pay for every HMR frame.
        expect(broadcast).not.toHaveBeenCalled();
    });

    it('shouldEndTheBrowserSocketOnALocalClose', () => {
        const socket = fakeBrowserSocket();
        addTunnel('t1', socket as any);
        const broadcast = vi.fn();

        deliverDaemonClose('t1', broadcast);

        expect(socket.ended).toBe(true);
        expect(hasTunnel('t1')).toBe(false);
        expect(broadcast).not.toHaveBeenCalled();
    });

    it('shouldNotWriteToASocketThatIsNoLongerWritable', () => {
        const socket = fakeBrowserSocket();
        socket.writable = false;
        addTunnel('t1', socket as any);

        deliverDaemonData('t1', b64('x'), vi.fn());

        expect(socket.written).toEqual([]);
    });
});

describe('preview WS tunnels — cross-replica delivery', () => {
    beforeEach(() => _resetPreviewTunnelsForTest());

    it('shouldBroadcastWhenTheTunnelBelongsToAnotherReplica', () => {
        // The daemon frame lands on the daemon's replica, which owns no browser
        // socket for this tunnel. The browser's TCP socket is pinned to the
        // replica that accepted the upgrade, so bytes have to be handed over.
        const broadcast = vi.fn();

        deliverDaemonData('elsewhere', b64('hello'), broadcast);

        expect(broadcast).toHaveBeenCalledWith('preview-ws-data', {
            tunnelId: 'elsewhere',
            dataB64: b64('hello'),
        });
    });

    it('shouldBroadcastACloseForATunnelOwnedElsewhere', () => {
        const broadcast = vi.fn();
        deliverDaemonClose('elsewhere', broadcast);
        expect(broadcast).toHaveBeenCalledWith('preview-ws-close', { tunnelId: 'elsewhere' });
    });

    it('shouldWriteBytesArrivingFromAnotherReplica', () => {
        const socket = fakeBrowserSocket();
        addTunnel('t1', socket as any);

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
        addTunnel('t1', socket as any);

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
        addTunnel('t1', mine as any);
        setTunnelOwner('t1', 'daemon-1');
        addTunnel('t2', other as any);
        setTunnelOwner('t2', 'daemon-2');

        const dropped = dropTunnelsOwnedBy('daemon-1');

        expect(dropped).toEqual(['t1']);
        expect(mine.destroyed).toBe(true);
        expect(other.destroyed).toBe(false);
        expect(hasTunnel('t1')).toBe(false);
        expect(hasTunnel('t2')).toBe(true);
    });

    it('shouldLeaveUnownedTunnelsAloneWhileTheyAreStillOpening', () => {
        // owner is only set once proxy-ws-open acks; a null owner must not be
        // swept by an unrelated daemon's disconnect.
        const opening = fakeBrowserSocket();
        addTunnel('t1', opening as any);

        expect(dropTunnelsOwnedBy('daemon-1')).toEqual([]);
        expect(opening.destroyed).toBe(false);
    });

    it('shouldReportDeleteResultSoTeardownOnlyNotifiesTheDaemonOnce', () => {
        addTunnel('t1', fakeBrowserSocket() as any);
        expect(deleteTunnel('t1')).toBe(true);
        expect(deleteTunnel('t1')).toBe(false);
    });
});
