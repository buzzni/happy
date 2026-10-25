/**
 * Real Claude Code (the SDK-bundled build Happy launches) in `bypassPermissions` mode, with the
 * hook settings Happy generates, the real session hook server and the real gate. Proves the one
 * assumption the whole policy rests on (aplus-dev-studio specs/agent-tool-policy plan "리스크"):
 * a PreToolUse deny stops an `mcp__*` call even when permissions are bypassed.
 *
 * Needs a logged-in Claude; skipped otherwise.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startHookServer, type HookServer } from '@/claude/utils/startHookServer';
import { buildHookSettings, toolPolicyHookCommands } from '@/claude/utils/generateHookSettings';
import { resolveMachineLockdownPolicy } from '@/daemon/machineLockdownPolicy';
import { query, type SDKMessage } from '@/claude/sdk';
import { createToolPolicyAuditLog } from './audit';
import { handOffCuaToShadowProxy } from './claudeHook';
import { CUA_UPSTREAM_ENV_VAR } from './cuaProxy';
import { CUA_DRIVER_SERVER, claudeCuaShadowEntry } from './cuaShadow';
import { createPolicyGrantStore } from './grants';
import { toolPolicyAdapterEnv } from './policyClient';
import { createToolPolicyGate, type PolicyApprover, type PreToolUseCall } from './policyGate';
import { ABSENT_MACHINE_POLICY } from './rules';

const MODEL = 'haiku';
const SCRIPTS = resolve(__dirname, '../../scripts');
const FAKE_MCP = resolve(__dirname, '__fixtures__/fakeMcpServer.cjs');
const FAKE_CUA = resolve(__dirname, '__fixtures__/fakeCuaServer.cjs');
const BRIDGE = resolve(__dirname, '../../bin/happy-mcp.mjs');
const SECRET = 'c'.repeat(64);

let server: HookServer | null = null;
afterEach(() => { server?.stop(); server = null; });

async function collect(iterable: AsyncIterable<SDKMessage>): Promise<SDKMessage[]> {
    const messages: SDKMessage[] = [];
    for await (const message of iterable) messages.push(message);
    return messages;
}

async function isClaudeAvailable(cwd: string): Promise<boolean> {
    try {
        const messages = await collect(query({ prompt: 'Say exactly ready', options: { abort: AbortSignal.timeout(30_000), cwd, model: MODEL } }));
        const result = messages.find((m) => m.type === 'result') as { result?: string } | undefined;
        return result?.result?.trim() === 'ready';
    } catch {
        console.log('[tool-policy-cli-test] Skipping: Claude query unavailable');
        return false;
    }
}

async function runWithPolicy(approver: PolicyApprover | null, prompt: string, hookExecPath: string = process.execPath) {
    const dir = mkdtempSync(join(tmpdir(), 'policy-cli-'));
    const marker = join(dir, 'marker');
    const secretFile = join(dir, 'secret');
    writeFileSync(secretFile, SECRET, { mode: 0o600 });
    const decided: string[] = [];
    const gate = createToolPolicyGate({
        loadMachinePolicy: () => ABSENT_MACHINE_POLICY,
        resolver: { resolve: async () => ({ status: 'unresolved' }) },
        grants: createPolicyGrantStore(),
        audit: createToolPolicyAuditLog({ path: join(dir, 'audit.jsonl'), sessionId: () => null }),
        approver: () => approver,
        unattended: () => false,
    });
    server = await startHookServer({
        onSessionHook: () => undefined,
        preToolUse: { secret: SECRET, decide: (call: PreToolUseCall, signal) => { decided.push(call.toolName); return gate.decide(call, signal); } },
    });
    const settingsPath = join(dir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify(buildHookSettings({
        hookCommand: 'true',
        broadKillGuardCommand: `node "${join(SCRIPTS, 'broad_kill_guard.cjs')}"`,
        policy: resolveMachineLockdownPolicy({}),
        homeDir: dir,
        // The production command shape: the daemon's quoted execPath, not `node` from PATH.
        toolPolicy: toolPolicyHookCommands({ execPath: hookExecPath, scriptsDir: SCRIPTS, port: server.port, secretFile, policyFile: join(dir, 'tool-policy.json') }),
    })));
    const server_ = (name: string) => ({ command: process.execPath, args: [FAKE_MCP], env: { FAKE_MCP_MARKER: marker, FAKE_MCP_NAME: name } });
    const messages = await collect(query({
        prompt,
        options: {
            abort: AbortSignal.timeout(150_000),
            cwd: dir,
            model: MODEL,
            permissionMode: 'bypassPermissions',
            settingsPath,
            mcpServers: { fake: server_('fake'), happy: server_('happy') },
            strictMcpConfig: true,
        },
    }));
    return { messages, decided, ran: existsSync(marker) ? readFileSync(marker, 'utf8') : '' };
}

describe('tool policy with the real Claude CLI', () => {
    it('blocks a high-risk MCP call in bypass mode when nobody can approve, and skips Saycode\'s own server', async (ctx) => {
        if (!await isClaudeAvailable(tmpdir())) ctx.skip();
        const { decided, ran } = await runWithPolicy(null,
            'Call the tool mcp__fake__send_mail once with to=a@b.c. Then call mcp__happy__send_mail once with to=c@d.e. Do not retry. Report both results verbatim.');
        expect(decided).toContain('mcp__fake__send_mail');
        expect(decided.some((name) => name.startsWith('mcp__happy__'))).toBe(false);
        expect(ran).not.toContain('fake ');
        expect(ran).toContain('happy ');
    }, 180_000);

    it('runs the call once a person approves it', async (ctx) => {
        if (!await isClaudeAvailable(tmpdir())) ctx.skip();
        const approver: PolicyApprover = { requestPolicyApproval: async () => ({ approved: true, policyGrant: 'once' }) };
        const { ran } = await runWithPolicy(approver, 'Call the tool mcp__fake__send_mail exactly once with to=a@b.c and report the result.');
        expect(ran).toContain('fake {"to":"a@b.c"}');
    }, 180_000);

    it('hands the model the person\'s reason when they decline (aplus-dev-studio specs/permission-deny-reason)', async (ctx) => {
        if (!await isClaudeAvailable(tmpdir())) ctx.skip();
        const approver: PolicyApprover = { requestPolicyApproval: async () => ({ approved: false, policyGrant: 'once', userReason: '비용이 커요 (r7731)' }) };
        const { messages, ran } = await runWithPolicy(approver,
            'Call the tool mcp__fake__send_mail exactly once with to=a@b.c. Do not retry. Report the result verbatim.');
        const denied = messages.flatMap((m) => m.type === 'user' && Array.isArray(m.message.content) ? m.message.content : [])
            .flatMap((block) => block.type === 'tool_result' && block.is_error ? [JSON.stringify(block.content)] : []);
        expect(denied.some((text) => text.includes('우회하지 마라') && text.includes("User's reason: 비용이 커요 (r7731)"))).toBe(true);
        expect(ran).not.toContain('fake ');
    }, 180_000);

    it('blocks the call when the forwarder cannot even start', async (ctx) => {
        // The forwarder fails closed only once it runs. A hook command that never starts (the
        // daemon's node gone after an upgrade) is left to Claude's `onFailure: "block"`, which the
        // bundled Claude honours from 2.1.295 (2.1.285 ran the call; specs/agent-tool-policy "S1 실측").
        if (!await isClaudeAvailable(tmpdir())) ctx.skip();
        // A person would approve: only the hook that never started can be what stops the call.
        const approver: PolicyApprover = { requestPolicyApproval: async () => ({ approved: true, policyGrant: 'once' }) };
        const { messages, decided, ran } = await runWithPolicy(approver,
            'Call the tool mcp__fake__send_mail exactly once with to=a@b.c. Do not retry. Report the result verbatim.',
            join(tmpdir(), 'happy-missing-node', 'node'));
        const blocked = messages.flatMap((m) => m.type === 'user' && Array.isArray(m.message.content) ? m.message.content : [])
            .filter((block) => block.type === 'tool_result' && block.is_error && JSON.stringify(block.content).includes('onFailure'));
        expect(blocked.length).toBeGreaterThan(0);
        expect(decided).toEqual([]);
        expect(ran).not.toContain('fake ');
    }, 180_000);
});

/**
 * I1b: the user's cua-driver behind the shadow proxy, as runClaude wires it in remote (SDK) mode —
 * the hook steps aside for `mcp__cua-driver__*` and the proxy decides, with the pid of the snapshot
 * that issued an `element_token`.
 */
describe('cua-driver shadow proxy with the real Claude CLI', () => {
    it('refuses a keystroke into the Terminal named only by an element token, deciding it once', async (ctx) => {
        if (!await isClaudeAvailable(tmpdir())) ctx.skip();
        const dir = mkdtempSync(join(tmpdir(), 'policy-shadow-cli-'));
        const marker = join(dir, 'cua-calls.log');
        const secretFile = join(dir, 'secret');
        writeFileSync(secretFile, SECRET, { mode: 0o600 });
        const decided: string[] = [];
        const asked: string[] = [];
        const gate = handOffCuaToShadowProxy(createToolPolicyGate({
            loadMachinePolicy: () => ABSENT_MACHINE_POLICY,
            resolver: { resolve: async (request) => request.kind === 'pid' && request.pid === 11
                ? { status: 'resolved', app: { pid: 11, bundleId: 'com.apple.Terminal', name: 'Terminal' } }
                : { status: 'unresolved' } },
            grants: createPolicyGrantStore(),
            audit: createToolPolicyAuditLog({ path: join(dir, 'audit.jsonl'), sessionId: () => null }),
            approver: () => ({ requestPolicyApproval: async (request) => { asked.push(request.toolName); return { approved: false, policyGrant: 'once' }; } }),
            unattended: () => false,
            platform: 'darwin',
        }), { terminalPrompt: () => false });
        server = await startHookServer({
            onSessionHook: () => undefined,
            preToolUse: {
                secret: SECRET,
                decide: async (call: PreToolUseCall, signal) => {
                    const verdict = await gate.decide(call, signal);
                    decided.push(`${call.origin ?? 'hook'} ${call.toolName} ${verdict.kind}`);
                    return verdict;
                },
                toolsListed: gate.toolsListed,
            },
        });
        const settingsPath = join(dir, 'settings.json');
        writeFileSync(settingsPath, JSON.stringify(buildHookSettings({
            hookCommand: 'true',
            broadKillGuardCommand: `node "${join(SCRIPTS, 'broad_kill_guard.cjs')}"`,
            policy: resolveMachineLockdownPolicy({}),
            homeDir: dir,
            toolPolicy: toolPolicyHookCommands({ execPath: process.execPath, scriptsDir: SCRIPTS, port: server.port, secretFile, policyFile: join(dir, 'tool-policy.json') }),
        })));
        const shadow = claudeCuaShadowEntry({
            execPath: process.execPath,
            bridgeEntrypoint: BRIDGE,
            upstream: { command: process.execPath, args: [FAKE_CUA], env: { FAKE_CUA_MARKER: marker } },
            policyEnv: toolPolicyAdapterEnv({ port: server.port, secretFile, server: CUA_DRIVER_SERVER }),
        });
        // As runClaude does: the entry only references the user's cua-driver env; Claude expands it.
        process.env[CUA_UPSTREAM_ENV_VAR] = JSON.stringify({ FAKE_CUA_MARKER: marker });
        await collect(query({
            prompt: 'Call mcp__cua-driver__get_window_state with pid=11 and window_id=1. Then call mcp__cua-driver__type_text with '
                + 'element_token set to the element_token from that result and text="ls". Do not retry, and do not pass pid to type_text. Report both results verbatim.',
            options: {
                abort: AbortSignal.timeout(150_000),
                cwd: dir,
                model: MODEL,
                permissionMode: 'bypassPermissions',
                settingsPath,
                mcpServers: { [CUA_DRIVER_SERVER]: shadow },
                strictMcpConfig: true,
            },
        }));
        delete process.env[CUA_UPSTREAM_ENV_VAR];
        // The marker path reached cua-driver only through the expanded reference.
        const ran = existsSync(marker) ? readFileSync(marker, 'utf8') : '';
        expect(ran).toContain('get_window_state {"pid":11');
        expect(ran).not.toContain('type_text');
        expect(decided).toContain('hook mcp__cua-driver__type_text pass');
        expect(decided).toContain('cua-proxy mcp__cua-driver__type_text deny');
        // Decided against the Terminal by its token: past the grade, no prompt to approve.
        expect(asked).toEqual([]);
    }, 180_000);
});
