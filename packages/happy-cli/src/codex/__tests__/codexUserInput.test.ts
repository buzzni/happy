import { describe, expect, it, vi } from 'vitest';
import { CodexAppServerClient } from '../codexAppServerClient';
import { CodexPermissionHandler } from '../utils/permissionHandler';
import { installCodexUserInputBoundary } from '../utils/codexUserInput';

vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

const questions = [
    { id: 'first', header: '첫 작업', question: '진행할까요?', isOther: true, isSecret: false, options: [{ label: '진행', description: '시작합니다' }] },
    { id: 'second', header: '두 번째', question: '진행할까요?', isOther: true, isSecret: false, options: null },
];

function boundary() {
    let state: any = {};
    let permission!: (input: any) => Promise<unknown>;
    const writes: any[] = [];
    const events: any[] = [];
    const session = {
        sendSessionProtocolMessage: (envelope: any) => { events.push(envelope); },
        rpcHandlerManager: { registerHandler: (name: string, handler: typeof permission) => { if (name === 'permission') permission = handler; } },
        updateAgentState: (update: (value: any) => any) => { state = update(state); },
    };
    const client = new CodexAppServerClient();
    (client as any)._threadId = 'thread';
    (client as any).process = { stdin: { writable: true, write: (line: string) => { const { jsonrpc, ...message } = JSON.parse(line); writes.push(message); return true; } } };
    const permissions = new CodexPermissionHandler(session as any);
    installCodexUserInputBoundary({ client, permissionHandler: permissions, session: session as any, protocolTurnId: () => 'protocol-turn' });
    const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
    return {
        client, permissions, writes, events, flush,
        state: () => state,
        pending: () => Object.keys(state.requests ?? {}),
        send: async (method: string, params: any, id?: number | string) => {
            (client as any).handleLine(JSON.stringify({ ...(id !== undefined ? { id } : {}), method, params }));
            await flush();
        },
        answer: async (id: string, updatedInput: unknown, approved = true) => { await permission({ id, approved, updatedInput }); await flush(); },
    };
}

const params = { threadId: 'thread', turnId: 'turn', itemId: 'item', questions };

describe('Codex structured user input boundary', () => {
    it('waits for Desktop and returns answers by question ID on the original JSON-RPC request', async () => {
        const b = boundary();
        await b.send('item/tool/requestUserInput', params, 101);
        try {
            expect(b.pending()).toHaveLength(1);
            expect(b.writes).toEqual([]);
            const id = b.pending()[0];
            expect(b.state().requests[id]).toMatchObject({ tool: 'request_user_input', arguments: { questions: [
                { answerKey: 'first', header: '첫 작업', question: '진행할까요?' },
                { answerKey: 'second', header: '두 번째', question: '진행할까요?' },
            ] } });
            await b.answer(id, { answers: { first: '진행', second: '직접, 입력한 답변' } });
            expect(b.writes).toEqual([{ id: 101, result: { answers: { first: { answers: ['진행'] }, second: { answers: ['직접, 입력한 답변'] } } } }]);
            expect(b.pending()).toEqual([]);
            expect(b.events.map(event => event.ev.t)).toEqual(['tool-call-start', 'tool-call-end']);
            expect(b.events.every(event => event.turn === 'protocol-turn')).toBe(true);
        } finally { b.permissions.abortAll(); await b.flush(); }
    });

    it('cancels only the request resolved by the provider and ignores a late Desktop answer', async () => {
        const b = boundary();
        await b.send('item/tool/requestUserInput', params, 'first-request');
        await b.send('item/tool/requestUserInput', { ...params, itemId: 'second-item' }, 'second-request');
        try {
            expect(b.pending()).toHaveLength(2);
            const [first, second] = b.pending();
            await b.send('serverRequest/resolved', { threadId: 'foreign', requestId: 'first-request' });
            expect(b.pending()).toEqual([first, second]);
            await b.send('serverRequest/resolved', { threadId: 'thread', requestId: 'first-request' });
            expect(b.pending()).toEqual([second]);
            await b.answer(first, { answers: { first: 'stale' } });
            expect(b.writes).toEqual([]);
            b.permissions.abortAll(); await b.flush();
            expect(b.writes).toEqual([{ id: 'second-request', result: { answers: {} } }]);
        } finally { b.permissions.abortAll(); await b.flush(); }
    });

    it.each([
        { ...params, threadId: 'foreign' },
        { ...params, questions: [] },
        { ...params, questions: [questions[0], questions[0]] },
        { ...params, questions: [{ ...questions[0], isSecret: true }] },
        { ...params, questions: [{ ...questions[0], options: [{ label: 123 }] }] },
    ])('declines malformed, foreign and unsupported secret prompts without creating a pending request', async input => {
        const b = boundary();
        await b.send('item/tool/requestUserInput', input, 102);
        expect(b.pending()).toEqual([]);
        expect(b.writes).toEqual([{ id: 102, result: { answers: {} } }]);
    });

    it.each([undefined, { answers: { first: 'only-one' } }, { answers: { first: 123, second: 'valid' } }])('never treats a plain or incomplete tool approval as answers', async input => {
        const b = boundary(); await b.send('item/tool/requestUserInput', params, 103);
        try {
            expect(b.pending()).toHaveLength(1);
            await b.answer(b.pending()[0], input);
            expect(b.writes).toEqual([{ id: 103, result: { answers: {} } }]);
        } finally { b.permissions.abortAll(); await b.flush(); }
    });


    it('removes pending questions on native turn completion without replying to a resolved request', async () => {
        const b = boundary(); await b.send('item/tool/requestUserInput', params, 105);
        try {
            expect(b.pending()).toHaveLength(1);
            await b.send('turn/completed', { threadId: 'foreign', turn: { id: 'turn', status: 'completed' } });
            expect(b.pending()).toHaveLength(1);
            await b.send('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed' } });
            expect(b.pending()).toEqual([]);
            expect(b.writes).toEqual([]);
            expect(b.events.map(event => event.ev.t)).toEqual(['tool-call-start', 'tool-call-end']);
        } finally { b.permissions.abortAll(); await b.flush(); }
    });

    it('uses fresh permission IDs after a process generation changes and drops old answers', async () => {
        const b = boundary(); await b.send('item/tool/requestUserInput', params, 106);
        try {
            const first = b.pending()[0]; expect(first).toBeTruthy();
            (b.client as any).processEpoch++;
            (b.client as any).cancelUserInputRequests(); await b.flush();
            await b.send('item/tool/requestUserInput', params, 106);
            const second = b.pending()[0]; expect(second).toBeTruthy(); expect(second).not.toBe(first);
            await b.answer(first, { answers: { first: 'stale', second: 'stale' } });
            expect(b.pending()).toEqual([second]); expect(b.writes).toEqual([]);
            await b.answer(second, { answers: { first: 'fresh', second: 'fresh' } });
            expect(b.writes).toHaveLength(1);
        } finally { b.permissions.abortAll(); await b.flush(); }
    });

    it('unblocks a provider when reset rejects its pending question', async () => {
        const b = boundary(); await b.send('item/tool/requestUserInput', params, 104);
        try {
            expect(b.pending()).toHaveLength(1);
            b.permissions.reset(); await b.flush();
            expect(b.pending()).toEqual([]);
            expect(b.writes).toEqual([{ id: 104, result: { answers: {} } }]);
        } finally { b.permissions.abortAll(); await b.flush(); }
    });
});
