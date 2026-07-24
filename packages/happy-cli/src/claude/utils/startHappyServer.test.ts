import { describe, expect, it, vi } from 'vitest';
import { createChangeTitleHandler, startHappyServer } from './startHappyServer';
import type { ApiSessionClient } from '@/api/apiSession';

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        debugLargeJson: vi.fn()
    }
}));

function makeFakeClient(hasTitle: boolean) {
    return {
        hasTitle: vi.fn(() => hasTitle),
        sendClaudeSessionMessage: vi.fn()
    } as unknown as ApiSessionClient;
}

describe('createChangeTitleHandler', () => {
    it('sets the title when the session has none yet', async () => {
        const client = makeFakeClient(false);
        const changeTitle = createChangeTitleHandler(client);

        const result = await changeTitle('Fix login bug');

        expect(result).toEqual({ success: true });
        expect(client.sendClaudeSessionMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'summary', summary: 'Fix login bug' })
        );
    });

    it('locks the title once one already exists, ignoring later change_title calls', async () => {
        const client = makeFakeClient(true);
        const changeTitle = createChangeTitleHandler(client);

        const result = await changeTitle('A newer title the model came up with');

        expect(result.success).toBe(false);
        expect(client.sendClaudeSessionMessage).not.toHaveBeenCalled();
    });
});

describe('startHappyServer tool registration', () => {
    // The MCP server is rebuilt per request, so a malformed tool schema does
    // not fail at startup — it breaks every tool in the session at call time.
    // Listing the tools over the real transport is what catches that.
    it('serves every happy tool over tools/list', async () => {
        const client = { hasTitle: () => false, sendClaudeSessionMessage: vi.fn(), sessionId: 'test' } as unknown as ApiSessionClient;
        const server = await startHappyServer(client);
        try {
            const response = await fetch(server.url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream',
                },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
            });
            expect(response.status).toBe(200);

            const raw = await response.text();
            const payload = JSON.parse(raw.startsWith('event:') ? raw.slice(raw.indexOf('data: ') + 6) : raw);
            const names = payload.result.tools.map((tool: { name: string }) => tool.name);

            expect(names).toEqual(expect.arrayContaining([
                'change_title',
                'bash_stream',
                'browser_tabs',
                'browser_snapshot',
                'browser_screenshot',
            ]));
            expect(names).toEqual(expect.arrayContaining(server.toolNames));
        } finally {
            server.stop();
        }
    });
});
