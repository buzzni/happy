/** specs/desktop-next-steps-card (Saycode Desktop) — next_steps tool contract. */
import { describe, expect, it, vi } from 'vitest';
import { sessionEnvelopeSchema } from '@slopus/happy-wire';
import { startHappyServer } from './startHappyServer';
import { createTurnCardSwitch, type TurnCardRunner } from './turnCardTools';
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
/** A turn whose client said it draws the card. */
const drawnTurn = (runner: TurnCardRunner) => { const cards = createTurnCardSwitch(runner); cards.set(true); return cards; };
const listNames = async (url: string): Promise<string[]> => (await rpc(url, 'tools/list', {})).result.tools.map((tool: { name: string }) => tool.name);

describe('next_steps tool', () => {
    it('records the card as an agent session event a client can parse', async () => {
        const client = fakeClient();
        const server = await startHappyServer(client, { turnCards: drawnTurn('claude') });
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
        const server = await startHappyServer(client, { turnCards: drawnTurn('codex') });
        try {
            const reply = await callTool(server.url, 'next_steps', { summary: 'Done.', question: 'Ship?', actions: [{ kind: 'deploy' }] });
            expect(reply.result?.isError ?? !!reply.error).toBe(true);
            expect(JSON.stringify(reply)).toMatch(/commit/);
            expect(client.sendSessionProtocolMessage).not.toHaveBeenCalled();
        } finally { server.stop(); }
    });

    it('rejects a question with no button to answer it, and a repeated app action', async () => {
        const client = fakeClient();
        const server = await startHappyServer(client, { turnCards: drawnTurn('claude') });
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
        const server = await startHappyServer(client, { turnCards: drawnTurn('claude') });
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

describe('next_steps on a turn whose client does not draw the card', () => {
    // An older Desktop, the mobile app, a Slack channel: the turn carries no `nextSteps`
    // block, so the tool must refuse and the model keeps its question in its closing message.
    it('refuses and records nothing, then accepts once a drawing client sends a turn', async () => {
        const client = fakeClient();
        const cards = createTurnCardSwitch('claude');
        const server = await startHappyServer(client, { turnCards: cards });
        try {
            const card = { summary: 'Done.', question: 'Commit it now?', actions: [{ kind: 'commit' }] };
            const refused = await callTool(server.url, 'next_steps', card);
            expect(refused.result.isError).toBe(true);
            expect(refused.result.content[0].text).toMatch(/^NEXT_STEPS_UNSUPPORTED: .*closing message/);
            expect(client.sendSessionProtocolMessage).not.toHaveBeenCalled();

            cards.set(true);
            expect((await callTool(server.url, 'next_steps', card)).result.isError).toBeFalsy();
            cards.set(false);
            expect((await callTool(server.url, 'next_steps', card)).result.isError).toBe(true);
            expect(client.sendSessionProtocolMessage).toHaveBeenCalledTimes(1);
        } finally { server.stop(); }
    });

    it('refuses a whitespace-only recap instead of telling the model the card is shown', async () => {
        const client = fakeClient();
        const server = await startHappyServer(client, { turnCards: drawnTurn('codex') });
        try {
            const reply = await callTool(server.url, 'next_steps', { summary: '   ', actions: [] });
            expect(reply.result?.isError ?? !!reply.error).toBe(true);
            expect(client.sendSessionProtocolMessage).not.toHaveBeenCalled();
        } finally { server.stop(); }
    });
});

describe('next_steps description', () => {
    it('defers when to call to the per-turn guidance instead of asking for a call every turn', async () => {
        const server = await startHappyServer(fakeClient(), { turnCards: drawnTurn('claude') });
        try {
            const tools = (await rpc(server.url, 'tools/list', {})).result.tools as Array<{ name: string; description: string }>;
            const description = tools.find((tool) => tool.name === 'next_steps')!.description;
            expect(description).toContain('only when your instructions contain <saycode-next-steps>');
            expect(description).not.toMatch(/Call it once before you end a turn/);
        } finally { server.stop(); }
    });
});

describe('task list', () => {
    it('is not a tool: Claude has TodoWrite and Codex its built-in update_plan', async () => {
        for (const runner of ['claude', 'codex'] as const) {
            const server = await startHappyServer(fakeClient(), { turnCards: drawnTurn(runner) });
            try {
                expect(server.toolNames).toContain('next_steps');
                expect(server.toolNames).not.toContain('update_plan');
                const names = await listNames(server.url);
                expect(names).toContain('next_steps');
                expect(names).not.toContain('update_plan');
            } finally { server.stop(); }
        }
    });
});
