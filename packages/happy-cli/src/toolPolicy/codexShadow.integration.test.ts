/**
 * Real `codex app-server` (the one on PATH) with approval policy `never` — Codex's yolo mode, where
 * no MCP approval ever reaches Happy — and a user `config.toml` that registers cua-driver (a
 * stand-in). Happy's client reads that entry with `config/read`, puts the shadow proxy in its
 * place, and the proxy asks the real session hook server and gate. `mcpServer/tool/call` drives the
 * thread's own MCP connection, so no model is involved.
 *
 * Proves for Codex what the plan rests on: the shadow entry replaces the user's command, and a
 * terminal keystroke is refused even though Codex itself asks nobody. Skipped without `codex`.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startHookServer, type HookServer } from '@/claude/utils/startHookServer';
import { CodexAppServerClient } from '@/codex/codexAppServerClient';
import { createToolPolicyAuditLog } from './audit';
import { CUA_DRIVER_SERVER, codexCuaShadowConfig } from './cuaShadow';
import { createPolicyGrantStore } from './grants';
import { toolPolicyAdapterEnv } from './policyClient';
import { createToolPolicyGate } from './policyGate';
import { ABSENT_MACHINE_POLICY } from './rules';

const FAKE_CUA = resolve(__dirname, '__fixtures__/fakeCuaServer.cjs');
const BRIDGE = resolve(__dirname, '../../bin/happy-mcp.mjs');
const SECRET = 'd'.repeat(64);

function codexAvailable(): boolean {
    try {
        return /codex-cli\s+0\.(1[0-9]{2}|[2-9][0-9]{2})/.test(execSync('codex --version', { encoding: 'utf8' }));
    } catch {
        return false;
    }
}

let server: HookServer | null = null;
let client: CodexAppServerClient | null = null;
const previousCodexHome = process.env.CODEX_HOME;
afterEach(async () => {
    await client?.disconnect().catch(() => undefined);
    client = null;
    server?.stop();
    server = null;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
});

describe.skipIf(!codexAvailable())('Codex cua-driver shadow (approval policy never)', () => {
    it('runs the user cua-driver behind the proxy and refuses a terminal keystroke', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'codex-shadow-'));
        const codexHome = join(dir, 'codex-home');
        const cwd = join(dir, 'project');
        mkdirSync(codexHome);
        mkdirSync(cwd);
        const marker = join(dir, 'cua-calls.log');
        writeFileSync(join(codexHome, 'config.toml'), [
            `[mcp_servers.${CUA_DRIVER_SERVER}]`,
            `command = ${JSON.stringify(process.execPath)}`,
            `args = [${JSON.stringify(FAKE_CUA)}]`,
            `[mcp_servers.${CUA_DRIVER_SERVER}.env]`,
            `FAKE_CUA_MARKER = ${JSON.stringify(marker)}`,
        ].join('\n'));
        process.env.CODEX_HOME = codexHome;
        const secretFile = join(dir, 'secret');
        writeFileSync(secretFile, SECRET, { mode: 0o600 });

        const asked: string[] = [];
        const gate = createToolPolicyGate({
            loadMachinePolicy: () => ABSENT_MACHINE_POLICY,
            // Every pid is the Terminal: a keystroke there is past its `click` grade (R5.3).
            resolver: { resolve: async () => ({ status: 'resolved', app: { pid: 11, bundleId: 'com.apple.Terminal', name: 'Terminal' } }) },
            grants: createPolicyGrantStore(),
            audit: createToolPolicyAuditLog({ path: join(dir, 'audit.jsonl'), sessionId: () => 's1' }),
            approver: () => ({ requestPolicyApproval: async (request) => { asked.push(request.toolName); return { approved: true, policyGrant: 'once' }; } }),
            unattended: () => false,
            platform: 'darwin',
        });
        server = await startHookServer({ onSessionHook: () => undefined, preToolUse: { secret: SECRET, decide: gate.decide, toolsListed: gate.toolsListed } });
        const policyEnv = toolPolicyAdapterEnv({ port: server.port, secretFile, server: CUA_DRIVER_SERVER });

        client = new CodexAppServerClient();
        // The same entry runCodex builds: the built `bin/happy-mcp.mjs` (the test run builds dist first).
        client.setCuaShadow((native) => codexCuaShadowConfig(native, { execPath: process.execPath, bridgeEntrypoint: BRIDGE, policyEnv }));
        await client.connect();
        const { threadId } = await client.startThread({ cwd, approvalPolicy: 'never', sandbox: 'danger-full-access', mcpServers: {} });
        const request = (client as unknown as { request: (method: string, params: unknown, timeout?: number) => Promise<any> }).request.bind(client);
        const call = (tool: string, args: Record<string, unknown>) => request('mcpServer/tool/call', { threadId, server: CUA_DRIVER_SERVER, tool, arguments: args }, 60_000);

        const typed = await call('type_text', { pid: 11, text: 'rm -rf ~' });
        expect(JSON.stringify(typed)).toContain('도구 정책으로 막힘');
        expect(JSON.stringify(typed)).toContain('Terminal');

        const clicked = await call('click', { pid: 11 });
        expect(JSON.stringify(clicked)).toContain('click done');
        expect(asked).toEqual(['mcp__cua-driver__click']);

        // The user's command ran behind the proxy (its env carried over), and only the allowed call reached it.
        expect(existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n') : []).toEqual(['click {"pid":11}']);
    });
});
