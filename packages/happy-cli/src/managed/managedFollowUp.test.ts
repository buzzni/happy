/**
 * The next turn of a managed session, as the child reads it (T07-L5-b).
 *
 * The server relays the sealed payload verbatim; what is inside is this
 * module's contract. Two things are decided here and nowhere else: whether the
 * payload is a turn at all, and whether this exact turn was already taken —
 * a retry of one send must not become two turns.
 */
import { describe, expect, it } from 'vitest';

import {
    MANAGED_FOLLOW_UP_FRAME, createManagedFollowUpGate, createManagedFollowUpHandler,
    frameManagedFollowUpForProvider, parseManagedFollowUp,
} from './managedFollowUp';

describe('parseManagedFollowUp', () => {
    it('reads a text turn with its client id', () => {
        expect(parseManagedFollowUp({ localId: 'm-1', text: 'Reply PING' }))
            .toEqual({ ok: true, localId: 'm-1', text: 'Reply PING' });
    });

    it('refuses anything that is not a text turn, naming why', () => {
        expect(parseManagedFollowUp(null)).toEqual({ ok: false, reason: 'malformed' });
        expect(parseManagedFollowUp('Reply PING')).toEqual({ ok: false, reason: 'malformed' });
        expect(parseManagedFollowUp({ text: 'x' })).toEqual({ ok: false, reason: 'malformed' });
        expect(parseManagedFollowUp({ localId: 'm-1', text: '   ' })).toEqual({ ok: false, reason: 'empty-text' });
        expect(parseManagedFollowUp({ localId: 'm-1', text: 'x'.repeat(200_001) })).toEqual({ ok: false, reason: 'text-too-long' });
    });

    it('refuses a queue command: it is not a turn, and it drops turns already taken', () => {
        expect(parseManagedFollowUp({ localId: 'm-1', text: '/clear' })).toEqual({ ok: false, reason: 'command-not-allowed' });
        expect(parseManagedFollowUp({ localId: 'm-1', text: '  /compact  ' })).toEqual({ ok: false, reason: 'command-not-allowed' });
        // A goal is an instruction carried into every later turn — the very thing
        // the managed `goal-action` RPC refuses. The queue must not be a way round it.
        expect(parseManagedFollowUp({ localId: 'm-1', text: '/goal ship it' })).toEqual({ ok: false, reason: 'command-not-allowed' });
        expect(parseManagedFollowUp({ localId: 'm-1', text: '/GOAL clear' })).toEqual({ ok: false, reason: 'command-not-allowed' });
        // A slash inside a sentence is text, and so is a leading path — the provider
        // would take these as prompts, and so does the parse.
        expect(parseManagedFollowUp({ localId: 'm-1', text: 'run /clear on the queue?' })).toMatchObject({ ok: true });
        expect(parseManagedFollowUp({ localId: 'm-1', text: '/src/app.ts 의 버그를 고쳐줘' })).toMatchObject({ ok: true });
        expect(parseManagedFollowUp({ localId: 'm-1', text: '/tmp 디렉터리를 확인해줘' })).toMatchObject({ ok: true });
    });

    it('takes only the text: a follow-up carries no options, whatever the payload claims', () => {
        // Model, mode, prompts and tools were fixed when the run was admitted.
        const parsed = parseManagedFollowUp({
            localId: 'm-1', text: 'Reply PING', meta: { model: 'other', permissionMode: 'bypassPermissions' },
        });
        expect(parsed).toEqual({ ok: true, localId: 'm-1', text: 'Reply PING' });
    });
});

describe('frameManagedFollowUpForProvider', () => {
    it('frames anything the provider would read as its own command, whatever the name', () => {
        /*
         * The embedded Claude SDK dispatches /reset, /model, /effort, /mcp, /exit and
         * any registered name — digits, underscores, non-ASCII too — from plain user
         * text, and swallows an unknown name. Framed, it reads the user's words.
         */
        for (const text of [
            '/reset', '/new', '/clear named', '/model opus', '/effort high', '/mcp disable all', '/exit',
            ' /Custom:thing now', '/2fa', '/_internal', '/--model opus', '/:model opus', '/?!reset', '/한글명령',
            '/tmp 디렉터리를 확인해줘', '/README 내용을 요약해줘', '/hello world/.test(value)',
        ]) {
            expect(frameManagedFollowUpForProvider(text)).toBe(`${MANAGED_FOLLOW_UP_FRAME}${text}`);
        }
    });

    it('leaves text that no provider reads as a command untouched', () => {
        for (const text of ['Reply PING', 'run /clear on the queue?', '/ 로 시작하는 문장', '／model opus']) {
            expect(frameManagedFollowUpForProvider(text)).toBe(text);
        }
    });
});

describe('createManagedFollowUpGate', () => {
    it('accepts a turn once and calls the same client id a duplicate after that', () => {
        const gate = createManagedFollowUpGate();
        expect(gate.take('m-1')).toBe('accepted');
        expect(gate.take('m-1')).toBe('duplicate');
        expect(gate.take('m-2')).toBe('accepted');
    });

    it('takes an id again once it was given back', () => {
        const gate = createManagedFollowUpGate();
        gate.take('m-1');
        gate.release('m-1');
        expect(gate.take('m-1')).toBe('accepted');
        // Releasing an id nobody took changes nothing.
        gate.release('m-9');
        expect(gate.take('m-9')).toBe('accepted');
    });

    it('remembers a bounded number of ids, oldest first out', () => {
        const gate = createManagedFollowUpGate({ remember: 2 });
        gate.take('a'); gate.take('b'); gate.take('c');
        expect(gate.take('a')).toBe('accepted');
        expect(gate.take('c')).toBe('duplicate');
    });
});

describe('createManagedFollowUpHandler', () => {
    function build(over: { managed?: boolean } = {}) {
        const calls: string[] = [];
        const handler = createManagedFollowUpHandler({
            managed: () => over.managed ?? true,
            echo: (turn) => calls.push(`echo:${turn.localId}:${turn.text}`),
            enqueue: (text) => calls.push(`enqueue:${text}`),
        });
        return { handler, calls };
    }

    it('queues the framed text for the provider but shows the user their own words', async () => {
        const turns: Array<{ text: string; queued: string }> = [];
        const queued: string[] = [];
        const handler = createManagedFollowUpHandler({
            managed: () => true,
            echo: (turn) => turns.push({ text: turn.text, queued: turn.queued }),
            enqueue: (text) => queued.push(text),
        });
        expect(await handler({ localId: 'm-1', text: '/tmp 디렉터리를 확인해줘' })).toEqual({ accepted: true });
        // What the provider gets is framed; the transcript row is the original, and the
        // scanner is told the framed text because that is what it will meet in the log.
        expect(queued).toEqual([`${MANAGED_FOLLOW_UP_FRAME}/tmp 디렉터리를 확인해줘`]);
        expect(turns).toEqual([{ text: '/tmp 디렉터리를 확인해줘', queued: `${MANAGED_FOLLOW_UP_FRAME}/tmp 디렉터리를 확인해줘` }]);
    });

    it('queues the turn, shows it in the same tick, and reports it accepted', async () => {
        const { handler, calls } = build();
        expect(await handler({ localId: 'm-1', text: 'Reply PING' })).toEqual({ accepted: true });
        expect(calls).toEqual(['enqueue:Reply PING', 'echo:m-1:Reply PING']);
    });

    it('gives the client id back when the queue refuses, so the retry is a turn and not a duplicate', async () => {
        const calls: string[] = [];
        let closed = true;
        const handler = createManagedFollowUpHandler({
            managed: () => true,
            echo: (turn) => calls.push(`echo:${turn.localId}`),
            enqueue: (text) => { if (closed) throw new Error('Cannot push to closed queue'); calls.push(`enqueue:${text}`); },
        });
        // A run winding down closes its queue; the sender sees a refusal, not a phantom acceptance.
        expect(await handler({ localId: 'm-1', text: 'Reply PING' })).toEqual({ accepted: false, reason: 'not-accepting' });
        expect(calls).toEqual([]);
        closed = false;
        expect(await handler({ localId: 'm-1', text: 'Reply PING' })).toEqual({ accepted: true });
        expect(calls).toEqual(['enqueue:Reply PING', 'echo:m-1']);
    });

    it('takes a retry of the same turn once: the second answer says duplicate and queues nothing', async () => {
        const { handler, calls } = build();
        await handler({ localId: 'm-1', text: 'Reply PING' });
        expect(await handler({ localId: 'm-1', text: 'Reply PING' })).toEqual({ accepted: true, duplicate: true });
        expect(calls).toHaveLength(2);
    });

    it('refuses outside a managed run before anything is shown or queued', async () => {
        const { handler, calls } = build({ managed: false });
        expect(await handler({ localId: 'm-1', text: 'Reply PING' })).toEqual({ accepted: false, reason: 'not-managed' });
        expect(calls).toEqual([]);
    });

    it('refuses a payload that is not a turn, naming why, and takes no client id for it', async () => {
        const { handler, calls } = build();
        expect(await handler({ localId: 'm-1', text: '/clear' })).toEqual({ accepted: false, reason: 'command-not-allowed' });
        // The id was not consumed: the same id with real text is a new turn.
        expect(await handler({ localId: 'm-1', text: 'Reply PING' })).toEqual({ accepted: true });
        expect(calls).toEqual(['enqueue:Reply PING', 'echo:m-1:Reply PING']);
    });
});
