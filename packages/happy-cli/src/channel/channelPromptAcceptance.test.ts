import { describe, expect, it, vi } from 'vitest';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import {
    ChannelPromptAcceptance,
    parseChannelPromptRequest,
    type ChannelAcceptanceDeps,
} from './channelPromptAcceptance';

function build(overrides: Partial<ChannelAcceptanceDeps> = {}) {
    const enqueued: { text: string; requestId: string }[] = [];
    const recorded: { text: string; localId: string }[] = [];
    const deps: ChannelAcceptanceDeps = {
        runtimeId: 'runtime-1',
        recordDurably: async (input) => { recorded.push(input); return { ok: true as const }; },
        enqueue: (input) => { enqueued.push(input); },
        requestApproval: ({ requestId, runtimeId, nonce }) => queueMicrotask(() => acceptance.authorize({
            requestId, expectedRuntimeId: runtimeId, nonce, decision: 'allow',
        })),
        now: () => 1_700_000_000_000,
        ...overrides,
    };
    const acceptance = new ChannelPromptAcceptance(deps);
    return { acceptance, enqueued, recorded };
}

describe('parseChannelPromptRequest', () => {
    it('accepts the documented shape', () => {
        expect(parseChannelPromptRequest({ text: 'hi', requestId: 'r1', expectedRuntimeId: 'rt' }))
            .toEqual({ text: 'hi', requestId: 'r1', expectedRuntimeId: 'rt' });
    });

    it('refuses unknown fields rather than ignoring them', () => {
        expect(parseChannelPromptRequest({
            text: 'hi', requestId: 'r1', expectedRuntimeId: 'rt', permissionMode: 'yolo',
        })).toBeNull();
    });

    it('bounds the request id and the text', () => {
        expect(parseChannelPromptRequest({ text: 'hi', requestId: 'x'.repeat(200), expectedRuntimeId: 'rt' })).toBeNull();
        expect(parseChannelPromptRequest({ text: 'x'.repeat(70_000), requestId: 'r1', expectedRuntimeId: 'rt' })).toBeNull();
        expect(parseChannelPromptRequest({ text: '   ', requestId: 'r1', expectedRuntimeId: 'rt' })).toBeNull();
    });

    it('requires the runtime the caller proved', () => {
        // Without it a delivery cannot be checked against a process that replaced the one whose
        // capability was probed — the only reason this protocol exists.
        expect(parseChannelPromptRequest({ text: 'hi', requestId: 'r1' })).toBeNull();
        expect(parseChannelPromptRequest({ text: 'hi', requestId: 'r1', expectedRuntimeId: '' })).toBeNull();
    });
});

describe('ChannelPromptAcceptance managed runs', () => {
    // A managed run answers exactly the prompt its envelope was admitted for. `onUserMessage` and
    // the follow-up handler both refuse free text for that reason; this path must not become the
    // one exception, or a channel message is a way to add unpriced work to an admitted run.
    it('records nothing and queues nothing for a managed run', async () => {
        const { acceptance, enqueued, recorded } = build({ isManagedRun: () => true });
        const result = await acceptance.accept({
            text: 'do something else', requestId: 'r1', expectedRuntimeId: 'runtime-1',
        });

        expect(result).toMatchObject({ ok: false });
        expect(recorded).toHaveLength(0);
        expect(enqueued).toHaveLength(0);
    });

    it('refuses before the runtime check, so a managed run leaks nothing about its identity', async () => {
        const { acceptance } = build({ isManagedRun: () => true });
        expect(await acceptance.accept({
            text: 'hi', requestId: 'r1', expectedRuntimeId: 'some-other-runtime',
        })).toMatchObject({ ok: false });
    });

    it('does not remember a refused managed request, so an unmanaged retry is still admitted', async () => {
        let managed = true;
        const { acceptance, enqueued } = build({ isManagedRun: () => managed });
        await acceptance.accept({ text: 'hi', requestId: 'r1', expectedRuntimeId: 'runtime-1' });
        managed = false;
        expect(await acceptance.accept({ text: 'hi', requestId: 'r1', expectedRuntimeId: 'runtime-1' }))
            .toMatchObject({ ok: true, accepted: true });
        expect(enqueued).toHaveLength(1);
    });
});

describe('ChannelPromptAcceptance', () => {
    it('records durably before it queues, and only then reports acceptance', async () => {
        const order: string[] = [];
        const { acceptance } = build({
            recordDurably: async () => { order.push('durable'); return { ok: true as const }; },
            enqueue: () => { order.push('queued'); },
        });
        const result = await acceptance.accept({ text: 'hi', requestId: 'r1', expectedRuntimeId: 'runtime-1' });

        expect(result).toMatchObject({ ok: true, accepted: true, duplicate: false });
        expect(order).toEqual(['durable', 'queued']);
    });

    it('answers a redelivery as a duplicate without queuing twice', async () => {
        const { acceptance, enqueued } = build();
        await acceptance.accept({ text: 'hi', requestId: 'r1', expectedRuntimeId: 'runtime-1' });
        const second = await acceptance.accept({ text: 'hi', requestId: 'r1', expectedRuntimeId: 'runtime-1' });

        expect(second).toMatchObject({ ok: true, accepted: false, duplicate: true });
        expect(enqueued).toHaveLength(1);
    });

    it('refuses a reused id carrying different text', async () => {
        const { acceptance, enqueued } = build();
        await acceptance.accept({ text: 'hi', requestId: 'r1', expectedRuntimeId: 'runtime-1' });
        const conflicting = await acceptance.accept({ text: 'something else', requestId: 'r1', expectedRuntimeId: 'runtime-1' });

        expect(conflicting).toMatchObject({ ok: false });
        expect(enqueued).toHaveLength(1);
    });

    it('admits only once when two redeliveries race', async () => {
        let release = () => {};
        const blocked = new Promise<void>((resolve) => { release = resolve; });
        const { acceptance, enqueued } = build({
            recordDurably: async () => { await blocked; return { ok: true as const }; },
        });

        const first = acceptance.accept({ text: 'hi', requestId: 'r1', expectedRuntimeId: 'runtime-1' });
        const second = acceptance.accept({ text: 'hi', requestId: 'r1', expectedRuntimeId: 'runtime-1' });
        release();
        await Promise.all([first, second]);

        expect(enqueued).toHaveLength(1);
    });

    it('lets a retry through when the durable write failed', async () => {
        // Remembering a failed attempt would answer the retry "already have it" for work that
        // never ran.
        let attempt = 0;
        const { acceptance, enqueued } = build({
            recordDurably: async () => {
                attempt += 1;
                return attempt === 1
                    ? { ok: false as const, provenNotWritten: true }
                    : { ok: true as const };
            },
        });

        expect(await acceptance.accept({ text: 'hi', requestId: 'r1', expectedRuntimeId: 'runtime-1' })).toMatchObject({ ok: false });
        expect(enqueued).toHaveLength(0);
        expect(await acceptance.accept({ text: 'hi', requestId: 'r1', expectedRuntimeId: 'runtime-1' }))
            .toMatchObject({ ok: true, accepted: true });
        expect(enqueued).toHaveLength(1);
    });

    it('keeps a retry of an unknown attempt unknown, never a clean duplicate', async () => {
        // The first attempt's fate is uncertain. Answering "already have it" would claim work
        // that may never have been admitted; re-admitting could run it twice.
        const { acceptance, enqueued } = build({
            recordDurably: async () => ({ ok: false as const, provenNotWritten: false }),
        });
        await acceptance.accept({ text: 'hi', requestId: 'r1', expectedRuntimeId: 'runtime-1' });
        expect(await acceptance.accept({ text: 'hi', requestId: 'r1', expectedRuntimeId: 'runtime-1' }))
            .toMatchObject({ ok: false, unknown: true });
        expect(enqueued).toHaveLength(0);
    });

    it('does not re-queue when the enqueue threw after inserting', async () => {
        // MessageQueue2 inserts and *then* runs its notification callbacks, so a throw can follow
        // a successful insert. Releasing the id here would queue the same work twice.
        let pushes = 0;
        const { acceptance } = build({
            enqueue: () => { pushes += 1; throw new Error('notification handler blew up'); },
        });
        expect(await acceptance.accept({ text: 'hi', requestId: 'r1', expectedRuntimeId: 'runtime-1' }))
            .toMatchObject({ ok: false, unknown: true });
        expect(await acceptance.accept({ text: 'hi', requestId: 'r1', expectedRuntimeId: 'runtime-1' }))
            .toMatchObject({ ok: false, unknown: true });
        expect(pushes).toBe(1);
    });

    it('refuses an in-flight id that arrives with different text', async () => {
        let release = () => {};
        const blocked = new Promise<void>((resolve) => { release = resolve; });
        const { acceptance } = build({
            recordDurably: async () => { await blocked; return { ok: true as const }; },
        });
        const first = acceptance.accept({ text: 'hi', requestId: 'r1', expectedRuntimeId: 'runtime-1' });
        const conflicting = await acceptance.accept({
            text: 'different', requestId: 'r1', expectedRuntimeId: 'runtime-1',
        });
        release();
        await first;
        expect(conflicting).toMatchObject({ ok: false });
    });

    it('reports an ambiguous write as unknown rather than refused', async () => {
        // The record may have landed. Resending would double-run it; calling it refused would
        // lose it. The caller reconciles.
        const { acceptance, enqueued } = build({
            recordDurably: async () => ({ ok: false as const, provenNotWritten: false }),
        });
        expect(await acceptance.accept({ text: 'hi', requestId: 'r1', expectedRuntimeId: 'runtime-1' }))
            .toMatchObject({ ok: false, unknown: true });
        expect(enqueued).toHaveLength(0);
    });

    it('refuses work authorized against a different runtime', async () => {
        // The caller probed one process; this is another. Accepting would run work whose
        // capability proof belongs to a runtime that is gone.
        const { acceptance, enqueued } = build();
        expect(await acceptance.accept({ text: 'hi', requestId: 'r1', expectedRuntimeId: 'runtime-0' }))
            .toMatchObject({ ok: false });
        expect(enqueued).toHaveLength(0);
    });

    it('accepts when the named runtime is this one', async () => {
        const { acceptance } = build();
        expect(await acceptance.accept({ text: 'hi', requestId: 'r1', expectedRuntimeId: 'runtime-1' }))
            .toMatchObject({ ok: true, accepted: true });
    });

    it('never forgets an accepted id, however much time passes', async () => {
        // Forgetting execution evidence lets a redelivery run the work a second time. Memory is
        // bounded by refusing new ids instead — see the capacity test below.
        let now = 1_700_000_000_000;
        const { acceptance, enqueued } = build({ now: () => now });
        await acceptance.accept({ text: 'hi', requestId: 'r1', expectedRuntimeId: 'runtime-1' });
        now += 24 * 60 * 60 * 1000;
        expect(await acceptance.accept({ text: 'hi', requestId: 'r1', expectedRuntimeId: 'runtime-1' }))
            .toMatchObject({ ok: true, duplicate: true });
        expect(enqueued).toHaveLength(1);
    });

    it('never lets an unknown request become executable again with time', async () => {
        let now = 1_700_000_000_000;
        const { acceptance, enqueued } = build({
            now: () => now,
            recordDurably: async () => ({ ok: false as const, provenNotWritten: false }),
        });
        await acceptance.accept({ text: 'hi', requestId: 'r1', expectedRuntimeId: 'runtime-1' });
        now += 24 * 60 * 60 * 1000;
        expect(await acceptance.accept({ text: 'hi', requestId: 'r1', expectedRuntimeId: 'runtime-1' }))
            .toMatchObject({ ok: false, unknown: true });
        expect(enqueued).toHaveLength(0);
    });

    it('refuses new ids at capacity rather than discarding recorded ones', async () => {
        const { acceptance } = build();
        for (let index = 0; index < 2_000; index += 1) {
            await acceptance.accept({ text: 'hi', requestId: `r${index}`, expectedRuntimeId: 'runtime-1' });
        }
        expect(await acceptance.accept({ text: 'hi', requestId: 'overflow', expectedRuntimeId: 'runtime-1' }))
            .toMatchObject({ ok: false });
        // The recorded ones still answer, which is the point of refusing rather than evicting.
        expect(await acceptance.accept({ text: 'hi', requestId: 'r0', expectedRuntimeId: 'runtime-1' }))
            .toMatchObject({ ok: true, duplicate: true });
    });

    it('carries the request id to the queue so the turn can be correlated', async () => {
        const { acceptance, enqueued, recorded } = build();
        await acceptance.accept({ text: 'summarise the failure', requestId: 'core-req-9', expectedRuntimeId: 'runtime-1' });

        expect(enqueued[0]).toEqual({ text: 'summarise the failure', requestId: 'core-req-9' });
        // Recorded under a stable localId so the acknowledgement can be matched.
        expect(recorded[0].localId).toBe('channel:core-req-9');
    });
});


describe('channel cancellation at the provider consumption boundary', () => {
    const request = { text: 'work', requestId: 'cancel-r1', expectedRuntimeId: 'runtime-1' };
    it('remembers cancellation before acceptance and refuses a delayed delivery', async () => {
        const { acceptance, enqueued, recorded } = build();
        expect(acceptance.cancel({ requestId: request.requestId, expectedRuntimeId: request.expectedRuntimeId }))
            .toMatchObject({ ok: true, state: 'cancelled' });
        expect(await acceptance.accept(request)).toMatchObject({ ok: false });
        expect(enqueued).toEqual([]);
        expect(recorded).toEqual([]);
    });
    it('rechecks cancellation after the durable write awaits', async () => {
        let finish!: (value: { ok: true }) => void;
        const { acceptance, enqueued } = build({ recordDurably: () => new Promise(resolve => { finish = resolve; }) });
        const pending = acceptance.accept(request);
        acceptance.cancel({ requestId: request.requestId, expectedRuntimeId: request.expectedRuntimeId });
        finish({ ok: true });
        expect(await pending).toMatchObject({ ok: false });
        expect(enqueued).toEqual([]);
    });
    it('refuses a cancelled item even after dequeue, without cancelling an already started turn', async () => {
        const { acceptance } = build();
        await acceptance.accept(request);
        acceptance.cancel({ requestId: request.requestId, expectedRuntimeId: request.expectedRuntimeId });
        expect(acceptance.beginExecution(request.requestId)).toBe(false);
        await acceptance.accept({ ...request, requestId: 'running' });
        await acceptance.prepareExecution('running');
        expect(acceptance.beginExecution('running')).toBe(true);
        expect(acceptance.cancel({ requestId: 'running', expectedRuntimeId: request.expectedRuntimeId }))
            .toMatchObject({ ok: true, state: 'already-started' });
        expect(acceptance.beginExecution('running')).toBe(false);
    });
    it('rejects stale runtimes and unknown fields without cancelling valid work', async () => {
        const { acceptance } = build();
        await acceptance.accept(request);
        expect(acceptance.cancel({ requestId: request.requestId, expectedRuntimeId: 'old' })).toMatchObject({ ok: false });
        expect(acceptance.cancel({ requestId: request.requestId, expectedRuntimeId: request.expectedRuntimeId, all: true }))
            .toMatchObject({ ok: false });
        await acceptance.prepareExecution(request.requestId);
        expect(acceptance.beginExecution(request.requestId)).toBe(true);
        expect(acceptance.beginExecution('unknown')).toBe(false);
    });
});


it('removes only the cancelled request and preserves Desktop order and a different channel', async () => {
    const queue = new MessageQueue2<string>(mode => mode);
    queue.push('desktop-before', 'default');
    queue.pushIsolated('cancel-me', 'default', [], undefined, 'r1');
    queue.pushIsolated('keep-me', 'default', [], undefined, 'r2');
    queue.push('desktop-after', 'default');
    expect(queue.removeByRequestId('r1')).toBe(1);
    expect(queue.removeByRequestId('missing')).toBe(0);
    expect((await queue.waitForMessagesAndGetAsString())?.message).toBe('desktop-before');
    expect((await queue.waitForMessagesAndGetAsString())?.channelRequestId).toBe('r2');
    expect((await queue.waitForMessagesAndGetAsString())?.message).toBe('desktop-after');
});


describe('fresh execution approval', () => {
    const request = { text: 'work', requestId: 'approval-r1', expectedRuntimeId: 'runtime-1' };
    it('waits for a fresh single-use nonce and rejects stale or mismatched replies', async () => {
        let ready!: { requestId: string; runtimeId: string; nonce: string };
        const { acceptance } = build({ requestApproval: input => { ready = input; } });
        await acceptance.accept(request);
        const prepared = acceptance.prepareExecution(request.requestId);
        expect(acceptance.beginExecution(request.requestId)).toBe(false);
        expect(acceptance.authorize({ requestId: request.requestId, expectedRuntimeId: 'old', nonce: ready.nonce, decision: 'allow' }))
            .toMatchObject({ ok: false });
        const decision = { requestId: request.requestId, expectedRuntimeId: request.expectedRuntimeId, nonce: ready.nonce, decision: 'allow' };
        expect(acceptance.authorize(decision)).toMatchObject({ ok: true, applied: true });
        expect(await prepared).toBe(true);
        expect(acceptance.authorize(decision)).toMatchObject({ ok: false });
        expect(acceptance.beginExecution(request.requestId)).toBe(true);
    });
    /**
     * A refusal from Core must be a refusal here. The waiter resolves either way, so treating the
     * decision as "an answer arrived" rather than reading it grants the permit that
     * `beginExecution` consumes — the request then runs on an explicit deny.
     */
    it('refuses to run on a deny, and the deny is final', async () => {
        let ready!: { requestId: string; runtimeId: string; nonce: string };
        const { acceptance } = build({ requestApproval: input => { ready = input; } });
        await acceptance.accept(request);
        const prepared = acceptance.prepareExecution(request.requestId);

        expect(acceptance.authorize({
            requestId: request.requestId, expectedRuntimeId: request.expectedRuntimeId,
            nonce: ready.nonce, decision: 'deny',
        })).toMatchObject({ ok: true, applied: true });

        expect(await prepared).toBe(false);
        expect(acceptance.beginExecution(request.requestId)).toBe(false);
        // And a late allow cannot revive it: the round is over, not merely unanswered.
        expect(acceptance.authorize({
            requestId: request.requestId, expectedRuntimeId: request.expectedRuntimeId,
            nonce: ready.nonce, decision: 'allow',
        })).toMatchObject({ ok: false });
        expect(acceptance.beginExecution(request.requestId)).toBe(false);
    });

    /**
     * The nonce is what binds an answer to *this* approval round. Without comparing it, any reply
     * naming the request answers whichever round is open — including one raised after the reply
     * was minted. The existing test above changes `expectedRuntimeId`, which exercises the runtime
     * binding, not this one.
     */
    it('refuses a reply whose nonce belongs to no round, and leaves the round open', async () => {
        let ready!: { requestId: string; runtimeId: string; nonce: string };
        const { acceptance } = build({ requestApproval: input => { ready = input; } });
        await acceptance.accept(request);
        const prepared = acceptance.prepareExecution(request.requestId);

        expect(acceptance.authorize({
            requestId: request.requestId, expectedRuntimeId: request.expectedRuntimeId,
            nonce: '00000000-0000-4000-8000-000000000000', decision: 'allow',
        })).toMatchObject({ ok: false });
        expect(acceptance.beginExecution(request.requestId)).toBe(false);

        // Still open: a bogus reply must not consume the waiter the real one is coming for.
        expect(acceptance.authorize({
            requestId: request.requestId, expectedRuntimeId: request.expectedRuntimeId,
            nonce: ready.nonce, decision: 'allow',
        })).toMatchObject({ ok: true, applied: true });
        expect(await prepared).toBe(true);
        expect(acceptance.beginExecution(request.requestId)).toBe(true);
    });

    it('cancellation wins while awaiting Core and after allow but before actual dispatch', async () => {
        let ready!: { nonce: string };
        const { acceptance } = build({ requestApproval: input => { ready = input; } });
        await acceptance.accept(request);
        const prepared = acceptance.prepareExecution(request.requestId);
        acceptance.cancel({ requestId: request.requestId, expectedRuntimeId: request.expectedRuntimeId });
        expect(await prepared).toBe(false);
        expect(acceptance.authorize({ requestId: request.requestId, expectedRuntimeId: request.expectedRuntimeId, nonce: ready.nonce, decision: 'allow' })).toMatchObject({ ok: false });
        expect(acceptance.beginExecution(request.requestId)).toBe(false);
    });
    /**
     * The order that matters most: authority was granted and then withdrawn before anything ran.
     * The test above cancels *while* Core is still deciding, which the waiter handles; this one
     * cancels after the permit exists, so only the check at the dispatch boundary can stop it.
     */
    it('a cancel that lands after allow still stops the dispatch', async () => {
        let ready!: { requestId: string; runtimeId: string; nonce: string };
        const { acceptance } = build({ requestApproval: input => { ready = input; } });
        await acceptance.accept(request);
        const prepared = acceptance.prepareExecution(request.requestId);
        expect(acceptance.authorize({
            requestId: request.requestId, expectedRuntimeId: request.expectedRuntimeId,
            nonce: ready.nonce, decision: 'allow',
        })).toMatchObject({ ok: true, applied: true });
        expect(await prepared).toBe(true);

        expect(acceptance.cancel({ requestId: request.requestId, expectedRuntimeId: request.expectedRuntimeId }))
            .toMatchObject({ ok: true, state: 'cancelled' });
        expect(acceptance.beginExecution(request.requestId)).toBe(false);
    });

    /** The opposite order: once the dispatch is claimed, a cancel reports the turn it cannot stop. */
    it('a cancel that lands after the dispatch reports already-started', async () => {
        const { acceptance } = build();
        await acceptance.accept(request);
        expect(await acceptance.prepareExecution(request.requestId)).toBe(true);
        expect(acceptance.beginExecution(request.requestId)).toBe(true);

        expect(acceptance.cancel({ requestId: request.requestId, expectedRuntimeId: request.expectedRuntimeId }))
            .toMatchObject({ ok: true, state: 'already-started' });
        // And it cannot be started a second time by the cancel having touched the state.
        expect(acceptance.beginExecution(request.requestId)).toBe(false);
    });

    it('times out offline without running or accepting a late allow', async () => {
        vi.useFakeTimers();
        try {
            let ready!: { nonce: string };
            const { acceptance } = build({ requestApproval: input => { ready = input; } });
            await acceptance.accept(request);
            const prepared = acceptance.prepareExecution(request.requestId);
            await vi.advanceTimersByTimeAsync(30_001);
            expect(await prepared).toBe(false);
            expect(acceptance.beginExecution(request.requestId)).toBe(false);
            expect(acceptance.authorize({ requestId: request.requestId, expectedRuntimeId: request.expectedRuntimeId, nonce: ready.nonce, decision: 'allow' })).toMatchObject({ ok: false });
        } finally { vi.useRealTimers(); }
    });
});


it('cancellation after Core allow still wins before the final synchronous start', async () => {
    const { acceptance } = build();
    await acceptance.accept({ text: 'work', requestId: 'r1', expectedRuntimeId: 'runtime-1' });
    expect(await acceptance.prepareExecution('r1')).toBe(true);
    acceptance.cancel({ requestId: 'r1', expectedRuntimeId: 'runtime-1' });
    expect(acceptance.beginExecution('r1')).toBe(false);
});
