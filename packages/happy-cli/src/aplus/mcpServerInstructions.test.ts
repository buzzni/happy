import { describe, expect, it, vi } from 'vitest';
import { createMcpServerInstructionsReader, formatMcpServerInstructions } from './mcpServerInstructions';

function initializeResponse(instructions: string): Response {
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { instructions } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });
}

const servers = {
    'aplus-common': { type: 'http' as const, url: 'https://studio.test/mcp/common', headers: { Authorization: 'Bearer grant-1' } },
    'aplus-company': { type: 'http' as const, url: 'https://studio.test/mcp/company/co-1', headers: { Authorization: 'Bearer grant-1' } },
    gmail: { type: 'http' as const, url: 'https://connectors.test/gmail' },
};

describe('createMcpServerInstructionsReader', () => {
    it('reads the skill catalogs the Saycode servers send on initialize, which Codex does not put in its prompt', async () => {
        const fetchImpl = vi.fn(async (url: string, _init: RequestInit) => initializeResponse(
            url.endsWith('/common') ? '# 공통 스킬 카탈로그\n- **coding-principles**' : '# 사용 가능한 스킬\n- **shorts-director**',
        ));
        const reader = createMcpServerInstructionsReader({ fetchImpl });

        const block = await reader.read(servers);

        expect(block).toContain('## aplus-common\n# 공통 스킬 카탈로그');
        expect(block).toContain('## aplus-company\n# 사용 가능한 스킬\n- **shorts-director**');
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        const [, init] = fetchImpl.mock.calls[0];
        expect(JSON.parse(String(init.body))).toMatchObject({ jsonrpc: '2.0', method: 'initialize' });
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer grant-1');
    });

    it('asks each server once per configuration and again only when its address or credentials change', async () => {
        const fetchImpl = vi.fn(async () => initializeResponse('catalog'));
        const reader = createMcpServerInstructionsReader({ fetchImpl });

        await reader.read(servers);
        await reader.read(servers);
        expect(fetchImpl).toHaveBeenCalledTimes(2);

        await reader.read({ ...servers, 'aplus-company': { ...servers['aplus-company'], headers: { Authorization: 'Bearer grant-2' } } });
        expect(fetchImpl).toHaveBeenCalledTimes(3);
    });

    it('leaves a server out when it fails or answers with nothing, so the session still starts', async () => {
        const fetchImpl = vi.fn(async (url: string, _init: RequestInit) => url.endsWith('/common')
            ? new Response('nope', { status: 500 })
            : initializeResponse('   '));
        const reader = createMcpServerInstructionsReader({ fetchImpl });

        expect(await reader.read(servers)).toBe('');
    });

    it('does not call servers that are absent from the session', async () => {
        const fetchImpl = vi.fn(async () => initializeResponse('catalog'));
        const reader = createMcpServerInstructionsReader({ fetchImpl });

        expect(await reader.read({ gmail: servers.gmail })).toBe('');
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});

describe('formatMcpServerInstructions', () => {
    it('labels the block as server-provided, the way Claude Code presents MCP instructions', () => {
        const block = formatMcpServerInstructions([{ name: 'aplus-company', instructions: '# 사용 가능한 스킬' }]);
        expect(block.startsWith('# MCP Server Instructions')).toBe(true);
        expect(block).toContain('## aplus-company\n# 사용 가능한 스킬');
    });

    it('caps one server so an oversized catalog cannot crowd out the rest of the prompt', () => {
        const block = formatMcpServerInstructions([{ name: 'aplus-common', instructions: 'x'.repeat(50_000) }]);
        expect(block.length).toBeLessThan(21_000);
        expect(block).toContain('[truncated]');
    });
});
