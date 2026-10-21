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
import { createPolicyGrantStore } from './grants';
import { createToolPolicyGate, type PolicyApprover, type PreToolUseCall } from './policyGate';
import { ABSENT_MACHINE_POLICY } from './rules';

const MODEL = 'haiku';
const SCRIPTS = resolve(__dirname, '../../scripts');
const FAKE_MCP = resolve(__dirname, '__fixtures__/fakeMcpServer.cjs');
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

async function runWithPolicy(approver: PolicyApprover | null, prompt: string) {
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
        unattended: false,
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
        toolPolicy: toolPolicyHookCommands({ execPath: process.execPath, scriptsDir: SCRIPTS, port: server.port, secretFile, policyFile: join(dir, 'tool-policy.json') }),
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
    it('blocks a high-risk MCP call in bypass mode when nobody can approve, and skips Saycode\'s own server', async () => {
        if (!await isClaudeAvailable(tmpdir())) return;
        const { decided, ran } = await runWithPolicy(null,
            'Call the tool mcp__fake__send_mail once with to=a@b.c. Then call mcp__happy__send_mail once with to=c@d.e. Do not retry. Report both results verbatim.');
        expect(decided).toContain('mcp__fake__send_mail');
        expect(decided.some((name) => name.startsWith('mcp__happy__'))).toBe(false);
        expect(ran).not.toContain('fake ');
        expect(ran).toContain('happy ');
    }, 180_000);

    it('runs the call once a person approves it', async () => {
        if (!await isClaudeAvailable(tmpdir())) return;
        const approver: PolicyApprover = { requestPolicyApproval: async () => ({ approved: true, policyGrant: 'once' }) };
        const { ran } = await runWithPolicy(approver, 'Call the tool mcp__fake__send_mail exactly once with to=a@b.c and report the result.');
        expect(ran).toContain('fake {"to":"a@b.c"}');
    }, 180_000);
});
