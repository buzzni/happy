import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAplusMcpServers, fetchAplusMcpServersResult } from './fetchAplusMcpServers';

describe('fetchAplusMcpServersResult', () => {
    beforeEach(() => {
        process.env.HAPPY_APLUS_MCP_CONFIG_URL = 'http://aplus.test/api/me/mcp-config';
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        delete process.env.HAPPY_APLUS_MCP_CONFIG_URL;
        delete process.env.HAPPY_APLUS_MCP_CALLER_GRANT;
    });

    it('returns a successful server map', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
            mcpServers: {
                argos: { type: 'http', url: 'https://argos.test/mcp' },
            },
        }), { status: 200 })));

        await expect(fetchAplusMcpServersResult('happy-token', 'machine-1')).resolves.toEqual({
            ok: true,
            servers: {
                argos: { type: 'http', url: 'https://argos.test/mcp' },
            },
        });
    });

    it('sends the child-only caller grant on initial and subsequent config fetches', async () => {
        process.env.HAPPY_APLUS_MCP_CALLER_GRANT = 'signed-caller-grant';
        const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ mcpServers: {} }), { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);

        await fetchAplusMcpServersResult('company-happy-token', 'machine-1');
        await fetchAplusMcpServersResult('company-happy-token', 'machine-1');

        expect(fetchMock).toHaveBeenCalledTimes(2);
        for (const [, init] of fetchMock.mock.calls) {
            expect(init?.headers).toMatchObject({
                Authorization: 'Bearer company-happy-token',
                'X-Aplus-Machine-Id': 'machine-1',
                'X-Aplus-Caller-Grant': 'signed-caller-grant',
            });
        }
    });

    it('distinguishes an HTTP failure without exposing the bearer token', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })));

        const result = await fetchAplusMcpServersResult('super-secret-token', 'machine-1');

        expect(result).toEqual({
            ok: false,
            reason: 'http-error',
            error: 'mcp-config responded with 503',
        });
        expect(JSON.stringify(result)).not.toContain('super-secret-token');
    });

    it('keeps the legacy map wrapper empty on failure', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));

        await expect(fetchAplusMcpServers('happy-token', 'machine-1')).resolves.toEqual({});
    });
});
