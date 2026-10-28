import { mkdtempSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startHookServer, type HookServer } from '@/claude/utils/startHookServer';
import { handOffCuaToShadowProxy } from './claudeHook';
import { CUA_DRIVER_SERVER } from './cuaShadow';
import { createPolicyGrantStore, REMOTE_GRANT_TTL_MS } from './grants';
import { registerToolPolicyGrantRpcs, TOOL_POLICY_GRANTS_RPC, TOOL_POLICY_REVOKE_GRANT_RPC } from './grantControl';
import { toolPolicyAdapterEnv, toolPolicyClientFromEnv } from './policyClient';
import type { PolicyApprovalAnswer, PolicyApprover } from './policyGate';
import { createToolPolicyRuntime, type ToolPolicyRuntime } from './runtime';

type Handler = (params: unknown) => unknown;

function registrar() {
    const handlers = new Map<string, Handler>();
    return {
        handlers,
        registerHandler: (method: string, handler: Handler) => { handlers.set(method, handler); },
        call: async (method: string, params: unknown) => {
            const handler = handlers.get(method);
            if (!handler) throw new Error(`Method not found: ${method}`);
            return handler(params);
        },
    };
}

function clock(start = 1_000) {
    let t = start;
    return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('tool policy grant control RPCs (aplus-dev-studio specs/agent-tool-policy R18, T22b)', () => {
    it('lists the live conversation grants as Desktop reads them', async () => {
        const time = clock();
        const grants = createPolicyGrantStore({ now: time.now, grantTtlMs: REMOTE_GRANT_TTL_MS });
        const rpc = registrar();
        registerToolPolicyGrantRpcs(rpc, grants);
        grants.grant(['app:com.apple.Notes', 'clipboard:clipboard_read']);
        time.advance(60_000);
        grants.grant(['tool:mcp__fake__send_mail']);

        expect(await rpc.call(TOOL_POLICY_GRANTS_RPC, {})).toEqual({
            grants: [
                { key: 'app:com.apple.Notes', createdAt: 1_000, expiresAt: 1_000 + REMOTE_GRANT_TTL_MS },
                { key: 'clipboard:clipboard_read', createdAt: 1_000, expiresAt: 1_000 + REMOTE_GRANT_TTL_MS },
                { key: 'tool:mcp__fake__send_mail', createdAt: 61_000, expiresAt: 61_000 + REMOTE_GRANT_TTL_MS },
            ],
        });
    });

    it('leaves expired grants out of the list', async () => {
        const time = clock();
        const grants = createPolicyGrantStore({ now: time.now, grantTtlMs: REMOTE_GRANT_TTL_MS });
        const rpc = registrar();
        registerToolPolicyGrantRpcs(rpc, grants);
        grants.grant(['app:com.apple.Notes']);
        time.advance(REMOTE_GRANT_TTL_MS);

        expect(await rpc.call(TOOL_POLICY_GRANTS_RPC, {})).toEqual({ grants: [] });
    });

    it('revokes one live grant and says whether there was one to revoke', async () => {
        const time = clock();
        const grants = createPolicyGrantStore({ now: time.now, grantTtlMs: REMOTE_GRANT_TTL_MS });
        const rpc = registrar();
        registerToolPolicyGrantRpcs(rpc, grants);
        grants.grant(['app:com.apple.Notes', 'app:com.apple.finder']);

        expect(await rpc.call(TOOL_POLICY_REVOKE_GRANT_RPC, { key: 'app:com.apple.Notes' })).toEqual({ revoked: true });
        expect(grants.view().hasGrant('app:com.apple.Notes')).toBe(false);
        expect(grants.view().hasGrant('app:com.apple.finder')).toBe(true);
        expect(await rpc.call(TOOL_POLICY_REVOKE_GRANT_RPC, { key: 'app:com.apple.Notes' })).toEqual({ revoked: false });
        expect(await rpc.call(TOOL_POLICY_REVOKE_GRANT_RPC, { key: 'tool:never-granted' })).toEqual({ revoked: false });

        time.advance(REMOTE_GRANT_TTL_MS);
        expect(await rpc.call(TOOL_POLICY_REVOKE_GRANT_RPC, { key: 'app:com.apple.finder' })).toEqual({ revoked: false });
    });

    it('refuses a revoke without a key, which the RPC layer returns as { error }', async () => {
        const grants = createPolicyGrantStore();
        const rpc = registrar();
        registerToolPolicyGrantRpcs(rpc, grants);
        grants.grant(['app:a']);

        for (const params of [{}, { key: '' }, { key: 7 }, null, 'app:a']) {
            await expect(rpc.call(TOOL_POLICY_REVOKE_GRANT_RPC, params)).rejects.toThrow('Invalid grant key');
        }
        expect(grants.list().map((record) => record.key)).toEqual(['app:a']);
    });
});

/**
 * One session's runtime, as runClaude and runCodex build it: the Claude hook (no origin), the stdio
 * bridge and the cua-driver shadow proxy all reach the same hook server, so they share one grant
 * store. Revoking over the session RPC makes the very next call through any of them ask again.
 */
describe('revoking a grant in a running session', () => {
    let runtime: ToolPolicyRuntime | null = null;
    let server: HookServer | null = null;
    afterEach(() => {
        server?.stop(); server = null;
        runtime?.dispose(); runtime = null;
    });

    function postFromHook(port: number, secret: string, body: unknown): Promise<{ kind: string }> {
        return new Promise((resolve, reject) => {
            const payload = Buffer.from(JSON.stringify(body));
            const req = request({
                host: '127.0.0.1', port, method: 'POST', path: '/hook/pre-tool-use',
                headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length, 'x-happy-hook-secret': secret },
            }, (res) => {
                const parts: Buffer[] = [];
                res.on('data', (part: Buffer) => parts.push(part));
                res.on('end', () => resolve(JSON.parse(Buffer.concat(parts).toString('utf8'))));
            });
            req.on('error', reject);
            req.end(payload);
        });
    }

    it('asks again through the hook, the bridge and the cua shadow proxy right after the grant is revoked', async () => {
        const asked: string[] = [];
        const approver: PolicyApprover = {
            requestPolicyApproval: async (request) => { asked.push(request.toolName); return { approved: true, policyGrant: 'session' }; },
        };
        const rpc = registrar();
        runtime = createToolPolicyRuntime({
            happyHomeDir: mkdtempSync(join(tmpdir(), 'policy-grant-control-')),
            sessionId: () => 'session-1',
            publishRecent: () => undefined,
            approver: () => approver,
            unattended: () => false,
            terminalPrompt: () => false,
            grantTtlMs: REMOTE_GRANT_TTL_MS,
            rpc,
        });
        // As runClaude wires it when the user's cua-driver runs behind the shadow proxy.
        const gate = handOffCuaToShadowProxy(runtime.gate, { terminalPrompt: () => false });
        server = await startHookServer({
            onSessionHook: () => undefined,
            preToolUse: { secret: runtime.secret, decide: gate.decide, toolsListed: gate.toolsListed },
        });
        const proxy = toolPolicyClientFromEnv(toolPolicyAdapterEnv({ port: server.port, secretFile: runtime.secretFile, server: CUA_DRIVER_SERVER }), 'cua-proxy')!;
        const bridge = toolPolicyClientFromEnv(toolPolicyAdapterEnv({ port: server.port, secretFile: runtime.secretFile, server: 'fake' }), 'bridge')!;
        const hookCall = (id: string) => postFromHook(server!.port, runtime!.secret, { tool_name: 'mcp__fake__send_mail', tool_input: { to: 'a@b.c' }, tool_use_id: id });

        // A person allows it for the conversation through the hook; the bridge then needs no prompt.
        expect(await hookCall('t1')).toMatchObject({ kind: 'allow' });
        expect(await bridge.decide({ tool: 'send_mail', args: { to: 'a@b.c' }, toolUseId: 't2' })).toEqual({ kind: 'pass' });
        expect(asked).toEqual(['mcp__fake__send_mail']);
        expect(await rpc.call(TOOL_POLICY_GRANTS_RPC, {})).toMatchObject({ grants: [{ key: 'tool:mcp__fake__send_mail' }] });

        expect(await rpc.call(TOOL_POLICY_REVOKE_GRANT_RPC, { key: 'tool:mcp__fake__send_mail' })).toEqual({ revoked: true });
        expect(await rpc.call(TOOL_POLICY_GRANTS_RPC, {})).toEqual({ grants: [] });

        expect(await bridge.decide({ tool: 'send_mail', args: { to: 'a@b.c' }, toolUseId: 't3' })).toEqual({ kind: 'allow' });
        expect(asked).toEqual(['mcp__fake__send_mail', 'mcp__fake__send_mail']);
        // That answer granted it again; revoke once more and the hook path asks too.
        await rpc.call(TOOL_POLICY_REVOKE_GRANT_RPC, { key: 'tool:mcp__fake__send_mail' });
        expect(await hookCall('t4')).toMatchObject({ kind: 'allow' });
        expect(asked).toHaveLength(3);

        // The shadow proxy's grants live in the same store.
        expect(await proxy.decide({ tool: 'clipboard_read', args: {}, toolUseId: 'c1' })).toEqual({ kind: 'allow' });
        expect(await proxy.decide({ tool: 'clipboard_read', args: {}, toolUseId: 'c2' })).toEqual({ kind: 'pass' });
        expect(asked).toHaveLength(4);
        expect(await rpc.call(TOOL_POLICY_REVOKE_GRANT_RPC, { key: 'clipboard:clipboard_read' })).toEqual({ revoked: true });
        expect(await proxy.decide({ tool: 'clipboard_read', args: {}, toolUseId: 'c3' })).toEqual({ kind: 'allow' });
        expect(asked).toEqual([...Array(3).fill('mcp__fake__send_mail'), 'mcp__cua-driver__clipboard_read', 'mcp__cua-driver__clipboard_read']);
    });

    /** Answers wait until the test gives them, so two prompts can be open at once. */
    function heldApprover() {
        const open: Array<(answer: PolicyApprovalAnswer) => void> = [];
        const approver: PolicyApprover = { requestPolicyApproval: () => new Promise((resolve) => { open.push(resolve); }) };
        return { approver, open };
    }

    function sendMailRuntime(approver: PolicyApprover, rpc: ReturnType<typeof registrar>) {
        runtime = createToolPolicyRuntime({
            happyHomeDir: mkdtempSync(join(tmpdir(), 'policy-grant-race-')),
            sessionId: () => 'session-1',
            publishRecent: () => undefined,
            approver: () => approver,
            unattended: () => false,
            terminalPrompt: () => false,
            grantTtlMs: null,
            rpc,
        });
        const gate = runtime.gate;
        return (id: string) => gate.decide({ toolName: 'mcp__fake__send_mail', toolInput: { to: 'a@b.c' }, toolUseId: id, origin: 'bridge' }, new AbortController().signal);
    }

    const SEND_MAIL = 'tool:mcp__fake__send_mail';
    const SESSION_ALLOW: PolicyApprovalAnswer = { approved: true, policyGrant: 'session' };

    it('lets a parallel answer that lands just before the revoke allow its own call but not grant again', async () => {
        const held = heldApprover();
        const rpc = registrar();
        const call = sendMailRuntime(held.approver, rpc);

        const a = call('a');
        const b = call('b');
        await vi.waitFor(() => expect(held.open).toHaveLength(2));
        held.open[0](SESSION_ALLOW);
        expect(await a).toEqual({ kind: 'allow' });
        expect(await rpc.call(TOOL_POLICY_GRANTS_RPC, {})).toMatchObject({ grants: [{ key: SEND_MAIL }] });

        // B's answer is in, but the gate has not read it yet when the revoke runs.
        held.open[1](SESSION_ALLOW);
        expect(await rpc.call(TOOL_POLICY_REVOKE_GRANT_RPC, { key: SEND_MAIL })).toEqual({ revoked: true });
        expect(await b).toEqual({ kind: 'allow' });
        expect(await rpc.call(TOOL_POLICY_GRANTS_RPC, {})).toEqual({ grants: [] });

        const c = call('c');
        await vi.waitFor(() => expect(held.open).toHaveLength(3));
        held.open[2]({ approved: false, policyGrant: 'once' });
        expect(await c).toMatchObject({ kind: 'deny' });
    });

    it('does not grant from a prompt that was still waiting when the person revoked', async () => {
        const held = heldApprover();
        const rpc = registrar();
        const call = sendMailRuntime(held.approver, rpc);

        const a = call('a');
        const b = call('b');
        await vi.waitFor(() => expect(held.open).toHaveLength(2));
        held.open[0](SESSION_ALLOW);
        await a;
        expect(await rpc.call(TOOL_POLICY_REVOKE_GRANT_RPC, { key: SEND_MAIL })).toEqual({ revoked: true });
        // B's prompt stays open well past the revoke before the person answers it.
        await new Promise((resolve) => setTimeout(resolve, 20));
        held.open[1](SESSION_ALLOW);
        expect(await b).toEqual({ kind: 'allow' });
        expect(await rpc.call(TOOL_POLICY_GRANTS_RPC, {})).toEqual({ grants: [] });

        // A prompt asked after the revoke grants again: that is a new answer.
        const c = call('c');
        await vi.waitFor(() => expect(held.open).toHaveLength(3));
        held.open[2](SESSION_ALLOW);
        expect(await c).toEqual({ kind: 'allow' });
        expect(await rpc.call(TOOL_POLICY_GRANTS_RPC, {})).toMatchObject({ grants: [{ key: SEND_MAIL }] });
        expect(held.open).toHaveLength(3);
    });
});
