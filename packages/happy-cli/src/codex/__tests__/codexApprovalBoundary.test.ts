/**
 * The approval boundary driven the way the provider drives it: a real app-server request line into
 * a real `CodexAppServerClient`, through the boundary the real run installs, into a real
 * `CodexPermissionHandler` (specs/desktop-messenger-channels — R8/R9).
 *
 * Nothing here calls the channel publisher, resolves a turn, or reproduces the run's callback. The
 * defect this file exists for was invisible to every test that did: guidance published from the
 * call site *before* the pending request existed was dropped in production, while handler-level
 * tests that published after it passed.
 */

import { describe, expect, it, vi } from 'vitest';

import { CodexAppServerClient } from '../codexAppServerClient';
import { CodexPermissionHandler } from '../utils/permissionHandler';
import { installCodexApprovalBoundary } from '../utils/codexApprovalBoundary';

vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debugLargeJson: vi.fn() },
}));

const RUN_THREAD = 'thread-run';
const PROVIDER_TURN = 'prov-turn-1';
const PROTOCOL_TURN = 'turn-a';
const REQUEST_ID = 'req-1';

function createBoundary(options: {
    threadId?: string | null;
    /** The mapper state as of the request — open protocol turn and native→protocol map. */
    currentTurnId?: string | null;
    providerTurnToProtocol?: Map<string, string>;
    throwOnSend?: boolean;
    autoApprove?: boolean;
} = {}) {
    const published: any[] = [];
    const written: string[] = [];
    let state: Record<string, any> = {};
    let answer: ((response: unknown) => Promise<unknown>) | null = null;

    const session = {
        runtimeId: 'runtime-1',
        rpcHandlerManager: {
            registerHandler: vi.fn((name: string, fn: (response: unknown) => Promise<unknown>) => {
                if (name === 'permission') answer = fn;
            }),
        },
        updateAgentState: vi.fn((updater: (s: Record<string, any>) => Record<string, any>) => {
            state = updater(state);
            return state;
        }),
        sendSessionProtocolMessage: vi.fn((envelope: any) => {
            if (options.throwOnSend) throw new Error('transport exploded: raw provider detail');
            published.push(envelope);
        }),
    };

    const client = new CodexAppServerClient();
    // The thread this run adopted, and a stdin to answer on: the only two things a live process
    // would have supplied. `respond` itself stays real, so the decision is observed as the
    // provider observes it.
    (client as any)._threadId = options.threadId === undefined ? RUN_THREAD : options.threadId;
    (client as any).process = {
        stdin: { writable: true, write: (chunk: string) => { written.push(chunk); return true; } },
    };

    const permissionHandler = new CodexPermissionHandler(session as any);
    installCodexApprovalBoundary({
        client: client as any,
        permissionHandler,
        runtimeId: session.runtimeId,
        turnState: () => ({
            currentTurnId: options.currentTurnId === undefined ? PROTOCOL_TURN : options.currentTurnId,
            currentRequestId: REQUEST_ID,
            providerTurnToProtocol: options.providerTurnToProtocol
                ?? new Map([[PROVIDER_TURN, PROTOCOL_TURN]]),
        }),
        isAutoApproved: () => options.autoApprove === true,
    });

    /**
     * Exactly what the app server writes on its stdout for an exec approval. Decisions are read
     * back in the v2 wire spelling the provider actually receives (`accept`/`decline`).
     */
    const requestApproval = async (params: Record<string, unknown>) => {
        (client as any).handleLine(JSON.stringify({
            jsonrpc: '2.0',
            id: 7,
            method: 'item/commandExecution/requestApproval',
            params: { itemId: 'call_exec_1', command: ['ls'], ...params },
        }));
        // handleLine dispatches the request without awaiting it, as the readline callback does.
        await Promise.resolve();
        await Promise.resolve();
    };

    return {
        requestApproval,
        events: () => published.map((envelope) => envelope.ev),
        decisions: () => written.map((line) => JSON.parse(line).result?.decision),
        pending: () => state.requests ?? {},
        completed: () => state.completedRequests ?? {},
        answer: async (approved: boolean) => {
            if (!answer) throw new Error('permission RPC handler was never registered');
            await answer({ id: 'call_exec_1', approved });
            // The boundary resumes and responds on later microtasks, as it does in the real run.
            for (let hop = 0; hop < 4; hop += 1) await Promise.resolve();
        },
    };
}

/** A request that names its own turn and this run's thread — the supported case. */
const OWNED = { turn: { id: PROVIDER_TURN }, thread: { id: RUN_THREAD } };

describe('Codex approval boundary', () => {
    it('publishes the wait for a real approval request, before it is answered', async () => {
        const boundary = createBoundary();
        await boundary.requestApproval(OWNED);
        // Published from the request itself, with the prompt already pending.
        expect(boundary.events()).toEqual([{
            t: 'channel-permission',
            permissionId: 'call_exec_1',
            turnId: PROTOCOL_TURN,
            channelRequestId: REQUEST_ID,
            runtimeId: 'runtime-1',
            kind: 'desktop-only',
            createdAt: expect.any(Number),
        }]);
        expect(boundary.pending().call_exec_1).toMatchObject({ tool: 'CodexBash' });
        await boundary.answer(true);
        expect(boundary.decisions()).toEqual(['accept']);
        expect(boundary.events().map((event: any) => event.t))
            .toEqual(['channel-permission', 'channel-permission-withdrawn']);
    });

    it('publishes nothing for another thread carrying the same turn id', async () => {
        // Provider turn ids are unique within a thread, not across them. Attributing this would
        // announce another conversation's wait on this session's messenger thread.
        const boundary = createBoundary();
        await boundary.requestApproval({ turn: { id: PROVIDER_TURN }, thread: { id: 'thread-other' } });
        expect(boundary.events()).toEqual([]);
        await boundary.answer(true);
        expect(boundary.decisions()).toEqual(['accept']);
        expect(boundary.events()).toEqual([]);
    });

    it('publishes nothing when the request names no thread', async () => {
        const boundary = createBoundary();
        await boundary.requestApproval({ turn: { id: PROVIDER_TURN } });
        expect(boundary.events()).toEqual([]);
        await boundary.answer(true);
        expect(boundary.decisions()).toEqual(['accept']);
    });

    it('publishes nothing when the request names no turn', async () => {
        const boundary = createBoundary();
        await boundary.requestApproval({ thread: { id: RUN_THREAD } });
        expect(boundary.events()).toEqual([]);
        await boundary.answer(true);
        expect(boundary.decisions()).toEqual(['accept']);
    });

    it('publishes nothing when this run has adopted no thread of its own', async () => {
        const boundary = createBoundary({ threadId: null });
        await boundary.requestApproval(OWNED);
        expect(boundary.events()).toEqual([]);
    });

    it('does not fall back to the open turn for an unknown provider turn', async () => {
        // A turn is open, and it is not this request's. Silence, not the open one.
        const boundary = createBoundary({ providerTurnToProtocol: new Map() });
        await boundary.requestApproval({ turn: { id: 'prov-turn-unknown' }, thread: { id: RUN_THREAD } });
        expect(boundary.events()).toEqual([]);
    });

    it('publishes nothing once the protocol turn has closed', async () => {
        const boundary = createBoundary({ currentTurnId: 'turn-b' });
        await boundary.requestApproval(OWNED);
        expect(boundary.events()).toEqual([]);
    });

    it('asks and answers normally when the first publish throws', async () => {
        const boundary = createBoundary({ throwOnSend: true });
        await boundary.requestApproval(OWNED);
        expect(boundary.pending().call_exec_1).toMatchObject({ tool: 'CodexBash' });
        await boundary.answer(true);
        expect(boundary.decisions()).toEqual(['accept']);
        expect(boundary.completed().call_exec_1).toMatchObject({ status: 'approved' });
    });

    it('carries a denial through unchanged', async () => {
        // `cancel` is what this handler has always returned for a denied Codex approval
        // (`abort` on the wire v2 spelling). Recorded here so a change to the decision path shows
        // up as a change to the provider's answer, not only to guidance.
        const boundary = createBoundary();
        await boundary.requestApproval(OWNED);
        await boundary.answer(false);
        expect(boundary.decisions()).toEqual(['cancel']);
    });

    it('asks nobody, and says nothing, for a call this run auto-approves', async () => {
        const boundary = createBoundary({ autoApprove: true });
        await boundary.requestApproval(OWNED);
        expect(boundary.decisions()).toEqual(['accept']);
        expect(boundary.events()).toEqual([]);
        expect(boundary.pending()).toEqual({});
    });
});
