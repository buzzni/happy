/** specs/desktop-next-steps-card (Saycode Desktop) — next_steps / update_plan tool contracts. */
import { describe, expect, it, vi } from 'vitest';
import { sessionEnvelopeSchema } from '@slopus/happy-wire';
import { startHappyServer } from './startHappyServer';
import type { ApiSessionClient } from '@/api/apiSession';

vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), debugLargeJson: vi.fn() } }));

function fakeClient() {
    return {
        sessionId: 'test',
        hasTitle: vi.fn(() => true),
        sendClaudeSessionMessage: vi.fn(),
        sendSessionProtocolMessage: vi.fn(),
        updateMetadata: vi.fn(),
        getMetadata: vi.fn(() => ({})),
    } as unknown as ApiSessionClient & { sendSessionProtocolMessage: ReturnType<typeof vi.fn> };
}

async function rpc(url: string, method: string, params: Record<string, unknown>) {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const raw = await response.text();
    return JSON.parse(raw.startsWith('event:') ? raw.slice(raw.indexOf('data: ') + 6) : raw);
}

const callTool = (url: string, name: string, args: Record<string, unknown>) => rpc(url, 'tools/call', { name, arguments: args });
const listNames = async (url: string): Promise<string[]> => (await rpc(url, 'tools/list', {})).result.tools.map((tool: { name: string }) => tool.name);

describe('next_steps tool', () => {
    it('records the card as an agent session event a client can parse', async () => {
        const client = fakeClient();
        const server = await startHappyServer(client, { turnCards: 'claude' });
        try {
            const reply = await callTool(server.url, 'next_steps', {
                summary: 'The parser fix is in and its tests pass. Nothing is committed.',
                question: 'Commit it now?',
                actions: [{ kind: 'commit' }, { label: 'Not yet', message: 'Leave it uncommitted for now.' }],
            });
            expect(reply.result.isError).toBeFalsy();
            expect(reply.result.content[0].text).toMatch(/^Shown/);
            expect(client.sendSessionProtocolMessage).toHaveBeenCalledTimes(1);
            const envelope = client.sendSessionProtocolMessage.mock.calls[0][0];
            expect(sessionEnvelopeSchema.safeParse(envelope).success).toBe(true);
            expect(envelope.role).toBe('agent');
            expect(envelope.ev).toEqual({
                t: 'next-steps',
                summary: 'The parser fix is in and its tests pass. Nothing is committed.',
                question: 'Commit it now?',
                actions: [{ kind: 'commit' }, { label: 'Not yet', message: 'Leave it uncommitted for now.' }],
            });
        } finally { server.stop(); }
    });

    it('rejects an action outside the app action list with the list in the reason', async () => {
        const client = fakeClient();
        const server = await startHappyServer(client, { turnCards: 'codex' });
        try {
            const reply = await callTool(server.url, 'next_steps', { summary: 'Done.', question: 'Ship?', actions: [{ kind: 'deploy' }] });
            expect(reply.result?.isError ?? !!reply.error).toBe(true);
            expect(JSON.stringify(reply)).toMatch(/commit/);
            expect(client.sendSessionProtocolMessage).not.toHaveBeenCalled();
        } finally { server.stop(); }
    });

    it('rejects a question with no button to answer it, and a repeated app action', async () => {
        const client = fakeClient();
        const server = await startHappyServer(client, { turnCards: 'claude' });
        try {
            const unanswerable = await callTool(server.url, 'next_steps', { summary: 'Done.', question: 'Which one?', actions: [] });
            expect(unanswerable.result.isError).toBe(true);
            expect(unanswerable.result.content[0].text).toMatch(/NEXT_STEPS_QUESTION_WITHOUT_ACTIONS/);
            const repeated = await callTool(server.url, 'next_steps', { summary: 'Done.', question: 'Merge?', actions: [{ kind: 'merge' }, { kind: 'merge', label: 'Merge now' }] });
            expect(repeated.result.isError).toBe(true);
            expect(repeated.result.content[0].text).toMatch(/NEXT_STEPS_DUPLICATE_ACTION/);
            expect(client.sendSessionProtocolMessage).not.toHaveBeenCalled();
        } finally { server.stop(); }
    });

    it('accepts a recap with no question and no buttons', async () => {
        const client = fakeClient();
        const server = await startHappyServer(client, { turnCards: 'claude' });
        try {
            const reply = await callTool(server.url, 'next_steps', { summary: 'Answered the question; nothing changed.', actions: [] });
            expect(reply.result.isError).toBeFalsy();
            expect(client.sendSessionProtocolMessage.mock.calls[0][0].ev).toEqual({ t: 'next-steps', summary: 'Answered the question; nothing changed.', actions: [] });
        } finally { server.stop(); }
    });

    it('refuses on a runner whose client does not draw the card (ACP)', async () => {
        const client = fakeClient();
        const server = await startHappyServer(client);
        try {
            const reply = await callTool(server.url, 'next_steps', { summary: 'Done.', actions: [] });
            expect(reply.result.isError).toBe(true);
            expect(reply.result.content[0].text).toMatch(/NEXT_STEPS_UNSUPPORTED/);
            expect(client.sendSessionProtocolMessage).not.toHaveBeenCalled();
        } finally { server.stop(); }
    });
});

describe('update_plan tool', () => {
    it('records the whole list as a plan event on Codex', async () => {
        const client = fakeClient();
        const server = await startHappyServer(client, { turnCards: 'codex' });
        try {
            expect(server.toolNames).toEqual(expect.arrayContaining(['next_steps', 'update_plan']));
            const steps = [{ text: 'Reproduce the bug', status: 'completed' }, { text: 'Fix the parser', status: 'in_progress' }, { text: 'Run the tests', status: 'pending' }];
            const reply = await callTool(server.url, 'update_plan', { scope: 'first_task', steps });
            expect(reply.result.isError).toBeFalsy();
            const envelope = client.sendSessionProtocolMessage.mock.calls[0][0];
            expect(sessionEnvelopeSchema.safeParse(envelope).success).toBe(true);
            expect(envelope.ev).toEqual({ t: 'plan', scope: 'first_task', steps });
        } finally { server.stop(); }
    });

    it('is not offered to Claude, whose TodoWrite list the app already shows', async () => {
        const server = await startHappyServer(fakeClient(), { turnCards: 'claude' });
        try {
            expect(server.toolNames).toContain('next_steps');
            expect(server.toolNames).not.toContain('update_plan');
            const names = await listNames(server.url);
            expect(names).toContain('next_steps');
            expect(names).not.toContain('update_plan');
        } finally { server.stop(); }
    });

    it('refuses on a runner whose client does not draw the list (ACP)', async () => {
        const client = fakeClient();
        const server = await startHappyServer(client);
        try {
            const reply = await callTool(server.url, 'update_plan', { scope: 'new_task', steps: [{ text: 'x', status: 'pending' }] });
            expect(reply.result.isError).toBe(true);
            expect(reply.result.content[0].text).toMatch(/PLAN_UNSUPPORTED/);
            expect(client.sendSessionProtocolMessage).not.toHaveBeenCalled();
        } finally { server.stop(); }
    });
});
