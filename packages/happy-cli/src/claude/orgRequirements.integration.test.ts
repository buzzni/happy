/**
 * Real Claude Code under an organization permission ceiling (aplus-dev-studio-desktop
 * specs/codexcli-org-requirements T15): a person's turn asks for bypass, the organization caps the
 * mode at `default`, and the tool call must come back to a person as an approval request instead of
 * running unasked. The remote launcher, the gate, the Claude adapter and the permission handler are
 * the real ones; only the session transport is a stub. The person here declines, so nothing runs.
 *
 * Needs a logged-in Claude; skipped otherwise.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { query, type SDKMessage } from '@/claude/sdk';
import { createOrgRequirementsGate } from '@/orgRequirements/gate';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { createClaudeOrgRequirements } from './claudeOrgRequirements';
import { claudeRemoteLauncher } from './claudeRemoteLauncher';
import type { EnhancedMode } from './loop';
import type { Session } from './session';

const MODEL = 'haiku';

async function isClaudeAvailable(cwd: string): Promise<boolean> {
    try {
        const messages: SDKMessage[] = [];
        for await (const message of query({ prompt: 'Say exactly ready', options: { abort: AbortSignal.timeout(30_000), cwd, model: MODEL } })) messages.push(message);
        const result = messages.find((m) => m.type === 'result') as { result?: string } | undefined;
        return result?.result?.trim() === 'ready';
    } catch {
        console.log('[org-requirements-cli-test] Skipping: Claude query unavailable');
        return false;
    }
}

let dir: string | null = null;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

async function runBypassTurn(workdir: string, items: Record<string, unknown>) {
    const marker = join(workdir, 'marker');

    const gate = createOrgRequirementsGate({
        agent: 'claude', happyHomeDir: join(workdir, 'home'), serverUrl: 'https://s', accountKey: 'a',
        sessionId: () => 'org-ceiling-cli', projectHint: null, publish: () => {}, refresh: async () => {},
    });
    gate.onRequirements({ kind: 'response', status: 'ok', requirements: {
        schemaVersion: 1, companyId: 'c1', revision: 1, modelPolicyUpdatedAt: null, issuedAt: 1,
        items,
    } });
    const orgRequirements = createClaudeOrgRequirements(gate, {
        normalizeModel: (model) => model,
        attendance: () => 'attended',
        initialPermissionMode: () => 'bypassPermissions',
    });

    const queue = new MessageQueue2<EnhancedMode>(hashObject);
    const handlers = new Map<string, (params: unknown) => Promise<unknown>>();
    let agentState: { requests?: Record<string, { tool?: string }>; completedRequests?: Record<string, { status?: string }> } = {};
    const asked: string[] = [];
    let denied!: () => void;
    const deniedSeen = new Promise<void>((resolve) => { denied = resolve; });
    const client = {
        sessionId: 'org-ceiling-cli',
        rpcHandlerManager: { registerHandler: (name: string, handler: (params: unknown) => Promise<unknown>) => handlers.set(name, handler) },
        updateAgentState: (update: (state: typeof agentState) => typeof agentState) => {
            agentState = update(agentState);
            for (const [id, request] of Object.entries(agentState.requests ?? {})) {
                if (asked.includes(id)) continue;
                asked.push(id);
                // The person at Desktop declines; the model reads the denial and stops.
                queueMicrotask(() => { void handlers.get('permission')!({ id, approved: false, reason: `declined ${request.tool}` }); });
            }
        },
        updateMetadata: () => {}, getMetadata: () => ({}),
        setClaudeRuntimeAccount: () => {},
        // The model has read the person's denial: the measurement is complete.
        sendClaudeSessionMessage: (record: { type?: string; message?: { content?: unknown } }) => {
            const content = record.type === 'user' && Array.isArray(record.message?.content) ? record.message.content as Array<{ type?: string; is_error?: boolean }> : [];
            if (content.some((block) => block.type === 'tool_result' && block.is_error)) denied();
        },
        sendStreamDelta: () => {},
        setPendingTurnRequestId: () => {}, sendFinalAnswerForChannelTurn: () => {},
        applyClaudeTurnResult: () => {}, noteContextUsageSignal: () => {},
        closeClaudeSessionTurn: () => {},
        sendSessionEvent: () => {}, resetContextUsage: () => {}, sendTurnLatency: () => {},
        sendSessionProtocolMessage: () => {}, bindChannelPermissionWhenKnown: () => {},
        setTransientRetryPending: () => {}, noteInputQueueEmpty: () => {},
    };
    queue.push(`Use the Bash tool to run exactly this command once: touch ${marker}\nThen reply with the single word done.`, {
        permissionMode: 'bypassPermissions', model: MODEL, orgModel: { requested: null, origin: 'none' },
    });
    const session = {
        lessonReviewLifecycle: { controller: new AbortController(), completedAssistantTurns: 0 },
        cancelLessonReview: () => {},
        sessionId: null, path: workdir, queue, client, mcpServers: {},
        // The person's own settings (an `allow` rule) must not decide this measurement.
        managedSettingsLockdown: true,
        api: { push: () => ({ sendSessionNotification: () => {} }) },
        consumeOneTimeFlags: () => {}, onThinkingChange: () => {}, onSessionFound: () => {}, clearSessionId: () => {},
        orgRequirements,
    } as unknown as Session;

    const launched = claudeRemoteLauncher(session);
    // Done when the model read a denial, or when the command ran (no prompt at all).
    const ran = new Promise<void>((resolve) => { const poll = setInterval(() => { if (existsSync(marker)) { clearInterval(poll); resolve(); } }, 200); });
    await Promise.race([deniedSeen, ran, new Promise((_, reject) => setTimeout(() => reject(new Error('the turn neither asked nor ran')), 150_000))]);
    void handlers.get('switch')?.(null);
    await launched.catch(() => undefined);
    return { asked, agentState, ran: existsSync(marker) };
}

describe('organization permission ceiling with the real Claude CLI', () => {
    it('asks a person for a tool a bypass turn would have run unasked', async (ctx) => {
        dir = mkdtempSync(join(tmpdir(), 'org-ceiling-cli-'));
        if (!await isClaudeAvailable(dir)) ctx.skip();
        const result = await runBypassTurn(dir, { 'permissions.mode': { kind: 'ceiling', max: 'default' } });
        expect(result.asked.length).toBeGreaterThan(0);
        expect(Object.values(result.agentState.completedRequests ?? {}).some((request) => request.status === 'denied')).toBe(true);
        expect(result.ran).toBe(false);
    }, 200_000);

    it('runs the same bypass turn unasked when the organization sets no ceiling (control)', async (ctx) => {
        dir = mkdtempSync(join(tmpdir(), 'org-ceiling-cli-'));
        if (!await isClaudeAvailable(dir)) ctx.skip();
        const result = await runBypassTurn(dir, { 'autopilot.enabled': { kind: 'fixed', value: false } });
        expect(result.asked).toEqual([]);
        expect(result.ran).toBe(true);
    }, 200_000);
});
