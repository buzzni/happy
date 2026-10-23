/**
 * Tool policy at the stdio bridge (aplus-dev-studio specs/agent-tool-policy R8, R9) and the
 * `--cua-proxy` entry: the real bridge process, the real session hook server and gate, an HTTP MCP
 * fixture for a Saycode-injected server and the stand-in cua-driver. A person is the only stand-in.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startHookServer } from '@/claude/utils/startHookServer';
import { createToolPolicyAuditLog } from '@/toolPolicy/audit';
import { createPolicyGrantStore } from '@/toolPolicy/grants';
import { toolPolicyAdapterEnv } from '@/toolPolicy/policyClient';
import { createToolPolicyGate, type PolicyApprovalAnswer } from '@/toolPolicy/policyGate';
import { ABSENT_MACHINE_POLICY, type MachinePolicy } from '@/toolPolicy/rules';

const SECRET = 'c'.repeat(64);
const TOOLS = [
    { name: 'search_pages', annotations: { readOnlyHint: true } },
    { name: 'update_page' },
    { name: 'send_message' },
    // The server calls it read-only; the name is a high-risk verb, which wins (R8.3).
    { name: 'delete_page', annotations: { readOnlyHint: true } },
];

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    cleanups.length = 0;
});

async function policySession(answer: PolicyApprovalAnswer, machine: MachinePolicy = ABSENT_MACHINE_POLICY) {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-policy-'));
    const secretFile = join(dir, 'secret');
    writeFileSync(secretFile, SECRET, { mode: 0o600 });
    const auditPath = join(dir, 'audit.jsonl');
    const asked: Array<{ id: string; toolName: string; policy: { reasonCode: string; humanOnly: boolean } }> = [];
    const gate = createToolPolicyGate({
        loadMachinePolicy: () => machine,
        resolver: { resolve: async () => ({ status: 'resolved', app: { pid: 12, bundleId: 'com.apple.finder', name: 'Finder' } }) },
        grants: createPolicyGrantStore(),
        audit: createToolPolicyAuditLog({ path: auditPath, sessionId: () => 's1' }),
        approver: () => ({ requestPolicyApproval: async (request) => { asked.push(request); return answer; } }),
        unattended: () => false,
        platform: 'darwin',
    });
    const server = await startHookServer({ onSessionHook: () => undefined, preToolUse: { secret: SECRET, decide: gate.decide, toolsListed: gate.toolsListed } });
    cleanups.push(() => server.stop());
    const audit = () => (existsSync(auditPath) ? readFileSync(auditPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);
    return { dir, asked, audit, env: (name: string) => toolPolicyAdapterEnv({ port: server.port, secretFile, server: name }) };
}

/** `listings`: what each successive `tools/list` returns (the last one repeats). */
async function httpMcp(listings: Array<Array<{ name: string; annotations?: Record<string, boolean> }>> = [TOOLS]) {
    const calls: string[] = [];
    let listed = 0;
    const server = createServer(async (req, res) => {
        if (req.method === 'GET') { res.writeHead(405).end(); return; }
        let body = '';
        for await (const chunk of req) body += chunk;
        const message = JSON.parse(body);
        if (message.id === undefined) { res.writeHead(202).end(); return; }
        if (message.method === 'tools/call') calls.push(message.params.name);
        const result = message.method === 'initialize'
            ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
            : message.method === 'tools/list'
                ? { tools: listings[Math.min(listed++, listings.length - 1)].map((tool) => ({ ...tool, inputSchema: { type: 'object' } })) }
                : { content: [{ type: 'text', text: `${message.params.name} ran` }] };
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'fixture' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    cleanups.push(() => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing address');
    return { url: `http://127.0.0.1:${address.port}/mcp`, calls };
}

function stdioChild(args: string[], env: Record<string, string>) {
    const child = spawn(process.execPath, ['--import', 'tsx', resolve('src/codex/happyMcpStdioBridge.ts'), ...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, HAPPY_HTTP_MCP_HEADERS: '', ...env },
    });
    const responses = new Map<number, any>();
    let buffer = '';
    child.stdout.on('data', (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
            const message = JSON.parse(buffer.slice(0, index));
            buffer = buffer.slice(index + 1);
            if (message.id !== undefined) responses.set(message.id, message);
        }
    });
    const exited = once(child, 'exit');
    cleanups.push(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exited;
    });
    let nextId = 1;
    const request = async (method: string, params: Record<string, unknown> = {}) => {
        const id = nextId++;
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        await expect.poll(() => responses.has(id), { timeout: 10_000 }).toBe(true);
        return responses.get(id);
    };
    return { child, request };
}

async function initialized(b: ReturnType<typeof stdioChild>) {
    await b.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    b.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
}

const callText = (response: any): string => response.result?.content?.[0]?.text ?? '';

describe('stdio bridge tool policy', { timeout: 30_000 }, () => {
    it('runs a read tool, asks for a high-risk write and records unlisted write tools', async () => {
        const session = await policySession({ approved: false, policyGrant: 'once' });
        const http = await httpMcp();
        const b = stdioChild(['--url', http.url], session.env('notion'));
        await initialized(b);
        await b.request('tools/list');

        expect(callText(await b.request('tools/call', { name: 'search_pages', arguments: {} }))).toBe('search_pages ran');
        expect(callText(await b.request('tools/call', { name: 'update_page', arguments: {} }))).toBe('update_page ran');

        const sent = await b.request('tools/call', { name: 'send_message', arguments: { to: 'x' }, _meta: { callId: 'exec-7' } });
        expect(sent.result.isError).toBe(true);
        expect(callText(sent)).toContain('거절');
        expect(session.asked).toMatchObject([{ id: 'exec-7', toolName: 'mcp__notion__send_message', policy: { reasonCode: 'high_risk_write', humanOnly: true } }]);

        const deleted = await b.request('tools/call', { name: 'delete_page', arguments: {} });
        expect(deleted.result.isError).toBe(true);
        expect(http.calls).toEqual(['search_pages', 'update_page']);

        await expect.poll(() => session.audit().filter((entry) => entry.reasonCode === 'unlisted_write_tool').map((entry) => entry.tool))
            .toEqual(['mcp__notion__update_page', 'mcp__notion__send_message', 'mcp__notion__delete_page']);
    });

    it('judges a call that arrives before any listing with the annotations it fetches first', async () => {
        const session = await policySession({ approved: true, policyGrant: 'once' });
        const http = await httpMcp();
        const b = stdioChild(['--url', http.url], session.env('notion'));
        await initialized(b);
        expect(callText(await b.request('tools/call', { name: 'delete_page', arguments: {} }))).toBe('delete_page ran');
        expect(session.asked.map((request) => request.policy.reasonCode)).toEqual(['high_risk_write']);
    });

    it('keeps the most restrictive annotations when a later listing drops or loosens them (R8.3)', async () => {
        const session = await policySession({ approved: false, policyGrant: 'once' }, { ...ABSENT_MACHINE_POLICY, askWriteTools: true });
        const http = await httpMcp([
            [{ name: 'frobnicate', annotations: { destructiveHint: true } }, { name: 'update_page' }, { name: 'search_pages', annotations: { readOnlyHint: true } }],
            [{ name: 'frobnicate' }, { name: 'update_page', annotations: { readOnlyHint: true } }, { name: 'search_pages', annotations: { readOnlyHint: true } }],
        ]);
        const b = stdioChild(['--url', http.url], session.env('notion'));
        await initialized(b);
        await b.request('tools/list');
        await b.request('tools/list');

        expect((await b.request('tools/call', { name: 'frobnicate', arguments: {} })).result.isError).toBe(true);
        expect((await b.request('tools/call', { name: 'update_page', arguments: {} })).result.isError).toBe(true);
        expect(callText(await b.request('tools/call', { name: 'search_pages', arguments: {} }))).toBe('search_pages ran');
        expect(session.asked.map((request) => [request.toolName, request.policy.reasonCode])).toEqual([
            ['mcp__notion__frobnicate', 'write_tool'],
            ['mcp__notion__update_page', 'write_tool'],
        ]);
        expect(http.calls).toEqual(['search_pages']);
    });

    it('runs the cua-driver shadow proxy from the bridge entry and refuses a terminal keystroke', async () => {
        const session = await policySession({ approved: true, policyGrant: 'once' });
        const marker = join(session.dir, 'cua-calls.log');
        const b = stdioChild(['--cua-proxy', '--', process.execPath, resolve('src/toolPolicy/__fixtures__/fakeCuaServer.cjs')], {
            ...session.env('cua-driver'), FAKE_CUA_MARKER: marker,
        });
        await initialized(b);
        // The stand-in resolves every pid to Finder; a token from a snapshot is enough to run.
        await b.request('tools/call', { name: 'get_window_state', arguments: { pid: 12, window_id: 1 } });
        expect(callText(await b.request('tools/call', { name: 'click', arguments: { element_token: 'tok-12' } }))).toBe('click done');
        const quit = await b.request('tools/call', { name: 'press_key', arguments: { key: 'q', modifiers: ['cmd'] } });
        expect(quit.result.isError).toBe(true);
        expect(readFileSync(marker, 'utf8').trim().split('\n')).toEqual(['get_window_state {"pid":12,"window_id":1}', 'click {"element_token":"tok-12"}']);
    });
});
