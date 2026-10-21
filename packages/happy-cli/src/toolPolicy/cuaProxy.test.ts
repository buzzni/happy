/**
 * The cua-driver shadow proxy end to end, minus the provider: a client speaks JSON-RPC to the real
 * proxy, which starts a stand-in cua-driver and asks the real session hook server, which runs the
 * real gate. Only the approver (a person) and the target resolver (the OS) are stand-ins.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { startHookServer, type HookServer } from '@/claude/utils/startHookServer';
import { createToolPolicyAuditLog } from './audit';
import { parseCuaProxyArgv, startCuaProxy, type CuaProxy } from './cuaProxy';
import { createPolicyGrantStore } from './grants';
import { toolPolicyAdapterEnv, toolPolicyClientFromEnv, withoutToolPolicyEnv } from './policyClient';
import { createToolPolicyGate, type PolicyApprovalAnswer, type PolicyApprover } from './policyGate';
import { ABSENT_MACHINE_POLICY, type AppIdentity } from './rules';
import type { TargetResolver } from './targetResolver';

const FAKE_CUA = resolve(__dirname, '__fixtures__/fakeCuaServer.cjs');
const SECRET = 'b'.repeat(64);
const APPS: Record<number, AppIdentity> = {
    11: { pid: 11, bundleId: 'com.apple.Terminal', name: 'Terminal' },
    12: { pid: 12, bundleId: 'com.apple.finder', name: 'Finder' },
};

interface Asked { id: string; toolName: string; policy: { reasonCode: string; target?: { appName: string } } }

let server: HookServer | null = null;
let proxy: CuaProxy | null = null;
afterEach(() => {
    proxy?.stop();
    proxy = null;
    server?.stop();
    server = null;
});

async function setup(options: { answer?: PolicyApprovalAnswer; policyReachable?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'cua-proxy-'));
    const secretFile = join(dir, 'secret');
    writeFileSync(secretFile, SECRET, { mode: 0o600 });
    const marker = join(dir, 'calls.log');
    const auditPath = join(dir, 'audit.jsonl');
    const asked: Asked[] = [];
    const resolved: number[] = [];
    const resolver: TargetResolver = {
        resolve: async (request) => {
            if (request.kind !== 'pid' || !APPS[request.pid]) return { status: 'unresolved' };
            resolved.push(request.pid);
            return { status: 'resolved', app: APPS[request.pid] };
        },
    };
    const approver: PolicyApprover = {
        requestPolicyApproval: async (request) => {
            asked.push(request);
            return options.answer ?? { approved: true, policyGrant: 'once' };
        },
    };
    const gate = createToolPolicyGate({
        loadMachinePolicy: () => ABSENT_MACHINE_POLICY,
        resolver,
        grants: createPolicyGrantStore(),
        audit: createToolPolicyAuditLog({ path: auditPath, sessionId: () => 's1' }),
        approver: () => approver,
        unattended: false,
        platform: 'darwin',
    });
    server = await startHookServer({ onSessionHook: () => undefined, preToolUse: { secret: SECRET, decide: gate.decide, toolsListed: gate.toolsListed } });
    const env = {
        ...process.env,
        FAKE_CUA_MARKER: marker,
        ...toolPolicyAdapterEnv({ port: options.policyReachable === false ? 1 : server.port, secretFile, server: 'cua-driver' }),
    };

    const input = new PassThrough();
    const output = new PassThrough();
    const exits: number[] = [];
    const responses = new Map<number, Record<string, unknown>>();
    const waiters = new Map<number, (message: Record<string, unknown>) => void>();
    let buffer = '';
    output.on('data', (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
            const message = JSON.parse(buffer.slice(0, index));
            buffer = buffer.slice(index + 1);
            responses.set(message.id, message);
            waiters.get(message.id)?.(message);
        }
    });
    proxy = startCuaProxy({
        upstream: { command: process.execPath, args: [FAKE_CUA], env: withoutToolPolicyEnv(env) },
        policy: toolPolicyClientFromEnv(env, 'cua-proxy'),
        input,
        output,
        onExit: (code) => exits.push(code),
        log: () => undefined,
    });
    let nextId = 1;
    const request = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
        const id = nextId++;
        const answered = new Promise<Record<string, unknown>>((resolveAnswer) => waiters.set(id, resolveAnswer));
        input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        return answered;
    };
    const call = (name: string, args: Record<string, unknown>, meta?: Record<string, unknown>) => request('tools/call', { name, arguments: args, ...(meta ? { _meta: meta } : {}) });
    await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    const calls = () => (existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean) : []);
    const audit = () => (existsSync(auditPath) ? readFileSync(auditPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);
    return { request, call, calls, audit, asked, resolved, exits, input, output };
}

function text(response: Record<string, unknown>): string {
    const result = response.result as { content?: Array<{ text: string }> };
    return result.content?.[0]?.text ?? '';
}

describe('cua-driver shadow proxy', () => {
    it('passes tools/list through unchanged and records tools the table does not classify (R9)', async () => {
        const t = await setup();
        const listed = await t.request('tools/list');
        expect((listed.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name))
            .toEqual(['get_window_state', 'click', 'type_text', 'list_apps', 'teleport_window', 'crash']);
        await expect.poll(() => t.audit().map((entry) => `${entry.reasonCode} ${entry.tool}`))
            .toEqual(['unlisted_tool mcp__cua-driver__teleport_window', 'unlisted_tool mcp__cua-driver__crash']);
    });

    it('refuses a blocked call with the R12 text and never lets it reach cua-driver', async () => {
        const t = await setup();
        const response = await t.call('type_text', { pid: 11, text: 'rm -rf ~' });
        expect((response.result as { isError?: boolean }).isError).toBe(true);
        expect(text(response)).toContain('Terminal');
        expect(text(response)).toContain('우회하지 마라');
        expect(t.calls()).toEqual([]);
    });

    it('judges a call that names only an element token against the app of the snapshot that issued it', async () => {
        const t = await setup();
        await t.call('get_window_state', { pid: 11, window_id: 5 });
        expect(t.calls()).toEqual(['get_window_state {"pid":11,"window_id":5}']);

        const typed = await t.call('type_text', { element_token: 'tok-11', text: 'ls' });
        expect((typed.result as { isError?: boolean }).isError).toBe(true);
        expect(text(typed)).toContain('Terminal');
        expect(t.calls()).toHaveLength(1);
        expect(t.asked).toEqual([]);
    });

    it('asks a person for a first use, attaching the request to the provider call id, then runs the call', async () => {
        const t = await setup();
        await t.call('get_window_state', { pid: 12, window_id: 7 });
        const clicked = await t.call('click', { element_token: 'tok-12' }, { 'claudecode/toolUseId': 'toolu_9' });
        expect(text(clicked)).toBe('click done');
        expect(t.asked).toMatchObject([{ id: 'toolu_9', toolName: 'mcp__cua-driver__click', policy: { reasonCode: 'first_app_use', target: { appName: 'Finder' } } }]);
        expect(t.resolved).toContain(12);
        expect(t.calls()).toEqual(['get_window_state {"pid":12,"window_id":7}', 'click {"element_token":"tok-12"}']);
    });

    // Review #1: which window cua-driver acts on is not ours to guess when the pid and the token disagree.
    it('treats a token from one app sent with the pid of another as an unknown target', async () => {
        const t = await setup();
        await t.call('get_window_state', { pid: 11, window_id: 5 });
        await t.call('click', { pid: 12, element_token: 'tok-11' });
        expect(t.asked).toMatchObject([{ toolName: 'mcp__cua-driver__click', policy: { reasonCode: 'target_unresolved' } }]);
    });

    // Cross review #4: a token lives as long as its window's snapshot, and only snapshots issue tokens.
    it('forgets a window\'s tokens when that window is snapshotted again, and records tokens from get_window_state only', async () => {
        const t = await setup();
        await t.call('get_window_state', { pid: 12, window_id: 7 });
        await t.call('get_window_state', { pid: 11, window_id: 5 });
        await t.call('get_window_state', { pid: 12, window_id: 7 });
        expect(proxy!.tokenPid('tok-12')).toBeUndefined();
        expect(proxy!.tokenPid('tok-12-v2')).toBe(12);
        expect(proxy!.tokenPid('tok-11')).toBe(11);

        await t.call('list_apps', {});
        expect(proxy!.tokenPid('tok-listed')).toBeUndefined();

        // A stale token names no app the proxy knows: the target is unresolved, so a person is asked.
        await t.call('click', { element_token: 'tok-12' });
        expect(t.asked).toMatchObject([{ toolName: 'mcp__cua-driver__click', policy: { reasonCode: 'target_unresolved' } }]);
    });

    // Review #5: nothing reaches cua-driver without a decision.
    it('refuses a batch and drops a call without an id or a line it cannot read', async () => {
        const t = await setup();
        const answered = new Promise<string>((resolveLine) => t.output.once('data', (chunk) => resolveLine(String(chunk))));
        t.input.write(JSON.stringify([{ jsonrpc: '2.0', id: 90, method: 'tools/call', params: { name: 'type_text', arguments: { pid: 12, text: 'x' } } }]) + '\n');
        expect(JSON.parse(await answered)).toMatchObject({ id: 90, error: { code: -32600 } });
        t.input.write(JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'type_text', arguments: { pid: 12, text: 'x' } } }) + '\n');
        t.input.write('{"jsonrpc":"2.0","id":91,"method":"tools/call","params":{"name":"type_text"\n');
        await t.call('list_apps', {});
        expect(t.calls()).toEqual(['list_apps {}']);
    });

    it('refuses the call when the person declines', async () => {
        const t = await setup({ answer: { approved: false, policyGrant: 'once' } });
        const response = await t.call('click', { pid: 12 }, { callId: 'exec-1' });
        expect(text(response)).toContain('거절');
        expect(t.asked[0].id).toBe('exec-1');
        expect(t.calls()).toEqual([]);
    });

    it('refuses every call when the policy endpoint cannot be reached', async () => {
        const t = await setup({ policyReachable: false });
        const response = await t.call('list_apps', {});
        expect((response.result as { isError?: boolean }).isError).toBe(true);
        expect(text(response)).toContain('정책 확인을 끝내지 못해');
        expect(t.calls()).toEqual([]);
    });

    it('goes down with cua-driver instead of exposing anything unjudged', async () => {
        const t = await setup();
        void t.call('crash', {});
        await expect.poll(() => t.exits).toEqual([3]);
        expect(t.calls()).toEqual(['crash {}']);
    });
});

describe('parseCuaProxyArgv', () => {
    it('reads the user command after --', () => {
        expect(parseCuaProxyArgv(['--cua-proxy', '--', '/usr/local/bin/cua-driver', 'mcp'])).toEqual({ command: '/usr/local/bin/cua-driver', args: ['mcp'] });
        expect(parseCuaProxyArgv(['--cua-proxy'])).toBeNull();
        expect(parseCuaProxyArgv(['--url', 'http://x', '--', 'a'])).toBeNull();
    });
});
