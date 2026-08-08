import { describe, expect, it, vi } from 'vitest';
import { createLogThrottle, instrumentStreamWrites, readClusterPeerCount, redisErrorCode } from './redisHealth';

describe('redisErrorCode', () => {
    it('shouldLabelReadonlyReplyAsReadonly', () => {
        // The failure mode that silently killed the cluster bus: after a
        // Sentinel failover the client stays pinned to the demoted replica and
        // every XADD comes back -READONLY.
        expect(redisErrorCode(new Error("READONLY You can't write against a read only replica."))).toBe('READONLY');
    });

    it('shouldUseIoredisErrorCodeWhenPresent', () => {
        const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        expect(redisErrorCode(err)).toBe('ECONNREFUSED');
    });

    it('shouldLabelLoadingReplyAsLoading', () => {
        expect(redisErrorCode(new Error('LOADING Redis is loading the dataset in memory'))).toBe('LOADING');
    });

    it('shouldFallBackToUnknownForUnrecognizedErrors', () => {
        expect(redisErrorCode(new Error('something else entirely'))).toBe('UNKNOWN');
        expect(redisErrorCode('not an error')).toBe('UNKNOWN');
    });
});

describe('createLogThrottle', () => {
    it('shouldAllowFirstOccurrenceOfEachKey', () => {
        const throttle = createLogThrottle(60_000, () => 0);
        expect(throttle('READONLY')).toBe(true);
        expect(throttle('ECONNREFUSED')).toBe(true);
    });

    it('shouldSuppressRepeatsOfTheSameKeyWithinTheInterval', () => {
        // 875k READONLY replies in 4h is ~65/s — logging each would drown the
        // log. One line per key per interval is enough to see it.
        let now = 0;
        const throttle = createLogThrottle(60_000, () => now);
        expect(throttle('READONLY')).toBe(true);
        now = 59_999;
        expect(throttle('READONLY')).toBe(false);
    });

    it('shouldAllowAgainOnceTheIntervalElapsed', () => {
        let now = 0;
        const throttle = createLogThrottle(60_000, () => now);
        throttle('READONLY');
        now = 60_000;
        expect(throttle('READONLY')).toBe(true);
    });
});

describe('readClusterPeerCount', () => {
    it('shouldReportPeersAsServerCountMinusSelf', async () => {
        // replicas=2 with a healthy bus → 1 peer.
        await expect(readClusterPeerCount({ serverCount: async () => 2 })).resolves.toBe(1);
    });

    it('shouldReportZeroPeersWhenTheBusIsDead', async () => {
        // The decisive signal: serverCount collapses to 1 (self only) because
        // no heartbeats arrive, so fetchSockets silently returns local-only
        // results instead of erroring.
        await expect(readClusterPeerCount({ serverCount: async () => 1 })).resolves.toBe(0);
    });

    it('shouldReportMinusOneWhenServerCountIsUnavailable', async () => {
        await expect(readClusterPeerCount({})).resolves.toBe(-1);
        await expect(readClusterPeerCount({ serverCount: async () => { throw new Error('boom'); } })).resolves.toBe(-1);
    });
});

describe('instrumentStreamWrites', () => {
    it('shouldPassThroughSuccessfulWrites', async () => {
        const onFailure = vi.fn();
        const client = { xadd: vi.fn(async (..._args: any[]) => '1-0') };
        instrumentStreamWrites(client, onFailure);
        await expect(client.xadd('socket.io')).resolves.toBe('1-0');
        expect(onFailure).not.toHaveBeenCalled();
    });

    it('shouldReportFailureCodeAndStillRejectSoCallerBehaviourIsUnchanged', async () => {
        // socket.io-adapter swallows publish rejections into debug() logs
        // (cluster-adapter.js publish()), so wrapping the command is the only
        // place a failed XADD becomes observable. It must still reject.
        const onFailure = vi.fn();
        const err = new Error("READONLY You can't write against a read only replica.");
        const client = { xadd: vi.fn(async (..._args: any[]) => { throw err; }) };
        instrumentStreamWrites(client, onFailure);
        await expect(client.xadd('socket.io')).rejects.toThrow(err);
        expect(onFailure).toHaveBeenCalledWith('READONLY', err);
    });
});
