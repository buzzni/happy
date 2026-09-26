import { describe, expect, it } from 'vitest';
import { createRpcLatency, parseRpcLatencyRequest, parseRpcLatencySnapshot } from './rpcLatency';

const id = '11111111-1111-4111-8111-111111111111';
describe('bounded RPC diagnostic durations', () => {
    it('accepts only the versioned random ID shape', () => {
        expect(parseRpcLatencyRequest({ version: 1, id, params: 'secret' })).toEqual({ version: 1, id });
        for (const input of [null, {}, { version: 2, id }, { version: 1, id: 'session-id' }]) {
            expect(parseRpcLatencyRequest(input)).toBeUndefined();
        }
    });
    it('bounds memory and isolates clock failures from results and original exceptions', async () => {
        let now = 0;
        const trace = createRpcLatency({ version: 1, id }, () => now);
        const end = trace.begin('server-lookup');
        now = 23;
        end('resolved');
        expect(trace.snapshot().spans[0]).toEqual({ stage: 'server-lookup', durationMs: 23, outcome: 'resolved' });
        for (let i = 0; i < 40; i++) trace.begin('server-lookup')('rejected');
        expect(trace.snapshot().spans).toHaveLength(32);
        expect(trace.snapshot().droppedSpans).toBe(9);
        const broken = createRpcLatency({ version: 1, id }, () => { throw new Error('clock'); });
        const value = {};
        expect(await broken.measure('daemon-handler', () => Promise.resolve(value))).toBe(value);
        const error = new Error('original');
        await expect(broken.measure('daemon-handler', () => Promise.reject(error))).rejects.toBe(error);
        expect(broken.snapshot().spans).toEqual([
            { stage: 'daemon-handler', durationMs: null, outcome: 'resolved' },
            { stage: 'daemon-handler', durationMs: null, outcome: 'rejected' },
        ]);
        expect(broken.snapshot().clockFailures).toBe(4);
    });
});

it('sanitizes daemon timing without forwarding arbitrary daemon fields', () => {
    const payload = { version: 1, id, spans: [{ stage: 'daemon-handler', durationMs: 12, outcome: 'resolved', secret: 'hidden' }], droppedSpans: 0, clockFailures: 0, secret: 'hidden' };
    expect(parseRpcLatencySnapshot(payload, id)).toEqual({ version: 1, id, spans: [{ stage: 'daemon-handler', durationMs: 12, outcome: 'resolved' }], droppedSpans: 0, clockFailures: 0 });
    expect(parseRpcLatencySnapshot({ ...payload, id: 'wrong' }, id)).toBeUndefined();
    expect(parseRpcLatencySnapshot({ ...payload, spans: [{ stage: 'private-path', durationMs: 3, outcome: 'resolved' }] }, id)).toBeUndefined();
});
