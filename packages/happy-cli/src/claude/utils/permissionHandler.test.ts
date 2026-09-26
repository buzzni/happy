import { describe, it, expect } from 'vitest';
import type { SessionEvent } from '@slopus/happy-wire';
import { installChannelPermissionWiring } from '@/channel/channelPermissionWiring';
import { createOrderedTurnDispatcher } from '@/channel/channelTurnOrdering';
import { OutgoingMessageQueue } from './OutgoingMessageQueue';
import { PermissionHandler } from './permissionHandler';
import type { Session } from '../session';
import type { EnhancedMode } from '../loop';

function stubOptions() {
    return { signal: new AbortController().signal, toolUseID: 'tool-call-1' };
}

function stubMode(): EnhancedMode {
    return { permissionMode: 'yolo' };
}

/**
 * Minimal Session stand-in: reset() only touches the agent-state updater, and
 * the constructor only registers an RPC handler.
 */
function createSessionStub(): Session {
    return {
        client: {
            sessionId: 'session-under-test',
            rpcHandlerManager: { registerHandler: () => { } },
            updateAgentState: (updater: (state: any) => any) => { updater({}); },
            getMetadata: () => ({}),
        },
        api: { push: () => ({ sendSessionNotification: () => { } }) },
    } as unknown as Session;
}

describe('PermissionHandler.reset', () => {
    // The mode updater captures the Query object of the generation that set it,
    // and reset() runs when that generation is torn down.
    it('releases the mode updater captured from the finished query generation', () => {
        const handler = new PermissionHandler(createSessionStub());
        handler.setPermissionModeUpdater(async () => { });

        handler.reset();

        const internals = handler as unknown as { setPermissionModeCallback?: unknown };
        expect(internals.setPermissionModeCallback).toBeUndefined();
    });

    // Registered once outside the restart loop and bound to the launcher-scoped
    // message queue, so clearing it would silently stop releasing delayed
    // messages for every query after the first reset.
    it('keeps the permission-request callback that outlives query generations', () => {
        const handler = new PermissionHandler(createSessionStub());
        handler.setOnPermissionRequest(() => { });

        handler.reset();

        const internals = handler as unknown as { onPermissionRequestCallback?: unknown };
        expect(internals.onPermissionRequestCallback).toBeTypeOf('function');
    });
});

describe('PermissionHandler.handleToolCall with yolo mode', () => {
    // runClaude.ts defaults the initial permission mode to 'yolo' when no
    // --dangerously-skip-permissions flag or explicit mode is supplied, and
    // handleModeChange forwards that raw value untouched. 'yolo' is Claude's
    // bypass-equivalent (see mapToClaudeMode), so tool calls must be
    // auto-allowed instead of falling through to an approval request.
    it('auto-allows a dangerous tool call once the mode is set to yolo', async () => {
        const handler = new PermissionHandler(createSessionStub());
        handler.handleModeChange('yolo');

        // If yolo falls through to the approval flow, handleToolCall's promise
        // never resolves (nothing sends a permission response), so race it
        // against a timeout sentinel instead of awaiting it directly.
        const timeout = new Promise<'TIMED_OUT'>((resolve) => setTimeout(() => resolve('TIMED_OUT'), 200));
        const result = await Promise.race([
            handler.handleToolCall('Write', { file_path: 'a.txt' }, stubMode(), stubOptions()),
            timeout,
        ]);

        expect(result).not.toBe('TIMED_OUT');
        expect((result as { behavior: string }).behavior).toBe('allow');
    });
});

/**
 * Captures the RPC handler the constructor registers, so a test can deliver a permission answer
 * the way the real transport does (Saycode specs/desktop-messenger-channels — T21/R9).
 */
function createRecordingSessionStub(): {
    session: Session;
    answer: (message: unknown) => Promise<{ applied: boolean; reason?: string }>;
    answerChannel: (message: unknown) => Promise<{ applied: boolean; reason?: string }>;
    registeredMethods: () => string[];
    state: () => Record<string, unknown>;
} {
    // Keyed by method name, because the handler registers two and the difference between them is
    // the fail-closed boundary. A single captured handler would silently test whichever came last.
    const handlers = new Map<string, (message: any) => Promise<any>>();
    let agentState: Record<string, unknown> = {};
    const session = {
        client: {
            sessionId: 'session-under-test',
            rpcHandlerManager: {
                registerHandler: (name: string, fn: (message: any) => Promise<any>) => {
                    handlers.set(name, fn);
                },
            },
            updateAgentState: (updater: (state: any) => any) => { agentState = updater(agentState); },
            getMetadata: () => ({}),
        },
        api: { push: () => ({ sendSessionNotification: () => { } }) },
    } as unknown as Session;
    const call = async (method: string, message: unknown) => {
        const handler = handlers.get(method);
        if (!handler) throw new Error(`RPC method ${method} was never registered`);
        return handler(message);
    };
    return {
        session,
        answer: (message: unknown) => call('permission', message),
        answerChannel: (message: unknown) => call('channel-permission', message),
        registeredMethods: () => [...handlers.keys()].sort(),
        state: () => agentState,
    };
}

describe('PermissionHandler external channel answers', () => {
    const CLAIM = { turnId: 'turn-a', channelRequestId: 'req-1', runtimeId: 'runtime-1' };

    /**
     * Drives the **production** path: the real ordered dispatcher, the real outgoing queue, and
     * `installChannelPermissionWiring` — the same function the Claude launcher calls. Nothing
     * here sets a binding by hand, because a hand-set binding would not prove that the launcher
     * ever produces one.
     */
    function raise(
        stub: ReturnType<typeof createRecordingSessionStub>,
        toolName = 'Bash',
        turn: { turnId: string | null; channelRequestId: string | null } = {
            turnId: 'turn-a', channelRequestId: 'req-1',
        },
    ) {
        const handler = new PermissionHandler(stub.session);
        const published: SessionEvent[] = [];
        let bind: (permissionId: string, toolName: string, instanceSeq: number) => void = () => { };
        const queue = new OutgoingMessageQueue(createOrderedTurnDispatcher({
            setPendingTurnRequestId: () => { },
            sendFinalAnswerForChannelTurn: () => { },
            closeClaudeSessionTurn: () => { },
            sendClaudeSessionMessage: () => { },
            bindChannelPermission: (permissionId, tool, seq) => bind(permissionId, tool, seq),
        }));
        bind = installChannelPermissionWiring({
            queue,
            handler,
            turnContextFor: (_toolCallId, apply) => {
                if (turn.turnId === null) return;
                apply({ turnId: turn.turnId, channelRequestId: turn.channelRequestId, runtimeId: 'runtime-1' });
            },
            publish: (event) => { published.push(event); },
        });
        // Argument order is (toolName, input, mode, options) — see the yolo test above.
        const decided = handler.handleToolCall(
            toolName, { command: 'ls' }, { permissionMode: 'default' }, stubOptions(),
        );
        // The binding is applied from the queue, so the prompt is not bound until it drains.
        const bound = queue.flush();
        return { handler, decided, published, queue, bound };
    }

    it('applies an external answer that reproduces the whole binding', async () => {
        const stub = createRecordingSessionStub();
        const { decided, bound } = raise(stub);
        await bound;
        const ack = await stub.answer({ id: 'tool-call-1', approved: true, channelClaim: CLAIM });
        expect(ack).toEqual({ applied: true });
        await expect(decided).resolves.toMatchObject({ behavior: 'allow' });
    });

    it('leaves the prompt answerable in Desktop after refusing a forged external claim', async () => {
        // The race that matters: a refused external claim must not consume the pending request,
        // or the Desktop user is left looking at a prompt nothing can answer.
        const stub = createRecordingSessionStub();
        const { decided, bound } = raise(stub);
        await bound;

        const forged = await stub.answer({
            id: 'tool-call-1', approved: true, channelClaim: { ...CLAIM, turnId: 'turn-other' },
        });
        expect(forged.applied).toBe(false);

        // Still pending: an ordinary Desktop answer (no channelClaim) still lands.
        const desktop = await stub.answer({ id: 'tool-call-1', approved: false });
        expect(desktop).toEqual({ applied: true });
        await expect(decided).resolves.toMatchObject({ behavior: 'deny' });
    });

    it('refuses an external answer to a prompt no channel request opened', async () => {
        const stub = createRecordingSessionStub();
        const { decided, bound } = raise(stub, 'Bash', { turnId: 'turn-a', channelRequestId: null });
        await bound;
        const ack = await stub.answer({ id: 'tool-call-1', approved: true, channelClaim: CLAIM });
        expect(ack.applied).toBe(false);
        await stub.answer({ id: 'tool-call-1', approved: false });
        await expect(decided).resolves.toMatchObject({ behavior: 'deny' });
    });

    it('refuses an external answer carrying a persistent grant', async () => {
        const stub = createRecordingSessionStub();
        const { decided, bound } = raise(stub);
        await bound;
        for (const extra of [
            { allowTools: ['Bash'] },
            { mode: 'bypassPermissions' },
            { updatedInput: { command: 'rm -rf /' } },
            { decision: 'approved_for_session' },
        ]) {
            const ack = await stub.answer({
                id: 'tool-call-1', approved: true, channelClaim: CLAIM, ...extra,
            });
            expect(ack.applied, JSON.stringify(extra)).toBe(false);
        }
        await stub.answer({ id: 'tool-call-1', approved: false });
        await expect(decided).resolves.toMatchObject({ behavior: 'deny' });
    });

    it('records no external binding for a prompt that is not a yes/no', async () => {
        const stub = createRecordingSessionStub();
        const { decided } = raise(stub, 'ExitPlanMode');
        const ack = await stub.answer({ id: 'tool-call-1', approved: true, channelClaim: CLAIM });
        expect(ack.applied).toBe(false);
        await stub.answer({ id: 'tool-call-1', approved: false });
        await expect(decided).resolves.toBeDefined();
    });

    it('does not let a second external answer re-consume an answered prompt', async () => {
        const stub = createRecordingSessionStub();
        const { bound } = raise(stub);
        await bound;
        expect(await stub.answer({ id: 'tool-call-1', approved: true, channelClaim: CLAIM }))
            .toEqual({ applied: true });
        const second = await stub.answer({ id: 'tool-call-1', approved: true, channelClaim: CLAIM });
        expect(second).toEqual({ applied: false, reason: 'already-answered' });
    });
});

describe('PermissionHandler channel binding lifecycle', () => {
    const CLAIM = { turnId: 'turn-a', channelRequestId: 'req-1', runtimeId: 'runtime-1' };

    function wire(stub: ReturnType<typeof createRecordingSessionStub>, signal: AbortSignal) {
        const handler = new PermissionHandler(stub.session);
        const published: SessionEvent[] = [];
        let bind: (permissionId: string, toolName: string, instanceSeq: number) => void = () => { };
        const queue = new OutgoingMessageQueue(createOrderedTurnDispatcher({
            setPendingTurnRequestId: () => { },
            sendFinalAnswerForChannelTurn: () => { },
            closeClaudeSessionTurn: () => { },
            sendClaudeSessionMessage: () => { },
            bindChannelPermission: (permissionId, tool, seq) => bind(permissionId, tool, seq),
        }));
        bind = installChannelPermissionWiring({
            queue,
            handler,
            turnContextFor: (_toolCallId, apply) =>
                apply({ turnId: 'turn-a', channelRequestId: 'req-1', runtimeId: 'runtime-1' }),
            publish: (event) => { published.push(event); },
        });
        const decided = handler.handleToolCall(
            'Bash', { command: 'ls' }, { permissionMode: 'default' }, { signal, toolUseID: 'tool-call-1' },
        );
        return { handler, decided, queue, published };
    }

    it('is not bound until the queue applies it, and an answer in that window is refused', async () => {
        // The window is real and deliberate: the prompt is published to clients synchronously
        // while the binding waits behind the tool-call message. Refused, never guessed.
        const stub = createRecordingSessionStub();
        const controller = new AbortController();
        const { handler, decided, queue } = wire(stub, controller.signal);

        expect(handler.channelBindingFor('tool-call-1')).toBeUndefined();
        const early = await stub.answer({ id: 'tool-call-1', approved: true, channelClaim: CLAIM });
        expect(early).toEqual({ applied: false, reason: 'unknown-request' });

        await queue.flush();
        expect(handler.channelBindingFor('tool-call-1')).toMatchObject({ turnId: 'turn-a' });
        expect(await stub.answer({ id: 'tool-call-1', approved: false, channelClaim: CLAIM }))
            .toEqual({ applied: true });
        await expect(decided).resolves.toMatchObject({ behavior: 'deny' });
    });

    it('drops the binding when the prompt is aborted', async () => {
        const stub = createRecordingSessionStub();
        const controller = new AbortController();
        const { handler, decided, queue } = wire(stub, controller.signal);
        await queue.flush();
        expect(handler.channelBindingFor('tool-call-1')).toBeDefined();

        controller.abort();
        await expect(decided).rejects.toThrow('Permission request aborted');
        expect(handler.channelBindingFor('tool-call-1')).toBeUndefined();
    });

    it('does not re-bind a prompt that was already aborted', async () => {
        // The queue item can arrive after the abort. Re-adding the binding then would leave an
        // entry with no pending request behind it.
        const stub = createRecordingSessionStub();
        const controller = new AbortController();
        const { handler, decided, queue } = wire(stub, controller.signal);
        controller.abort();
        await expect(decided).rejects.toThrow('Permission request aborted');
        await queue.flush();
        expect(handler.channelBindingFor('tool-call-1')).toBeUndefined();
    });

    it('drops the binding when the prompt is answered', async () => {
        const stub = createRecordingSessionStub();
        const { handler, decided, queue } = wire(stub, new AbortController().signal);
        await queue.flush();
        await stub.answer({ id: 'tool-call-1', approved: true, channelClaim: CLAIM });
        await decided;
        expect(handler.channelBindingFor('tool-call-1')).toBeUndefined();
    });

    it('clears bindings on reset', async () => {
        const stub = createRecordingSessionStub();
        const { handler, decided, queue } = wire(stub, new AbortController().signal);
        await queue.flush();
        expect(handler.channelBindingFor('tool-call-1')).toBeDefined();

        handler.reset('test');
        await expect(decided).rejects.toThrow('Session reset');
        expect(handler.channelBindingFor('tool-call-1')).toBeUndefined();
    });

    it('publishes a sanitized observation and nothing about the tool input', async () => {
        const stub = createRecordingSessionStub();
        const { published, queue } = wire(stub, new AbortController().signal);
        await queue.flush();

        expect(published).toHaveLength(1);
        const event = published[0] as Record<string, unknown>;
        // Exact, not `toMatchObject`: the input was `{ command: 'ls' }` and the tool was `Bash`.
        // A deep equality is what proves neither appears. A substring check on the JSON would be
        // weaker *and* wrong — `ls` occurs inside `false`.
        expect(event).toEqual({
            t: 'channel-permission',
            permissionId: 'tool-call-1',
            turnId: 'turn-a',
            channelRequestId: 'req-1',
            runtimeId: 'runtime-1',
            kind: 'generic',
            createdAt: expect.any(Number),
        });
    });
});

describe('PermissionHandler channel withdrawal and instance pinning', () => {
    const CLAIM = { turnId: 'turn-a', channelRequestId: 'req-1', runtimeId: 'runtime-1' };

    function wireWithSeq(stub: ReturnType<typeof createRecordingSessionStub>, signal: AbortSignal) {
        const handler = new PermissionHandler(stub.session);
        const published: SessionEvent[] = [];
        const seen: { permissionId: string; instanceSeq: number }[] = [];
        let bind: (permissionId: string, toolName: string, instanceSeq: number) => void = () => { };
        const queue = new OutgoingMessageQueue(createOrderedTurnDispatcher({
            setPendingTurnRequestId: () => { },
            sendFinalAnswerForChannelTurn: () => { },
            closeClaudeSessionTurn: () => { },
            sendClaudeSessionMessage: () => { },
            bindChannelPermission: (permissionId, tool, seq) => {
                seen.push({ permissionId, instanceSeq: seq });
                bind(permissionId, tool, seq);
            },
        }));
        bind = installChannelPermissionWiring({
            queue,
            handler,
            turnContextFor: (_toolCallId, apply) =>
                apply({ turnId: 'turn-a', channelRequestId: 'req-1', runtimeId: 'runtime-1' }),
            publish: (event) => { published.push(event); },
        });
        const raise = (sig: AbortSignal) => handler.handleToolCall(
            'Bash', { command: 'ls' }, { permissionMode: 'default' },
            { signal: sig, toolUseID: 'tool-call-1' },
        );
        return { handler, queue, published, seen, raise, decided: raise(signal) };
    }

    const kinds = (published: SessionEvent[]) => published.map((event) => (event as { t: string }).t);
    const reasons = (published: SessionEvent[]) => published
        .filter((event) => (event as { t: string }).t === 'channel-permission-withdrawn')
        .map((event) => (event as unknown as { reason: string }).reason);

    it('withdraws when the prompt is answered', async () => {
        const stub = createRecordingSessionStub();
        const { queue, published, decided } = wireWithSeq(stub, new AbortController().signal);
        await queue.flush();
        await stub.answer({ id: 'tool-call-1', approved: true, channelClaim: CLAIM });
        await decided;
        expect(kinds(published)).toEqual(['channel-permission', 'channel-permission-withdrawn']);
        expect(reasons(published)).toEqual(['answered']);
    });

    it('withdraws when a Desktop answer (no channelClaim) takes the prompt', async () => {
        // The messenger asked; the Desktop user answered. The external button must still die.
        const stub = createRecordingSessionStub();
        const { queue, published, decided } = wireWithSeq(stub, new AbortController().signal);
        await queue.flush();
        await stub.answer({ id: 'tool-call-1', approved: false });
        await decided;
        expect(reasons(published)).toEqual(['answered']);
    });

    it('withdraws when the prompt is aborted', async () => {
        const stub = createRecordingSessionStub();
        const controller = new AbortController();
        const { queue, published, decided } = wireWithSeq(stub, controller.signal);
        await queue.flush();
        controller.abort();
        await expect(decided).rejects.toThrow('Permission request aborted');
        expect(reasons(published)).toEqual(['aborted']);
    });

    it('withdraws when the session is reset', async () => {
        const stub = createRecordingSessionStub();
        const { handler, queue, published, decided } = wireWithSeq(stub, new AbortController().signal);
        await queue.flush();
        handler.reset('test');
        await expect(decided).rejects.toThrow('Session reset');
        expect(reasons(published)).toEqual(['reset']);
    });

    it('withdraws exactly once, even if the prompt is answered twice', async () => {
        const stub = createRecordingSessionStub();
        const { queue, published, decided } = wireWithSeq(stub, new AbortController().signal);
        await queue.flush();
        await stub.answer({ id: 'tool-call-1', approved: true, channelClaim: CLAIM });
        await decided;
        await stub.answer({ id: 'tool-call-1', approved: true, channelClaim: CLAIM });
        expect(reasons(published)).toEqual(['answered']);
    });

    it('does not withdraw for an in-app prompt, which was never published', async () => {
        const stub = createRecordingSessionStub();
        const handler = new PermissionHandler(stub.session);
        const published: SessionEvent[] = [];
        let bind: (permissionId: string, toolName: string, instanceSeq: number) => void = () => { };
        const queue = new OutgoingMessageQueue(createOrderedTurnDispatcher({
            setPendingTurnRequestId: () => { },
            sendFinalAnswerForChannelTurn: () => { },
            closeClaudeSessionTurn: () => { },
            sendClaudeSessionMessage: () => { },
            bindChannelPermission: (permissionId, tool, seq) => bind(permissionId, tool, seq),
        }));
        bind = installChannelPermissionWiring({
            queue,
            handler,
            // No external request: this prompt is the Desktop user's.
            turnContextFor: (_toolCallId, apply) =>
                apply({ turnId: 'turn-a', channelRequestId: null, runtimeId: 'runtime-1' }),
            publish: (event) => { published.push(event); },
        });
        const decided = handler.handleToolCall(
            'Bash', { command: 'ls' }, { permissionMode: 'default' },
            { signal: new AbortController().signal, toolUseID: 'tool-call-1' },
        );
        await queue.flush();
        await stub.answer({ id: 'tool-call-1', approved: false });
        await decided;
        expect(published).toEqual([]);
    });

    it('will not rebind a prompt whose id a later request reused', async () => {
        // The queue item for the first raising can arrive after that raising is gone. The second
        // request carries the same permission id, so only the instance seq tells them apart.
        const stub = createRecordingSessionStub();
        const first = new AbortController();
        const { handler, queue, seen, raise, decided } = wireWithSeq(stub, first.signal);

        first.abort();
        await expect(decided).rejects.toThrow('Permission request aborted');

        // Second raising, same id, new instance.
        const second = raise(new AbortController().signal);
        // Now the *first* raising's queue item lands.
        const staleSeq = seen[0]?.instanceSeq ?? 1;
        handler.bindChannelPermission({
            permissionId: 'tool-call-1',
            toolName: 'Bash',
            instanceSeq: staleSeq,
            turnId: 'turn-a',
            channelRequestId: 'req-1',
            runtimeId: 'runtime-1',
        });
        expect(handler.channelBindingFor('tool-call-1')).toBeUndefined();

        // The second raising's own item still binds it.
        await queue.flush();
        expect(handler.channelBindingFor('tool-call-1')).toMatchObject({ turnId: 'turn-a' });
        await stub.answer({ id: 'tool-call-1', approved: false });
        await expect(second).resolves.toMatchObject({ behavior: 'deny' });
    });
});

describe('the dedicated channel-permission RPC method', () => {
    const CLAIM = { turnId: 'turn-a', channelRequestId: 'req-1', runtimeId: 'runtime-1' };

    function wire(stub: ReturnType<typeof createRecordingSessionStub>) {
        const handler = new PermissionHandler(stub.session);
        let bind: (permissionId: string, toolName: string, instanceSeq: number) => void = () => { };
        const queue = new OutgoingMessageQueue(createOrderedTurnDispatcher({
            setPendingTurnRequestId: () => { },
            sendFinalAnswerForChannelTurn: () => { },
            closeClaudeSessionTurn: () => { },
            sendClaudeSessionMessage: () => { },
            bindChannelPermission: (permissionId, tool, seq) => bind(permissionId, tool, seq),
        }));
        bind = installChannelPermissionWiring({
            queue,
            handler,
            turnContextFor: (_toolCallId, apply) =>
                apply({ turnId: 'turn-a', channelRequestId: 'req-1', runtimeId: 'runtime-1' }),
            publish: () => { },
        });
        const decided = handler.handleToolCall(
            'Bash', { command: 'ls' }, { permissionMode: 'default' },
            { signal: new AbortController().signal, toolUseID: 'tool-call-1' },
        );
        return { handler, decided, queue };
    }

    it('is registered under its own name alongside the ordinary method', () => {
        // A runtime that predates this registers only `permission`, so the dedicated call fails
        // and the caller fails closed. That is the whole mechanism.
        const stub = createRecordingSessionStub();
        new PermissionHandler(stub.session);
        expect(stub.registeredMethods()).toEqual(['channel-permission', 'permission']);
        expect(PermissionHandler.CHANNEL_PERMISSION_METHOD).toBe('channel-permission');
    });

    it('applies an answer that reproduces the whole claim', async () => {
        const stub = createRecordingSessionStub();
        const { decided, queue } = wire(stub);
        await queue.flush();
        expect(await stub.answerChannel({ id: 'tool-call-1', approved: true, channelClaim: CLAIM }))
            .toEqual({ applied: true });
        await expect(decided).resolves.toMatchObject({ behavior: 'allow' });
    });

    it('refuses an answer with no claim at all, instead of reading it as an ordinary one', async () => {
        // The old-runtime hole, closed: absence of a claim on *this* method is a refusal, where on
        // `permission` it means "an ordinary Desktop answer".
        const stub = createRecordingSessionStub();
        const { decided, queue } = wire(stub);
        await queue.flush();
        expect(await stub.answerChannel({ id: 'tool-call-1', approved: true }))
            .toEqual({ applied: false, reason: 'unknown-request' });
        // Untouched: the Desktop user can still answer it.
        expect(await stub.answer({ id: 'tool-call-1', approved: false })).toEqual({ applied: true });
        await expect(decided).resolves.toMatchObject({ behavior: 'deny' });
    });

    it('refuses a malformed or partial claim', async () => {
        for (const claim of [
            {},
            { turnId: 'turn-a' },
            { turnId: 'turn-a', channelRequestId: 'req-1' },
            { turnId: 'turn-a', channelRequestId: 'req-1', runtimeId: 42 },
            { ...CLAIM, turnId: 'turn-other' },
            { ...CLAIM, runtimeId: 'runtime-other' },
            { ...CLAIM, channelRequestId: 'req-other' },
        ]) {
            const stub = createRecordingSessionStub();
            const { decided, queue } = wire(stub);
            await queue.flush();
            expect(
                await stub.answerChannel({ id: 'tool-call-1', approved: true, channelClaim: claim }),
                JSON.stringify(claim),
            ).toEqual({ applied: false, reason: 'unknown-request' });
            await stub.answer({ id: 'tool-call-1', approved: false });
            await decided;
        }
    });

    it('refuses a malformed decision without burning the pending request', async () => {
        // Coercing to `approved === true` would consume the prompt as a *denial* on a message
        // that was never a valid answer, deciding it for the Desktop user.
        for (const decision of [
            {},
            { approved: 'true' },
            { approved: 'false' },
            { approved: null },
            { approved: 1 },
            { approved: 0 },
        ]) {
            const stub = createRecordingSessionStub();
            const { decided, queue } = wire(stub);
            await queue.flush();
            expect(
                await stub.answerChannel({ id: 'tool-call-1', channelClaim: CLAIM, ...decision }),
                JSON.stringify(decision),
            ).toEqual({ applied: false, reason: 'unknown-request' });

            // Still pending, and a valid answer afterwards still lands on the same prompt.
            expect(
                await stub.answerChannel({ id: 'tool-call-1', approved: true, channelClaim: CLAIM }),
                JSON.stringify(decision),
            ).toEqual({ applied: true });
            await expect(decided).resolves.toMatchObject({ behavior: 'allow' });
        }
    });

    it('accepts an explicit false as a denial', async () => {
        const stub = createRecordingSessionStub();
        const { decided, queue } = wire(stub);
        await queue.flush();
        expect(await stub.answerChannel({ id: 'tool-call-1', approved: false, channelClaim: CLAIM }))
            .toEqual({ applied: true });
        await expect(decided).resolves.toMatchObject({ behavior: 'deny' });
    });

    it('refuses an answer carrying a persistent grant or a mode change', async () => {
        for (const extra of [
            { allowTools: ['Bash'] },
            { mode: 'bypassPermissions' },
            { updatedInput: { command: 'rm -rf /' } },
            { decision: 'approved_for_session' },
        ]) {
            const stub = createRecordingSessionStub();
            const { decided, queue } = wire(stub);
            await queue.flush();
            expect(
                await stub.answerChannel({
                    id: 'tool-call-1', approved: true, channelClaim: CLAIM, ...extra,
                }),
                JSON.stringify(extra),
            ).toEqual({ applied: false, reason: 'unknown-request' });
            await stub.answer({ id: 'tool-call-1', approved: false });
            await decided;
        }
    });

    it('applies a binary decision only, never a mode or an allowlist', async () => {
        const stub = createRecordingSessionStub();
        const { handler, decided, queue } = wire(stub);
        await queue.flush();
        await stub.answerChannel({ id: 'tool-call-1', approved: true, channelClaim: CLAIM });
        await decided;
        // Nothing persistent was recorded from the answer.
        const stored = handler.getResponses().get('tool-call-1');
        expect(stored?.mode).toBeUndefined();
        expect(stored?.allowTools).toBeUndefined();
        expect(stored?.updatedInput).toBeUndefined();
        expect(stored?.approved).toBe(true);
    });

    it('shares the pending consume, so only one of two racing answers wins', async () => {
        const stub = createRecordingSessionStub();
        const { decided, queue } = wire(stub);
        await queue.flush();
        const [channelAck, desktopAck] = await Promise.all([
            stub.answerChannel({ id: 'tool-call-1', approved: true, channelClaim: CLAIM }),
            stub.answer({ id: 'tool-call-1', approved: false }),
        ]);
        expect([channelAck.applied, desktopAck.applied].filter(Boolean)).toHaveLength(1);
        await decided;
    });

    it('reports an unknown or already-answered request the same way the ordinary method does', async () => {
        const stub = createRecordingSessionStub();
        const { decided, queue } = wire(stub);
        await queue.flush();
        expect(await stub.answerChannel({ id: 'other-id', approved: true, channelClaim: CLAIM }))
            .toEqual({ applied: false, reason: 'unknown-request' });
        await stub.answerChannel({ id: 'tool-call-1', approved: true, channelClaim: CLAIM });
        await decided;
        expect(await stub.answerChannel({ id: 'tool-call-1', approved: true, channelClaim: CLAIM }))
            .toEqual({ applied: false, reason: 'already-answered' });
    });
});

describe('the ordinary permission method stays compatible', () => {
    it('applies a plain Desktop answer with no claim', async () => {
        const stub = createRecordingSessionStub();
        const handler = new PermissionHandler(stub.session);
        const decided = handler.handleToolCall(
            'Bash', { command: 'ls' }, { permissionMode: 'default' },
            { signal: new AbortController().signal, toolUseID: 'tool-call-1' },
        );
        expect(await stub.answer({ id: 'tool-call-1', approved: true })).toEqual({ applied: true });
        await expect(decided).resolves.toMatchObject({ behavior: 'allow' });
    });

    it('still honours a persistent grant from Desktop, which the channel method refuses', async () => {
        // The asymmetry is deliberate: the Desktop user may widen their own session.
        const stub = createRecordingSessionStub();
        const handler = new PermissionHandler(stub.session);
        const decided = handler.handleToolCall(
            'Bash', { command: 'ls' }, { permissionMode: 'default' },
            { signal: new AbortController().signal, toolUseID: 'tool-call-1' },
        );
        expect(await stub.answer({ id: 'tool-call-1', approved: true, allowTools: ['Bash'] }))
            .toEqual({ applied: true });
        await decided;
        expect(handler.getResponses().get('tool-call-1')?.allowTools).toEqual(['Bash']);
    });
});

describe('a non-binary prompt is observed as guidance but never answerable', () => {
    const CLAIM = { turnId: 'turn-a', channelRequestId: 'req-1', runtimeId: 'runtime-1' };

    /**
     * The **production** path: the real ordered dispatcher, the real outgoing queue, and
     * `installChannelPermissionWiring` — the same function the Claude launcher calls. The binding
     * is applied from the queue, so the prompt is not bound until it drains.
     */
    function raise(
        stub: ReturnType<typeof createRecordingSessionStub>,
        toolName: string,
        turn: { turnId: string | null; channelRequestId: string | null } = {
            turnId: 'turn-a', channelRequestId: 'req-1',
        },
    ) {
        const handler = new PermissionHandler(stub.session);
        const published: SessionEvent[] = [];
        let bind: (permissionId: string, toolName: string, instanceSeq: number) => void = () => { };
        const queue = new OutgoingMessageQueue(createOrderedTurnDispatcher({
            setPendingTurnRequestId: () => { },
            sendFinalAnswerForChannelTurn: () => { },
            closeClaudeSessionTurn: () => { },
            sendClaudeSessionMessage: () => { },
            bindChannelPermission: (permissionId, tool, seq) => bind(permissionId, tool, seq),
        }));
        bind = installChannelPermissionWiring({
            queue,
            handler,
            turnContextFor: (_toolCallId, apply) => {
                if (turn.turnId === null) return;
                apply({ turnId: turn.turnId, channelRequestId: turn.channelRequestId, runtimeId: 'runtime-1' });
            },
            publish: (event) => { published.push(event); },
        });
        const decided = handler.handleToolCall(
            toolName, { question: 'which one?' }, { permissionMode: 'default' }, stubOptions(),
        );
        return { handler, decided, published, bound: queue.flush() };
    }

    const kinds = (published: SessionEvent[]) => published.map((event) => ({
        t: (event as { t: string }).t,
        kind: (event as unknown as { kind?: string }).kind,
    }));

    it('publishes AskUserQuestion as desktop-only guidance instead of nothing at all', async () => {
        // Before this, `buildChannelApprovalObservation` returned null for every non-binary tool,
        // so an externally-started turn that hit this prompt said nothing and appeared to stall.
        const stub = createRecordingSessionStub();
        const { published, bound } = raise(stub, 'AskUserQuestion');
        await bound;
        expect(kinds(published)).toEqual([{ t: 'channel-permission', kind: 'desktop-only' }]);
    });

    it('publishes ExitPlanMode and the other non-binary tools the same way', async () => {
        for (const tool of ['ExitPlanMode', 'RequestUserInput', 'ProjectFilesystemScope',
            'mcp__anything__AskUserQuestion', 'functions.ExitPlanMode', 'exit_plan_mode']) {
            const stub = createRecordingSessionStub();
            const { published, bound } = raise(stub, tool);
            await bound;
            expect(kinds(published), tool).toEqual([{ t: 'channel-permission', kind: 'desktop-only' }]);
        }
    });

    it('still publishes an ordinary tool as generic', async () => {
        const stub = createRecordingSessionStub();
        const { published, bound } = raise(stub, 'Bash');
        await bound;
        expect(kinds(published)).toEqual([{ t: 'channel-permission', kind: 'generic' }]);
    });

    it('refuses the dedicated RPC for a waiting non-binary prompt, and leaves it pending', async () => {
        const stub = createRecordingSessionStub();
        const { decided, bound } = raise(stub, 'AskUserQuestion');
        await bound;
        expect(await stub.answerChannel({ id: 'tool-call-1', approved: true, channelClaim: CLAIM }))
            .toEqual({ applied: false, reason: 'unknown-request' });
        // Untouched: the Desktop user can still answer the prompt they are looking at.
        expect(await stub.answer({ id: 'tool-call-1', approved: true })).toEqual({ applied: true });
        await expect(decided).resolves.toMatchObject({ behavior: 'allow' });
    });

    it('withdraws the guidance when the Desktop user answers it', async () => {
        // R8's terminal state for a wait that was published: the messenger must learn it is over.
        const stub = createRecordingSessionStub();
        const { decided, published, bound } = raise(stub, 'AskUserQuestion');
        await bound;
        await stub.answer({ id: 'tool-call-1', approved: true });
        await decided;
        expect(kinds(published)).toEqual([
            { t: 'channel-permission', kind: 'desktop-only' },
            { t: 'channel-permission-withdrawn', kind: undefined },
        ]);
    });

    it('publishes nothing for a Desktop-originated non-binary prompt', async () => {
        // No external request: this prompt is the Desktop user's, and pointing a messenger at it
        // would invite a hand-off instruction aimed at someone who is not looking at it.
        const stub = createRecordingSessionStub();
        const { decided, published, bound } = raise(
            stub, 'AskUserQuestion', { turnId: 'turn-a', channelRequestId: null },
        );
        await bound;
        expect(published).toEqual([]);
        await stub.answer({ id: 'tool-call-1', approved: true });
        await decided;
        expect(published).toEqual([]);
    });

    it('publishes nothing for a tool Core cannot name', async () => {
        const stub = createRecordingSessionStub();
        const handler = new PermissionHandler(stub.session);
        const published: SessionEvent[] = [];
        let bind: (permissionId: string, toolName: string, instanceSeq: number) => void = () => { };
        const queue = new OutgoingMessageQueue(createOrderedTurnDispatcher({
            setPendingTurnRequestId: () => { },
            sendFinalAnswerForChannelTurn: () => { },
            closeClaudeSessionTurn: () => { },
            sendClaudeSessionMessage: () => { },
            bindChannelPermission: (permissionId, tool, seq) => bind(permissionId, tool, seq),
        }));
        bind = installChannelPermissionWiring({
            queue,
            handler,
            turnContextFor: (_id, apply) =>
                apply({ turnId: 'turn-a', channelRequestId: 'req-1', runtimeId: 'runtime-1' }),
            publish: (event) => { published.push(event); },
        });
        // `handleToolCall` is typed for a string, so the unnameable case is forced through the
        // binding entry point the queue uses.
        handler.bindChannelPermission({
            permissionId: 'tool-call-1', toolName: '   ', instanceSeq: 1,
            turnId: 'turn-a', channelRequestId: 'req-1', runtimeId: 'runtime-1',
        });
        await queue.flush();
        expect(published).toEqual([]);
        expect(handler.channelBindingFor('tool-call-1')).toBeUndefined();
    });
});
