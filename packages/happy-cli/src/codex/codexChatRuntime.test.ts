import { describe, expect, it } from 'vitest';
import { access, readFile } from 'node:fs/promises';
import { prepareCodexChatRuntime, buildCodexChatMcpServers } from './codexChatRuntime';

describe('Codex Chat runtime', () => {
    it('rejects versions whose file tool boundary has not been verified', async () => {
        await expect(prepareCodexChatRuntime({}, { major: 0, minor: 146, patch: 0 })).rejects.toThrow('0.155.0');
        await expect(prepareCodexChatRuntime({}, null)).rejects.toThrow('0.155.0');
    });
    it('uses runtime-only configuration without a local execution environment', async () => {
        const runtime = await prepareCodexChatRuntime({ PATH: '/usr/bin' }, { major: 0, minor: 155, patch: 0 });
        const directory = runtime.env.CODEX_HOME;
        try {
            expect(await readFile(`${directory}/environments.toml`, 'utf8')).toContain('include_local = false');
            expect(await readFile(`${directory}/environments.toml`, 'utf8')).toContain('environments = []');
            expect(runtime.args).toContain('features.shell_tool=false');
            expect(runtime.args).toContain('features.unified_exec=false');
            expect(runtime.args).toContain('features.view_image=false');
            expect(runtime.args).toContain('features.code_mode=false');
            expect(runtime.args).toContain('project_doc_max_bytes=0');
        } finally { await runtime.cleanup(); }
        await expect(access(directory)).rejects.toThrow();
    });
});


it('Chat connects only the document MCP over HTTP without a local stdio process', () => {
    const headers = { Authorization: 'Bearer scoped-test-grant', 'x-aplus-machine-id': 'machine' };
    expect(buildCodexChatMcpServers({
        saycode: { type: 'http', url: 'https://studio.test/mcp/documents', headers },
        common: { type: 'http', url: 'https://studio.test/mcp/common' },
    })).toEqual({ saycode: { url: 'https://studio.test/mcp/documents', http_headers: headers,
        enabled_tools: ['search_documents', 'read_document', 'write_document', 'get_mode', 'request_mode_transition'] } });
    expect(() => buildCodexChatMcpServers({})).toThrow('saycode');
});
