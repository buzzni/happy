/**
 * The Claude hook path end to end, minus Claude: the real forwarder script talks to the real
 * session hook server, which runs the real gate. Only the approver (a person) and the target
 * resolver (the OS) are stand-ins.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MachineMetadataSchema } from '@/api/types';
import { startHookServer, type HookServer } from '@/claude/utils/startHookServer';
import { createToolPolicyAuditLog, type ToolPolicyAuditRecord } from './audit';
import { handOffCuaToShadowProxy, toolPolicyMachineCapability, toolPolicyMetadataUpdate, isToolPolicyEnabled } from './claudeHook';
import { createPolicyGrantStore } from './grants';
import { createToolPolicyGate, type HookVerdict, type PolicyApprovalAnswer, type PolicyApprover, type PreToolUseCall, type ToolPolicyGate } from './policyGate';
import { ABSENT_MACHINE_POLICY, BUILTIN_TABLES } from './rules';
import { createTargetResolver, type TargetResolver } from './targetResolver';

const FORWARDER = resolve(__dirname, '../../scripts/policy_hook_forwarder.cjs');
const SECRET = 'a'.repeat(64);

interface Asked { toolName: string; policy: { humanOnly: boolean; grantOffer: string }; signal: AbortSignal }

function approverAnswering(answer: PolicyApprovalAnswer | 'never', asked: Asked[]): PolicyApprover {
    return {
        requestPolicyApproval: (request) => {
            asked.push(request);
            if (answer === 'never') {
                return new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(new Error('withdrawn')), { once: true }));
            }
            return Promise.resolve(answer);
        },
    };
}

const NOTES_RESOLVER: TargetResolver = { resolve: async () => ({ status: 'resolved', app: { pid: 13, bundleId: 'com.apple.Notes', name: 'Notes' } }) };
const TERMINAL_RESOLVER: TargetResolver = { resolve: async () => ({ status: 'resolved', app: { pid: 11, bundleId: 'com.apple.Terminal', name: 'Terminal' } }) };

let server: HookServer | null = null;
afterEach(() => { server?.stop(); server = null; });

async function setup(options: { approver: PolicyApprover | null; resolver?: TargetResolver; unattended?: boolean; approvalTimeoutMs?: number; terminalPrompt?: boolean }) {
    const dir = mkdtempSync(join(tmpdir(), 'policy-hook-'));
    const secretFile = join(dir, 'secret');
    writeFileSync(secretFile, SECRET, { mode: 0o600 });
    const recent: ToolPolicyAuditRecord[][] = [];
    const grants = createPolicyGrantStore();
    const gate = createToolPolicyGate({
        loadMachinePolicy: () => ABSENT_MACHINE_POLICY,
        resolver: options.resolver ?? NOTES_RESOLVER,
        grants,
        audit: createToolPolicyAuditLog({ path: join(dir, 'audit.jsonl'), sessionId: () => 's1', publishRecent: (r) => recent.push(r) }),
        approver: () => options.approver,
        unattended: () => options.unattended ?? false,
        terminalPrompt: () => options.terminalPrompt ?? false,
        platform: 'darwin',
        approvalTimeoutMs: options.approvalTimeoutMs,
    });
    server = await startHookServer({ onSessionHook: () => undefined, preToolUse: { secret: SECRET, decide: gate.decide } });
    return { port: server.port, secretFile, grants, recent };
}

function runHook(args: string[], payload: unknown): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolvePromise) => {
        const child = spawn(process.execPath, [FORWARDER, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
        child.stdin.end(JSON.stringify(payload));
    });
}

function payload(toolName: string, toolInput: Record<string, unknown> = {}, toolUseId = 'toolu_1') {
    return { hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput, tool_use_id: toolUseId, permission_mode: 'bypassPermissions' };
}

function decision(stdout: string): { permissionDecision?: string; permissionDecisionReason?: string } {
    return stdout ? JSON.parse(stdout).hookSpecificOutput : {};
}

describe('Claude PreToolUse policy hook', () => {
    it('lets an allowed call through without a decision', async () => {
        const asked: Asked[] = [];
        const { port, secretFile } = await setup({ approver: approverAnswering({ approved: true, policyGrant: 'once' }, asked) });
        const result = await runHook([String(port), secretFile], payload('mcp__notion__notion-search'));
        expect(result).toMatchObject({ code: 0, stdout: '' });
        expect(asked).toHaveLength(0);
    });

    it('ask → approved for the conversation allows, and the next call needs no prompt', async () => {
        const asked: Asked[] = [];
        const { port, secretFile, grants } = await setup({ approver: approverAnswering({ approved: true, policyGrant: 'session' }, asked) });
        const first = await runHook([String(port), secretFile], payload('mcp__gmail__send_email', { to: 'x' }));
        expect(first.code).toBe(0);
        expect(decision(first.stdout).permissionDecision).toBe('allow');
        expect(asked[0]).toMatchObject({ toolName: 'mcp__gmail__send_email', policy: { humanOnly: true, grantOffer: 'session' } });
        expect(grants.list().map((g) => g.key)).toEqual(['tool:mcp__gmail__send_email']);

        const second = await runHook([String(port), secretFile], payload('mcp__gmail__send_email', { to: 'y' }, 'toolu_2'));
        expect(second).toMatchObject({ code: 0, stdout: '' });
        expect(asked).toHaveLength(1);
    });

    it('ask → approved "once" allows that call only', async () => {
        const asked: Asked[] = [];
        const { port, secretFile, grants } = await setup({ approver: approverAnswering({ approved: true, policyGrant: 'once' }, asked) });
        await runHook([String(port), secretFile], payload('mcp__gmail__send_email'));
        expect(grants.list()).toEqual([]);
        await runHook([String(port), secretFile], payload('mcp__gmail__send_email'));
        expect(asked).toHaveLength(2);
    });

    it('ask → declined denies with the R12 text and does not ask again for 5 minutes', async () => {
        const asked: Asked[] = [];
        const { port, secretFile, recent } = await setup({ approver: approverAnswering({ approved: false, policyGrant: 'once' }, asked) });
        const first = await runHook([String(port), secretFile], payload('mcp__gmail__send_email'));
        expect(first.code).toBe(0);
        expect(decision(first.stdout)).toMatchObject({ permissionDecision: 'deny' });
        expect(decision(first.stdout).permissionDecisionReason).toContain('거절');
        expect(decision(first.stdout).permissionDecisionReason).toContain('우회하지 마라');

        const second = await runHook([String(port), secretFile], payload('mcp__gmail__send_email'));
        expect(decision(second.stdout).permissionDecision).toBe('deny');
        expect(asked).toHaveLength(1);
        expect(recent[recent.length - 1].map((r) => r.reasonCode)).toEqual(['user_denied', 'recently_denied']);
    });

    it('blocks a policy-blocked call with the app, the alternative and the no-bypass line', async () => {
        const { port, secretFile } = await setup({ approver: null, resolver: TERMINAL_RESOLVER });
        const result = await runHook([String(port), secretFile], payload('mcp__cua-driver__type_text', { pid: 11, text: 'rm -rf ~' }));
        const reason = decision(result.stdout).permissionDecisionReason ?? '';
        expect(decision(result.stdout).permissionDecision).toBe('deny');
        expect(reason).toContain('Terminal');
        expect(reason).toContain('Bash');
        expect(reason).toContain('우회하지 마라');
    });

    it('withdraws and denies when nobody answers within the approval window', async () => {
        const asked: Asked[] = [];
        const { port, secretFile } = await setup({ approver: approverAnswering('never', asked), approvalTimeoutMs: 100 });
        const result = await runHook([String(port), secretFile], payload('mcp__cua-driver__click', { pid: 13 }));
        expect(decision(result.stdout).permissionDecision).toBe('deny');
        expect(decision(result.stdout).permissionDecisionReason).toContain('30분');
        expect(asked[0].signal.aborted).toBe(true);
    });

    it('blocks an ask when the run has nobody to answer', async () => {
        const asked: Asked[] = [];
        const { port, secretFile } = await setup({ approver: approverAnswering({ approved: true, policyGrant: 'once' }, asked), unattended: true });
        const result = await runHook([String(port), secretFile], payload('mcp__gmail__send_email'));
        expect(decision(result.stdout).permissionDecision).toBe('deny');
        expect(decision(result.stdout).permissionDecisionReason).toContain('승인할 사람이 없다');
        expect(asked).toHaveLength(0);
    });

    it('refuses an ask in a session with no Saycode approver and no terminal', async () => {
        const { port, secretFile } = await setup({ approver: null });
        const result = await runHook([String(port), secretFile], payload('mcp__gmail__send_email'));
        expect(decision(result.stdout)).toMatchObject({ permissionDecision: 'deny' });
        expect(decision(result.stdout).permissionDecisionReason).toContain('승인 요청을 띄울 수 없다');
    });

    // Cross review #2: in local (terminal) mode a person is at the Claude prompt; measured 2026-10-22 on
    // Claude 2.1.285 that a hook "ask" makes the TUI ask even under bypassPermissions (context.md).
    it('hands an ask to Claude\'s own terminal prompt in local mode, and still denies a block', async () => {
        const { port, secretFile, recent } = await setup({ approver: null, terminalPrompt: true, resolver: TERMINAL_RESOLVER });
        const asked = await runHook([String(port), secretFile], payload('mcp__gmail__send_email'));
        expect(asked.code).toBe(0);
        expect(decision(asked.stdout).permissionDecision).toBe('ask');
        expect(decision(asked.stdout).permissionDecisionReason).toContain('mcp__gmail__send_email');
        expect(recent[recent.length - 1].at(-1)).toMatchObject({ decision: 'ask', reasonCode: 'high_risk_write', outcome: 'terminal_prompt' });

        const blocked = await runHook([String(port), secretFile], payload('mcp__cua-driver__type_text', { pid: 11, text: 'x' }));
        expect(decision(blocked.stdout).permissionDecision).toBe('deny');
    });

    it('a run-once automation in local mode still refuses an ask', async () => {
        const { port, secretFile } = await setup({ approver: null, terminalPrompt: true, unattended: true });
        const result = await runHook([String(port), secretFile], payload('mcp__gmail__send_email'));
        expect(decision(result.stdout).permissionDecision).toBe('deny');
    });

    // Cross review #9: the server's own error paths are part of "every failure denies".
    it('fails closed when the gate throws (500) and when the payload has no tool name (400)', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'policy-hook-'));
        const secretFile = join(dir, 'secret');
        writeFileSync(secretFile, SECRET, { mode: 0o600 });
        server = await startHookServer({ onSessionHook: () => undefined, preToolUse: { secret: SECRET, decide: async () => { throw new Error('boom'); } } });
        const thrown = await runHook([String(server.port), secretFile], payload('mcp__notion__notion-search'));
        expect(thrown.code).toBe(2);
        expect(decision(thrown.stdout).permissionDecisionReason).toContain('500');
        const noName = await runHook([String(server.port), secretFile], { hook_event_name: 'PreToolUse', tool_input: {} });
        expect(noName.code).toBe(2);
        expect(decision(noName.stdout).permissionDecisionReason).toContain('400');
    });

    it('fails closed (deny + exit 2) when the session server is unreachable', async () => {
        const { secretFile } = await setup({ approver: null });
        const port = server!.port;
        server!.stop();
        server = null;
        await new Promise((r) => setTimeout(r, 50));
        const result = await runHook([String(port), secretFile], payload('mcp__notion__notion-search'));
        expect(result.code).toBe(2);
        expect(decision(result.stdout).permissionDecision).toBe('deny');
        expect(result.stderr).toContain('도구 정책으로 막힘');
    });

    it('fails closed on a wrong secret and on missing arguments', async () => {
        const { port } = await setup({ approver: null });
        const dir = mkdtempSync(join(tmpdir(), 'policy-hook-'));
        writeFileSync(join(dir, 'secret'), 'b'.repeat(64));
        expect((await runHook([String(port), join(dir, 'secret')], payload('mcp__notion__notion-search'))).code).toBe(2);
        expect((await runHook([], payload('mcp__notion__notion-search'))).code).toBe(2);
        expect((await runHook([String(port), join(dir, 'missing')], payload('mcp__notion__notion-search'))).code).toBe(2);
    });

    it('fails closed at its own deadline and the server stops waiting', async () => {
        const asked: Asked[] = [];
        const { port, secretFile } = await setup({ approver: approverAnswering('never', asked) });
        const result = await runHook([String(port), secretFile, '300'], payload('mcp__gmail__send_email'));
        expect(result.code).toBe(2);
        await new Promise((r) => setTimeout(r, 100));
        expect(asked[0].signal.aborted).toBe(true);
    });

    it('does not raise a prompt for a call whose hook is already gone', async () => {
        const asked: Asked[] = [];
        const controller = new AbortController();
        controller.abort();
        const gate = createToolPolicyGate({
            loadMachinePolicy: () => ABSENT_MACHINE_POLICY,
            resolver: NOTES_RESOLVER,
            grants: createPolicyGrantStore(),
            audit: createToolPolicyAuditLog({ path: join(mkdtempSync(join(tmpdir(), 'policy-abort-')), 'a.jsonl'), sessionId: () => null }),
            approver: () => approverAnswering({ approved: true, policyGrant: 'session' }, asked),
            unattended: () => false,
            platform: 'darwin',
        });
        await expect(gate.decide({ toolName: 'mcp__gmail__send_email', toolInput: {} }, controller.signal)).resolves.toMatchObject({ kind: 'deny', reasonCode: 'aborted' });
        expect(asked).toHaveLength(0);
    });

    it('reads the turn\'s attendance on every decision (codexcli-approval-session-binding R10a, Q9)', async () => {
        const asked: Asked[] = [];
        let unattended = true;
        const gate = createToolPolicyGate({
            loadMachinePolicy: () => ABSENT_MACHINE_POLICY,
            resolver: NOTES_RESOLVER,
            grants: createPolicyGrantStore(),
            audit: createToolPolicyAuditLog({ path: join(mkdtempSync(join(tmpdir(), 'policy-attendance-')), 'a.jsonl'), sessionId: () => null }),
            approver: () => approverAnswering({ approved: true, policyGrant: 'once' }, asked),
            unattended: () => unattended,
            platform: 'darwin',
        });
        const call = { toolName: 'mcp__gmail__send_email', toolInput: {} };
        await expect(gate.decide(call, new AbortController().signal)).resolves.toMatchObject({ kind: 'deny', reasonCode: 'unattended_no_approver' });
        expect(asked).toHaveLength(0);

        // A person wrote during the turn: the next ask waits for them.
        unattended = false;
        await expect(gate.decide(call, new AbortController().signal)).resolves.toEqual({ kind: 'allow' });
        expect(asked).toHaveLength(1);
    });

    it('leaves Saycode\'s own tools alone', async () => {
        const asked: Asked[] = [];
        const { port, secretFile } = await setup({ approver: approverAnswering({ approved: false, policyGrant: 'once' }, asked) });
        const result = await runHook([String(port), secretFile], payload('mcp__happy__send_message'));
        expect(result).toMatchObject({ code: 0, stdout: '' });
    });
});

describe('tool policy switch and capability', () => {
    it('is on by default and off with HAPPY_TOOL_POLICY=off', () => {
        expect(isToolPolicyEnabled({})).toBe(true);
        expect(isToolPolicyEnabled({ HAPPY_TOOL_POLICY: 'off' })).toBe(false);
        expect(toolPolicyMachineCapability({})).toEqual({ version: 1, enforcement: ['claude-hook', 'cua-proxy', 'codex-bridge', 'verb-words:all'], policyVersion: BUILTIN_TABLES.policyVersion });
        expect(toolPolicyMachineCapability({ HAPPY_TOOL_POLICY: 'OFF' })).toBeUndefined();
    });

    it('refreshes the capability on a machine registered before it, and removes it when switched off', () => {
        const stored: { host: string; platform: string; toolPolicy?: unknown } = { host: 'mac', platform: 'darwin' };
        const on = toolPolicyMachineCapability({});
        expect(toolPolicyMetadataUpdate(stored, on)).toEqual({ ...stored, toolPolicy: on });
        expect(toolPolicyMetadataUpdate({ ...stored, toolPolicy: on }, on)).toBeUndefined();
        expect(toolPolicyMetadataUpdate({ ...stored, toolPolicy: on }, undefined)).toEqual(stored);
        expect(toolPolicyMetadataUpdate(stored, undefined)).toBeUndefined();
        expect(toolPolicyMetadataUpdate(null, on)).toBeUndefined();
    });

    // aplus-dev-studio-desktop #2272: a machine announced before the table version (or under an older table) is refreshed.
    it('announces the table version and refreshes a capability without it', () => {
        const on = toolPolicyMachineCapability({})!;
        const { policyVersion: _version, ...unversioned } = on;
        const stored = { host: 'mac', toolPolicy: unversioned as unknown };
        expect(toolPolicyMetadataUpdate(stored, on)).toEqual({ host: 'mac', toolPolicy: on });
        expect(MachineMetadataSchema.shape.toolPolicy.parse(on)).toEqual(on); // not stripped on the way back in
    });
});

describe('decision latency', () => {
    it('keeps p95 under 50 ms with a cached target', async () => {
        const grants = createPolicyGrantStore();
        grants.grant(['app:com.apple.Notes']);
        const gate = createToolPolicyGate({
            loadMachinePolicy: () => ABSENT_MACHINE_POLICY,
            resolver: NOTES_RESOLVER,
            grants,
            audit: createToolPolicyAuditLog({ path: join(mkdtempSync(join(tmpdir(), 'policy-lat-')), 'a.jsonl'), sessionId: () => null }),
            approver: () => null,
            unattended: () => false,
            platform: 'darwin',
        });
        const samples: number[] = [];
        for (let i = 0; i < 200; i++) {
            const started = performance.now();
            await gate.decide({ toolName: 'mcp__cua-driver__click', toolInput: { pid: 13 } }, new AbortController().signal);
            samples.push(performance.now() - started);
        }
        samples.sort((a, b) => a - b);
        expect(samples[Math.floor(samples.length * 0.95)]).toBeLessThan(50);
    });

    it('treats a resolver slower than its deadline as unresolved (ask)', async () => {
        const asked: Asked[] = [];
        const gate = createToolPolicyGate({
            loadMachinePolicy: () => ABSENT_MACHINE_POLICY,
            resolver: createTargetResolver({ platform: 'darwin', deadlineMs: 30, exec: () => new Promise(() => undefined) }),
            grants: createPolicyGrantStore(),
            audit: createToolPolicyAuditLog({ path: join(mkdtempSync(join(tmpdir(), 'policy-lat-')), 'a.jsonl'), sessionId: () => null }),
            approver: () => approverAnswering({ approved: false, policyGrant: 'once' }, asked),
            unattended: () => false,
            platform: 'darwin',
        });
        await gate.decide({ toolName: 'mcp__cua-driver__click', toolInput: { pid: 13 } }, new AbortController().signal);
        expect(asked[0].policy).toMatchObject({ grantOffer: 'once' });
    });
});

describe('cua-driver calls while the shadow proxy runs', () => {
    function countingGate(verdict: HookVerdict): { gate: ToolPolicyGate; decided: PreToolUseCall[] } {
        const decided: PreToolUseCall[] = [];
        return { decided, gate: { decide: async (call) => { decided.push(call); return verdict; }, toolsListed: () => undefined } };
    }
    const signal = new AbortController().signal;
    const click = (origin?: 'cua-proxy', toolUseId = 'toolu_1'): PreToolUseCall => ({ toolName: 'mcp__cua-driver__click', toolInput: { pid: 12 }, toolUseId, ...(origin ? { origin } : {}) });

    it('remote mode: the hook steps aside and the proxy decides, once', async () => {
        const { gate, decided } = countingGate({ kind: 'deny', reason: 'no', reasonCode: 'x' });
        const handed = handOffCuaToShadowProxy(gate, { terminalPrompt: () => false });
        expect(await handed.decide(click(), signal)).toEqual({ kind: 'pass' });
        expect(await handed.decide(click('cua-proxy'), signal)).toMatchObject({ kind: 'deny' });
        expect(decided.map((call) => call.origin)).toEqual(['cua-proxy']);
    });

    it('local mode: the hook decides (it alone reaches the terminal prompt) and the proxy lets that same call through', async () => {
        const { gate, decided } = countingGate({ kind: 'ask', reason: 'confirm', reasonCode: 'first_app_use' });
        const handed = handOffCuaToShadowProxy(gate, { terminalPrompt: () => true });
        expect(await handed.decide(click(), signal)).toMatchObject({ kind: 'ask' });
        expect(await handed.decide(click('cua-proxy'), signal)).toEqual({ kind: 'pass' });
        // Another call the hook never saw is decided by the proxy.
        await handed.decide(click('cua-proxy', 'toolu_2'), signal);
        // And a call id is let through once only.
        await handed.decide(click('cua-proxy'), signal);
        expect(decided.map((call) => `${call.origin ?? 'hook'} ${call.toolUseId}`)).toEqual(['hook toolu_1', 'cua-proxy toolu_2', 'cua-proxy toolu_1']);
    });

    // Review #3: outside bypassPermissions Claude's own card comes first; the hook decides so one call gets one card.
    it('remote mode outside bypassPermissions: the hook decides and the proxy lets that call through', async () => {
        const { gate, decided } = countingGate({ kind: 'allow' });
        const handed = handOffCuaToShadowProxy(gate, { terminalPrompt: () => false });
        expect(await handed.decide({ ...click(), permissionMode: 'default' }, signal)).toEqual({ kind: 'allow' });
        expect(await handed.decide(click('cua-proxy'), signal)).toEqual({ kind: 'pass' });
        expect(await handed.decide({ ...click(undefined, 'toolu_3'), permissionMode: 'bypassPermissions' }, signal)).toEqual({ kind: 'pass' });
        expect(decided).toHaveLength(1);
    });

    it('local mode: a call the hook denied is not let through by id', async () => {
        const { gate, decided } = countingGate({ kind: 'deny', reason: 'no', reasonCode: 'x' });
        const handed = handOffCuaToShadowProxy(gate, { terminalPrompt: () => true });
        await handed.decide(click(), signal);
        expect(await handed.decide(click('cua-proxy'), signal)).toMatchObject({ kind: 'deny' });
        expect(decided).toHaveLength(2);
    });

    // Cross review #3: a hook-let-through id that never reached the proxy must not outlive the
    // provider run it came from — a later run may reuse the id for another call.
    it('forgets hook-let-through ids from an earlier provider generation', async () => {
        const { gate, decided } = countingGate({ kind: 'allow' });
        const handed = handOffCuaToShadowProxy(gate, { terminalPrompt: () => true });
        await handed.decide(click(), signal);
        handed.newProviderGeneration();
        await handed.decide(click('cua-proxy'), signal);
        expect(decided.map((call) => `${call.origin ?? 'hook'} ${call.toolUseId}`)).toEqual(['hook toolu_1', 'cua-proxy toolu_1']);
    });

    it('does not keep a verdict that arrives after the provider generation changed', async () => {
        let release!: () => void;
        const decided: PreToolUseCall[] = [];
        const gate: ToolPolicyGate = {
            decide: async (call) => {
                decided.push(call);
                if (!call.origin) await new Promise<void>((done) => { release = done; });
                return { kind: 'allow' };
            },
            toolsListed: () => undefined,
        };
        const handed = handOffCuaToShadowProxy(gate, { terminalPrompt: () => true });
        const hook = handed.decide(click(), signal);
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        handed.newProviderGeneration();
        release();
        await hook;
        await handed.decide(click('cua-proxy'), signal);
        expect(decided.map((call) => call.origin ?? 'hook')).toEqual(['hook', 'cua-proxy']);
    });

    it('lets an id through only for the tool the hook decided', async () => {
        const { gate, decided } = countingGate({ kind: 'allow' });
        const handed = handOffCuaToShadowProxy(gate, { terminalPrompt: () => true });
        await handed.decide(click(), signal);
        await handed.decide({ ...click('cua-proxy'), toolName: 'mcp__cua-driver__type_text' }, signal);
        expect(decided.map((call) => `${call.origin ?? 'hook'} ${call.toolName}`)).toEqual(['hook mcp__cua-driver__click', 'cua-proxy mcp__cua-driver__type_text']);
    });

    // Review bot (#910): the hook judged `pid`; the proxy alone knows the token's snapshot names
    // another app. That call is decided again, there (R5.1). A token-only call keeps the hook's
    // verdict: the hook judged an unknown target and a person answered for it.
    it('decides again at the proxy when the element token contradicts the pid the hook judged', async () => {
        const { gate, decided } = countingGate({ kind: 'allow' });
        const handed = handOffCuaToShadowProxy(gate, { terminalPrompt: () => true });
        const typed = (origin?: 'cua-proxy', elementPid?: number, toolUseId = 'toolu_1'): PreToolUseCall => ({
            toolName: 'mcp__cua-driver__type_text', toolInput: { pid: 12, element_token: 'tok-11', text: 'ls' }, toolUseId,
            ...(origin ? { origin } : {}), ...(elementPid !== undefined ? { elementPid } : {}),
        });
        await handed.decide(typed(), signal);
        await handed.decide(typed('cua-proxy', 11), signal);
        // Agreeing token: the hook's verdict stands.
        await handed.decide(typed(undefined, undefined, 'toolu_2'), signal);
        await handed.decide(typed('cua-proxy', 12, 'toolu_2'), signal);
        // Token only: the hook's verdict stands.
        await handed.decide({ ...click(), toolUseId: 'toolu_3', toolInput: { element_token: 'tok-11' } }, signal);
        await handed.decide({ ...click('cua-proxy', 'toolu_3'), toolInput: { element_token: 'tok-11' }, elementPid: 11 }, signal);
        expect(decided.map((call) => `${call.origin ?? 'hook'} ${call.toolUseId}`)).toEqual(['hook toolu_1', 'cua-proxy toolu_1', 'hook toolu_2', 'hook toolu_3']);
    });

    it('leaves every other tool to the gate as before', async () => {
        const { gate, decided } = countingGate({ kind: 'pass' });
        const handed = handOffCuaToShadowProxy(gate, { terminalPrompt: () => false });
        await handed.decide({ toolName: 'mcp__notion__notion-search', toolInput: {} }, signal);
        expect(decided).toHaveLength(1);
    });
});
