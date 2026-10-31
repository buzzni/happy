import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { query, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { createOrgRequirementsGate } from '@/orgRequirements/gate';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { createClaudeOrgRequirements } from './claudeOrgRequirements';
import { claudeRemoteLauncher } from './claudeRemoteLauncher';
import type { EnhancedMode } from './loop';
import type { Session } from './session';

vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
    ...await original<typeof import('@anthropic-ai/claude-agent-sdk')>(),
    query: vi.fn(),
}));

/*
 * The turn boundary of the remote launcher with the organization gate (codexcli-org-requirements
 * R10.2, R10.1): every batch is judged as it becomes the running turn. A refused one never reaches
 * the provider and still ends as a turn — the reason, then `failed` — and the next one runs, its mode
 * clipped to the ceiling.
 */

let home: string | null = null;
afterEach(() => { if (home) rmSync(home, { recursive: true, force: true }); home = null; });

describe('remote launcher under organization requirements', () => {
    it('refuses a batch on a model outside the set and runs the next one clipped to the ceiling', async () => {
        home = mkdtempSync(join(tmpdir(), 'launcher-org-'));
        const gate = createOrgRequirementsGate({
            agent: 'claude', happyHomeDir: home, serverUrl: 'https://s', accountKey: 'a',
            sessionId: () => 'org-launcher-test', projectHint: null, publish: () => {}, refresh: async () => {},
        });
        gate.onRequirements({ kind: 'response', status: 'ok', requirements: {
            schemaVersion: 1, companyId: 'c1', revision: 2, modelPolicyUpdatedAt: null, issuedAt: 1,
            items: {
                'permissions.mode': { kind: 'ceiling', max: 'default' },
                'ai.models': { kind: 'allowedSet', values: ['claude:claude-sonnet-5-5'], default: 'claude:claude-sonnet-5-5', source: 'organization' },
            },
        } });
        const orgRequirements = createClaudeOrgRequirements(gate, {
            normalizeModel: (model) => model,
            attendance: () => 'attended',
            initialPermissionMode: () => 'bypassPermissions',
        });

        const queue = new MessageQueue2<EnhancedMode>(hashObject);
        const handlers = new Map<string, () => Promise<unknown>>();
        const order: string[] = [];
        const client = {
            sessionId: 'org-launcher-test',
            rpcHandlerManager: { registerHandler: (name: string, handler: () => Promise<unknown>) => handlers.set(name, handler) },
            updateAgentState: vi.fn(), updateMetadata: vi.fn(), getMetadata: () => ({}),
            setClaudeRuntimeAccount: vi.fn(),
            sendClaudeSessionMessage: vi.fn((record: { type?: string; message?: { content?: Array<{ text?: string }> } }) => {
                if (record.type === 'assistant') order.push(`assistant:${record.message?.content?.[0]?.text ?? ''}`);
            }),
            sendStreamDelta: vi.fn(),
            setPendingTurnRequestId: vi.fn(), sendFinalAnswerForChannelTurn: vi.fn(),
            applyClaudeTurnResult: vi.fn(), noteContextUsageSignal: vi.fn(),
            closeClaudeSessionTurn: vi.fn((status: string) => order.push(`turn-end:${status}`)),
            sendSessionEvent: vi.fn(),
        };
        const launches: Options[] = [];
        const received: unknown[] = [];
        vi.mocked(query).mockImplementation(({ prompt, options }) => {
            launches.push(options!);
            const response = (async function* () {
                yield { type: 'system', subtype: 'init', session_id: '', tools: [], mcp_servers: [] };
                for await (const message of prompt as AsyncIterable<SDKUserMessage>) {
                    received.push(message.message.content);
                    order.push(`provider:${String(message.message.content)}`);
                    yield { type: 'result', subtype: 'success', result: '', is_error: false, uuid: `result-${received.length}` };
                    void handlers.get('switch')!();
                    return;
                }
            })();
            return Object.assign(response, { mcpServerStatus: async () => [], setPermissionMode: async () => {} }) as unknown as ReturnType<typeof query>;
        });

        queue.push('denied model', { permissionMode: 'bypassPermissions', model: 'claude-opus-5-5', orgModel: { requested: 'claude-opus-5-5', origin: 'explicit' } });
        queue.push('allowed model', { permissionMode: 'bypassPermissions', model: 'claude-sonnet-5-5', orgModel: { requested: 'claude-sonnet-5-5', origin: 'explicit' } });
        const session = {
            lessonReviewLifecycle: { controller: new AbortController(), completedAssistantTurns: 0 },
            cancelLessonReview: vi.fn(),
            sessionId: null, path: process.cwd(), queue, client, mcpServers: {},
            api: { push: () => ({ sendSessionNotification: vi.fn() }) },
            consumeOneTimeFlags: vi.fn(), onThinkingChange: vi.fn(),
            orgRequirements,
        } as unknown as Session;

        await claudeRemoteLauncher(session);

        // The refused batch never reached the provider; the next one did, in the clipped mode.
        expect(received).toEqual(['allowed model']);
        expect(launches).toHaveLength(1);
        expect(launches[0].permissionMode).toBe('default');
        // The refusal is its own turn in the transcript — the reason, then failed — ahead of the turn that ran.
        const transcript = order.filter((entry) => !entry.startsWith('provider:'));
        const refusal = transcript.findIndex((entry) => entry.startsWith('assistant:조직 정책이 허용하지 않는 모델'));
        expect(refusal).toBeGreaterThanOrEqual(0);
        expect(transcript.slice(refusal + 1)).toEqual(['turn-end:failed', 'turn-end:completed']);
    });

    it('does not let auto-routing raise a checked batch to a model the organization does not allow', async () => {
        home = mkdtempSync(join(tmpdir(), 'launcher-org-'));
        const gate = createOrgRequirementsGate({
            agent: 'claude', happyHomeDir: home, serverUrl: 'https://s', accountKey: 'a',
            sessionId: () => 'org-route-test', projectHint: null, publish: () => {}, refresh: async () => {},
        });
        gate.onRequirements({ kind: 'response', status: 'ok', requirements: {
            schemaVersion: 1, companyId: 'c1', revision: 2, modelPolicyUpdatedAt: null, issuedAt: 1,
            items: { 'ai.models': { kind: 'allowedSet', values: ['claude:claude-sonnet-5-5'], default: null, source: 'organization' } },
        } });
        const orgRequirements = createClaudeOrgRequirements(gate, { normalizeModel: (model) => model, attendance: () => 'attended', initialPermissionMode: () => 'default' });
        const queue = new MessageQueue2<EnhancedMode>(hashObject);
        const handlers = new Map<string, () => Promise<unknown>>();
        const launches: Options[] = [];
        vi.mocked(query).mockImplementation(({ prompt, options }) => {
            launches.push(options!);
            const response = (async function* () {
                yield { type: 'system', subtype: 'init', session_id: '', tools: [], mcp_servers: [] };
                for await (const _message of prompt as AsyncIterable<SDKUserMessage>) {
                    yield { type: 'result', subtype: 'success', result: '', is_error: false, uuid: 'result-1' };
                    void handlers.get('switch')!();
                    return;
                }
            })();
            return Object.assign(response, { mcpServerStatus: async () => [], setPermissionMode: async () => {} }) as unknown as ReturnType<typeof query>;
        });
        const client = {
            sessionId: 'org-route-test',
            rpcHandlerManager: { registerHandler: (name: string, handler: () => Promise<unknown>) => handlers.set(name, handler) },
            updateAgentState: vi.fn(), updateMetadata: vi.fn(), getMetadata: () => ({}),
            setClaudeRuntimeAccount: vi.fn(), sendClaudeSessionMessage: vi.fn(), sendStreamDelta: vi.fn(),
            setPendingTurnRequestId: vi.fn(), sendFinalAnswerForChannelTurn: vi.fn(),
            applyClaudeTurnResult: vi.fn(), noteContextUsageSignal: vi.fn(), closeClaudeSessionTurn: vi.fn(), sendSessionEvent: vi.fn(),
        };
        queue.push('routed', { permissionMode: 'default', model: 'claude-sonnet-5-5', orgModel: { requested: 'claude-sonnet-5-5', origin: 'explicit' } }, undefined, ['req-1']);
        const route = { model: 'claude-opus-5-5', effort: null };
        const session = {
            lessonReviewLifecycle: { controller: new AbortController(), completedAssistantTurns: 0 },
            cancelLessonReview: vi.fn(),
            sessionId: null, path: process.cwd(), queue, client, mcpServers: {},
            api: { push: () => ({ sendSessionNotification: vi.fn() }) },
            consumeOneTimeFlags: vi.fn(), onThinkingChange: vi.fn(),
            onModeResolved: vi.fn(() => route), onModeApplied: vi.fn(() => route),
            orgRequirements,
        } as unknown as Session;

        await claudeRemoteLauncher(session);

        expect(launches.map((launch) => launch.model)).toEqual(['claude-sonnet-5-5']);
    });
});
