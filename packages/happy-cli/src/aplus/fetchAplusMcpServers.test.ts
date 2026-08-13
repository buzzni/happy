import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    fetchAplusMcpServers,
    fetchAplusMcpServersResult,
    mcpConfigFailureStatuses,
} from './fetchAplusMcpServers';

describe('fetchAplusMcpServersResult', () => {
    beforeEach(() => {
        delete process.env.HAPPY_APLUS_EXPECTED_CONNECTORS;
        delete process.env.HAPPY_APLUS_EXPECTED_MCP_SERVICES;
        process.env.HAPPY_APLUS_MCP_CONFIG_URL = 'http://aplus.test/api/me/mcp-config';
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        delete process.env.HAPPY_APLUS_MCP_CONFIG_URL;
        delete process.env.HAPPY_APLUS_MCP_CALLER_GRANT;
        delete process.env.HAPPY_APLUS_EXPECTED_CONNECTORS;
        delete process.env.HAPPY_APLUS_EXPECTED_MCP_SERVICES;
        delete process.env.HAPPY_APLUS_MCP_INITIAL_LIFECYCLE;
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

    it('re-fetches config once when an expected connector is missing', async () => {
        process.env.HAPPY_APLUS_EXPECTED_CONNECTORS = '["gmail","knoi"]';
        process.env.HAPPY_APLUS_MCP_INITIAL_LIFECYCLE = 'spawn';
        const fetchMock = vi.fn<typeof fetch>()
            .mockResolvedValueOnce(new Response(JSON.stringify({
                mcpServers: { gmail: { type: 'http', url: 'https://saycode.test/mcp/connector/gmail' } },
            }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                mcpServers: {
                    gmail: { type: 'http', url: 'https://saycode.test/mcp/connector/gmail' },
                    knoi: { type: 'http', url: 'https://saycode.test/mcp/connector/knoi' },
                },
            }), { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);

        await expect(fetchAplusMcpServersResult(
            'happy-token',
            'machine-1',
            { sessionId: 'session-1', lifecycle: 'spawn' },
        )).resolves.toMatchObject({ ok: true, servers: { gmail: expect.anything(), knoi: expect.anything() } });

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
            'X-Aplus-Expected-Connectors': 'gmail,knoi',
            'X-Aplus-Session-Id': 'session-1',
            'X-Aplus-Mcp-Lifecycle': 'spawn',
        });
    });

    it('returns connector-config-missing after one retry without exposing credentials', async () => {
        process.env.HAPPY_APLUS_EXPECTED_CONNECTORS = '["gmail","knoi"]';
        const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
            mcpServers: {
                gmail: {
                    type: 'http',
                    url: 'https://saycode.test/mcp/connector/gmail',
                    headers: { Authorization: 'Bearer connector-secret' },
                },
            },
        }), { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);

        const result = await fetchAplusMcpServersResult(
            'happy-secret-token',
            'machine-1',
            { sessionId: 'session-1', lifecycle: 'resume' },
        );

        expect(result).toEqual({
            ok: false,
            reason: 'connector-config-missing',
            error: 'Expected connector configuration is missing: knoi',
            expected: ['gmail', 'knoi'],
            configured: ['gmail'],
            missing: ['knoi'],
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(JSON.stringify(result)).not.toContain('connector-secret');
        expect(JSON.stringify(result)).not.toContain('happy-secret-token');
        expect(mcpConfigFailureStatuses(result, 123)).toEqual([{
            name: 'knoi',
            status: 'connector-config-missing',
            error: 'Expected connector configuration is missing: knoi',
            checkedAt: 123,
        }]);
    });

    it('adopts authoritative expected connectors after disconnect or needsReauth', async () => {
        process.env.HAPPY_APLUS_EXPECTED_CONNECTORS = '["gmail","knoi"]';
        const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
            mcpServers: {
                gmail: { type: 'http', url: 'https://saycode.test/mcp/connector/gmail' },
            },
            connectorReadiness: {
                status: 'ready',
                expected: ['gmail'],
                configured: ['gmail'],
                missing: [],
            },
        }), { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);

        await expect(fetchAplusMcpServersResult('happy-token', 'machine-1', {
            sessionId: 'session-1', lifecycle: 'turn',
        })).resolves.toMatchObject({ ok: true, servers: { gmail: expect.anything() } });

        expect(fetchMock).toHaveBeenCalledOnce();
        expect(process.env.HAPPY_APLUS_EXPECTED_CONNECTORS).toBe('["gmail"]');
    });

    it('treats an effectively connected Argos missing from config as mcp-config-missing', async () => {
        const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
            mcpServers: {
                'aplus-common': { type: 'http', url: 'https://saycode.test/mcp/common' },
            },
            mcpReadiness: {
                status: 'mcp-config-missing',
                expected: ['argos'],
                configured: [],
                missing: [{ name: 'argos', reason: 'missing-headers' }],
            },
        }), { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);

        const result = await fetchAplusMcpServersResult(
            'happy-secret-token',
            'machine-1',
            { sessionId: 'session-1', lifecycle: 'turn' },
        );

        expect(result).toEqual({
            ok: false,
            reason: 'mcp-config-missing',
            error: 'Expected MCP service configuration is missing: argos',
            expected: ['argos'],
            configured: [],
            missing: [{ name: 'argos', reason: 'missing-headers' }],
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(process.env.HAPPY_APLUS_EXPECTED_MCP_SERVICES).toBe('["argos"]');
        expect(mcpConfigFailureStatuses(result, 123)).toEqual([{
            name: 'argos',
            status: 'mcp-config-missing',
            error: 'Expected MCP service configuration is missing: argos',
            checkedAt: 123,
        }]);
    });
});
