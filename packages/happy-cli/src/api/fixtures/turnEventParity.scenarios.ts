/** Run unchanged against extracted main and HEAD; only provider/network/ID clocks are scripted. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appendFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import axios from 'axios';
import { createEnvelope, sessionEnvelopeSchema, type SessionEnvelope, type SessionFollowupDaemon } from '@slopus/happy-wire';
import { ApiSessionClient } from '@/api/apiSession';
import { encodeBase64, encrypt, decrypt, decodeBase64 } from '@/api/encryption';
import type { Metadata } from '@/api/types';
import { claudeRemote } from '@/claude/claudeRemote';
import { claudeRemoteLauncher } from '@/claude/claudeRemoteLauncher';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { hashObject } from '@/utils/deterministicJson';
import { OutgoingMessageQueue } from '@/claude/utils/OutgoingMessageQueue';
import { SDKToLogConverter } from '@/claude/utils/sdkToLogConverter';
import { createSessionScanner } from '@/claude/utils/sessionScanner';
import { getProjectPath } from '@/claude/utils/path';
import { createOrderedTurnDispatcher, pendingRequestItem, finalAnswerItem, turnEndItem } from '@/channel/channelTurnOrdering';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { observeFollowupTurn, runSessionFollowupTick, createSessionFollowupSyncState,
    type SessionFollowupRunnerInput } from '@/daemon/automations/sessionFollowupRunner';
import { mapCodexMcpMessageToSessionEnvelopes } from '@/codex/utils/sessionProtocolMapper';
import { codexPlanEvent } from '@/codex/codexPlanEvent';
import { registerCodexSteerHandler } from '@/codex/codexSteerHandler';

const mocks = vi.hoisted(() => ({ io: vi.fn(), report: vi.fn(async () => ({ status: 'ok' })), id: 0, wire: 0, evidence: 0, start: 0, end: 0 }));
vi.mock('@paralleldrive/cuid2', () => ({ createId: () => `c${String(++mocks.id).padStart(23, '0')}` }));
vi.mock('@slopus/happy-wire', async importOriginal => {
    const actual = await importOriginal<typeof import('@slopus/happy-wire')>();
    return { ...actual, createEnvelope: (role: any, ev: any, opts: any = {}) => actual.createEnvelope(role, ev, {
        ...opts, time: 42, id: opts.id ?? (ev.t === 'turn-input-evidence'
            ? `e${String(++mocks.evidence).padStart(23, '0')}` : ev.t === 'turn-start'
                ? `s${String(++mocks.start).padStart(23, '0')}` : ev.t === 'turn-end'
                    ? `t${String(++mocks.end).padStart(23, '0')}` : `w${String(++mocks.wire).padStart(23, '0')}`),
    }) };
});
vi.mock('@anthropic-ai/claude-agent-sdk', async original => ({ ...await original<typeof import('@anthropic-ai/claude-agent-sdk')>(), query: vi.fn() }));
vi.mock('@/claude/utils/claudeCheckSession', () => ({ claudeCheckSession: () => true }));
vi.mock('socket.io-client', () => ({ io: mocks.io }));
vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }));
vi.mock('@/configuration', () => ({ configuration: { serverUrl: 'https://server.test', happyHomeDir: '/tmp/happy-test-home' } }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), debugLargeJson: vi.fn(), warn: vi.fn() } }));
vi.mock('@/api/rpc/RpcHandlerManager', () => ({ RpcHandlerManager: class {
    onSocketConnect = vi.fn(); onSocketDisconnect = vi.fn(); handleRequest = vi.fn(async () => ''); registerHandler = vi.fn();
} }));
vi.mock('@/modules/common/registerCommonHandlers', () => ({ registerCommonHandlers: vi.fn() }));
vi.mock('@/utils/time', () => ({ backoff: async <T>(callback: () => Promise<T>) => callback(),
    delay: vi.fn(async () => undefined), isSessionGoneError: () => false }));
vi.mock('@/utils/lidState', () => ({ shouldReconnect: () => true }));
vi.mock('@/daemon/controlClient', () => ({ notifyDaemonSessionRuntime: vi.fn(async () => ({ status: 'ok' })),
    notifyDaemonAutomationTurnResult: mocks.report, reportSetupTokenUsage: vi.fn(async () => {}),
    requestSetupTokenRebind: vi.fn(async () => ({ ok: true, environment: {
        CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-second', HAPPY_AI_AUTH_SETUP_TOKEN_BINDING: '{"account":"second"}',
    } })) }));

beforeEach(() => { vi.clearAllMocks(); vi.spyOn(Date, 'now').mockReturnValue(42); mocks.id = mocks.wire = mocks.evidence = mocks.start = mocks.end = 0; });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
type Source = 'consumed' | 'attachment' | 'sdk';
const review = JSON.stringify({ findings: [{ severity: 'medium', title: 'remaining issue' }] });

async function followup(events: SessionEnvelope[]) {
    const messages = events.map((content, index) => ({ seq: 11 + index, localId: null, content: { role: 'session', content } }));
    const row: SessionFollowupDaemon = {
        id: 'followup-1', projectId: 'project-1', projectWorkspaceDir: null, sessionId: 'session-1',
        machineAccountId: 'account-1', machineId: 'machine-1', revision: 1, generation: 2, step: 1,
        status: 'WAITING', totalRounds: 4, currentRound: 1, responseBoundarySeq: 10, lastObservedSeq: 10,
        pendingExpectedSeq: null, pendingLocalId: null, payloadVersion: 1,
        payloadCiphertext: Buffer.alloc(41, 1).toString('base64'), machineKeyVersion: 3,
        machineKeyEnvelope: Buffer.alloc(105, 1).toString('base64'),
    };
    const pending = { ...row, revision: 2, step: 2, status: 'DELIVERY_PENDING' as const,
        pendingExpectedSeq: 12, pendingLocalId: 'happy-followup:followup-1:2:2' };
    const transport = {
        sync: vi.fn(async () => ({ ok: true as const, value: { serverTime: 1, nextSeq: '1', hasMore: false,
            changes: [{ ...row, seq: '1', followupId: row.id, kind: 'UPSERT' as const }] } })),
        claim: vi.fn(async (body: any) => ({ ok: true as const, value: { claimToken: `claim-${body.step}`,
            followup: { ...(body.step === 2 ? pending : row), projectWorkspaceDir: '/workspace/project' } } })),
        evaluate: vi.fn(async (body: any) => ({ ok: true as const, value: body.decision === 'CONTINUE' ? pending : row })),
        deliver: vi.fn(async () => ({ ok: true as const, value: { idempotent: false, messageSeq: 13 } })),
    };
    const input: SessionFollowupRunnerInput = {
        transport,
        decryptPayload: () => ({ kind: 'existing-session-prompt', directory: '/workspace/project',
            prompt: 'Review again and return JSON.', evaluator: { kind: 'review-findings-v1' } }),
        resolveSession: () => ({ sessionId: 'session-1', directory: '/workspace/project',
            encryptionKey: new Uint8Array(32), encryptionVariant: 'dataKey', live: true }),
        sameDirectory: async (a, b) => a === b,
        fetchMessages: async () => messages.map(m => ({ seq: m.seq, localId: null, contentCiphertext: JSON.stringify(m.content) })),
        decryptMessage: (_binding, ciphertext) => JSON.parse(ciphertext), encryptUserMessage: () => 'ZW5jcnlwdGVk',
        ensureSessionRunning: async () => ({ ok: true }),
    };
    await runSessionFollowupTick(input, createSessionFollowupSyncState());
    const observation = observeFollowupTurn(messages);
    return { complete: observation.complete, failed: observation.failed, userIntervened: observation.userIntervened,
        evaluations: transport.evaluate.mock.calls.map(([body]) => ({ decision: body.decision, terminalCode: body.terminalCode ?? null })),
        delivered: transport.deliver.mock.calls.length };
}

async function harness(capability: boolean, outbox = false, scheduled = false) {
    // Explicit consumer opt-in; the OFF replay leaves it unset for every scenario.
    const enabled = capability && process.env.T2RT_PARITY_EVIDENCE !== 'off';
    vi.stubEnv('HAPPY_INPUT_EVIDENCE', enabled ? '1' : undefined);
    const handlers = new Map<string, Array<(value: any) => void>>();
    mocks.io.mockReturnValue({ connected: true, connect: vi.fn(), off: vi.fn(), emit: vi.fn(),
        on: vi.fn((event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler])),
        timeout: vi.fn(function (this: unknown) { return this; }), emitWithAck: vi.fn(async () => ({ result: 'error' })),
        volatile: { emit: vi.fn() }, close: vi.fn() });
    const session = { id: 'test-session-id', seq: 0, metadata: { path: '/tmp', host: 'localhost', homeDir: '/home/user',
        happyHomeDir: '/home/user/.happy', happyLibDir: '/home/user/.happy/lib', happyToolsDir: '/home/user/.happy/tools' } as Metadata,
        metadataVersion: 0, agentState: null, agentStateVersion: 0, encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' as const };
    const client = new ApiSessionClient('fake-token', session);
    // These additive methods do not exist on main; absence must not change the stimulus.
    const evidenceClient = client as any;
    let metadata = session.metadata;
    vi.spyOn(client, 'updateMetadata').mockImplementation(update => { metadata = update(metadata); });
    evidenceClient.configureInputQueue?.(new MessageQueue2<string>(x => x), 'remote', enabled);
    vi.spyOn(evidenceClient.sendSync, 'invalidate').mockImplementation(() => {});
    const events: SessionEnvelope[] = [];
    const realEnqueue = evidenceClient.enqueueMessage.bind(client);
    vi.spyOn(evidenceClient, 'enqueueMessage').mockImplementation((value: any, invalidate: any, localId: any) => {
        if (value.role === 'session') events.push(value.content);
        if (outbox) realEnqueue(value, invalidate, localId);
    });
    if (scheduled) {
        client.onUserMessage(vi.fn());
        const content = encodeBase64(encrypt(session.encryptionKey, 'legacy', { role: 'user',
            content: { type: 'text', text: 'Report' }, localKey: 'happy-automation:run-v11', meta: { sentFrom: 'automation' } }));
        for (const handler of handlers.get('update') ?? []) handler({ id: 'upd-1', seq: 1, createdAt: 1,
            body: { t: 'new-message', sid: session.id, message: { id: 'msg-1', seq: 1, localId: null,
                content: { t: 'encrypted', c: content }, createdAt: 1, updatedAt: 1 } } });
    }
    const queue = new OutgoingMessageQueue(createOrderedTurnDispatcher({
        observeClaudeBackgroundInput: msg => evidenceClient.observeClaudeBackgroundInput?.(msg),
        setPendingTurnRequestId: id => client.setPendingTurnRequestId(id),
        setPendingInputEvidence: batch => evidenceClient.startClaudeInputEvidence?.(batch),
        sendFinalAnswerForChannelTurn: text => client.sendFinalAnswerForChannelTurn(text),
        sendStructuredOutput: value => client.sendStructuredOutput(value),
        closeClaudeSessionTurn: status => client.closeClaudeSessionTurn(status), bindChannelPermission: () => {},
        sendClaudeSessionMessage: msg => client.sendClaudeSessionMessage(msg as any),
    }));
    const converter = new SDKToLogConverter({ sessionId: 'sdk-session', cwd: '/workspace', gitBranch: 'main' });
    const sdk = (msg: any) => { const log = converter.convert(msg); if (log) queue.enqueue(log); };
    const batch = (id: string, requestId: string | null = null) => queue.enqueue(pendingRequestItem(requestId, {
        inputs: [{ kind: 'rest', serverMessageId: id, serverSeq: 1 }], inputCount: 1,
    }));
    const answer = async (text: string) => { queue.enqueue(finalAnswerItem(text)); await queue.flush(); };
    const assistant = (text: string) => sdk({ type: 'assistant', uuid: text, parent_tool_use_id: null,
        message: { role: 'assistant', content: [{ type: 'text', text }] } });
    const end = async () => { queue.enqueue(turnEndItem('completed')); await queue.flush(); };
    const dir = await mkdtemp(join(tmpdir(), 't2rt-parity-'));
    const oldConfig = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = dir;
    const project = getProjectPath(dir);
    await mkdir(project, { recursive: true });
    let scanned = 0, file = 0;
    const scanner = await createSessionScanner({ sessionId: null, workingDirectory: dir,
        onMessage: msg => { client.sendClaudeSessionMessage(msg); scanned++; } });
    const consume = async (source: Source, known = false) => {
        const task = known ? 'job' : 'unknown', tool = known ? 'launch' : 'unknown-tool';
        if (source === 'sdk') {
            sdk({ type: 'system', subtype: 'task_notification', task_id: task, tool_use_id: tool,
                run_id: 'run-1', status: 'completed', output_file: '', summary: 'done' });
            await queue.flush(); return;
        }
        const text = `<task-notification><task-id>${task}</task-id><tool-use-id>${tool}</tool-use-id><status>completed</status></task-notification>`;
        const row = source === 'attachment' ? { type: 'attachment', uuid: `notification-${file}`, attachment: {
            type: 'queued_command', commandMode: 'task-notification', runId: 'run-1', prompt: text,
        } } : { type: 'user', uuid: `notification-${file}`, origin: { kind: 'task-notification', runId: 'run-1' },
            message: { role: 'user', content: text } };
        const sessionId = `11111111-2222-4333-8444-${String(++file).padStart(12, '0')}`, before = scanned;
        await writeFile(join(project, `${sessionId}.jsonl`), JSON.stringify(row) + '\n');
        await scanner.onNewSession(sessionId);
        await vi.waitFor(() => expect(scanned).toBe(before + 1));
    };
    const evidence = () => events.filter(e => e.ev.t === 'turn-input-evidence' && !e.turn).map(e => e.ev);
    const routing = () => {
        const state = evidenceClient.claudeSessionProtocolState;
        return { current: state.currentTurnId, request: state.currentRequestId ?? null, pending: state.pendingRequestId ?? null,
            launches: [...(state.backgroundTaskRequestIds ?? [])] };
    };
    return { client, enabled, events, queue, sdk, batch, answer, assistant, end, consume, evidence, routing,
        async result(name: string, extra: object = {}) {
            for (const event of events) sessionEnvelopeSchema.parse(event);
            // SDKToLogConverter assigns random transcript UUIDs in both revisions.
            // Preserve their sharing/order bijectively; native envelope/turn IDs stay exact.
            const transcriptIds = new Map<string, string>();
            const wire = events.map(event => {
                if (!event.claudeUuid || !/^[0-9a-f-]{36}$/.test(event.claudeUuid)) return event;
                if (!transcriptIds.has(event.claudeUuid)) transcriptIds.set(event.claudeUuid, `transcript-${transcriptIds.size + 1}`);
                return { ...event, claudeUuid: transcriptIds.get(event.claudeUuid)! };
            });
            const turns = events.filter(e => e.ev.t === 'turn-start' || e.ev.t === 'turn-end').map(e => {
                const { inputEvidence: _inputEvidence, ...ev } = e.ev as any;
                return { id: e.id, role: e.role, turn: e.turn, ev };
            });
            const record = { name, turns, wire, metadata, routing: routing(), reports: mocks.report.mock.calls,
                followup: await followup(events), evidence: evidence(),
                finals: events.filter(e => e.ev.t === 'final-answer').map(e => ({ turn: e.turn, ev: e.ev })), ...extra };
            await appendFile(process.env.T2RT_PARITY_OUTPUT!, JSON.stringify(record) + '\n');
        },
        async cleanup() {
            await scanner.cleanup(); queue.destroy(); await client.close();
            if (oldConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = oldConfig;
            await rm(dir, { recursive: true, force: true });
        },
    };
}

// T2RT-31: actual socket observations and metadata CAS writes, including every
// subsequent OFF mode transition. Main has no input-mode hook and publishes nothing.
if (process.env.T2RT_PARITY_EVIDENCE === 'off') {
    for (const flavor of ['claude', 'codex']) for (const initialMode of ['local', 'remote'] as const) {
        it(`OFF marker-only ${flavor} starting ${initialMode}`, async () => {
            const handlers = new Map<string, Array<(value: any) => void>>();
            const session = { id: 'marker-session', seq: 0,
                metadata: { path: '/tmp', host: 'localhost', flavor } as Metadata,
                metadataVersion: 0, agentState: null, agentStateVersion: 0,
                encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' as const };
            let metadata = session.metadata, version = 0;
            const metadataWrites: Metadata[] = [], transitions: Metadata[] = [];
            const socket = { connected: true, connect: vi.fn(), off: vi.fn(), emit: vi.fn(), close: vi.fn(),
                volatile: { emit: vi.fn() }, timeout() { return this; },
                on: (event: string, handler: (value: any) => void) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
                emitWithAck: vi.fn(async (_event: string, request: any) => {
                    expect(request.expectedVersion).toBe(version);
                    metadata = decrypt(session.encryptionKey, 'legacy', decodeBase64(request.metadata)) as Metadata;
                    metadataWrites.push(metadata);
                    return { result: 'success', version: ++version, metadata: request.metadata };
                }) };
            mocks.io.mockReturnValue(socket);
            const client = new ApiSessionClient('fake-token', session);
            const host = client as any;
            try {
                host.configureInputQueue?.(new MessageQueue2<string>(x => x), initialMode, false);
                metadata = { ...metadata, inputEvidenceEnabled: true };
                for (const handler of handlers.get('update') ?? []) handler({ body: { t: 'update-session', sid: session.id,
                    metadata: { version: ++version, value: encodeBase64(encrypt(session.encryptionKey, 'legacy', metadata)) } } });
                for (const mode of ['local', 'transitioning', 'remote', 'local', 'remote']) {
                    host.setInputMode?.(mode);
                    await new Promise(resolve => setImmediate(resolve));
                    transitions.push(structuredClone(client.getMetadata()!));
                }
                await appendFile(process.env.T2RT_PARITY_OUTPUT!, JSON.stringify({ name: `off-marker-${flavor}-${initialMode}`,
                    turns: [], wire: [], metadata, metadataWrites, transitions }) + '\n');
            } finally { await client.close(); }
        });
    }
}

for (const capability of [false, true]) {
    for (const scenario of ['codex-ordinary', 'codex-channel', 'plan-empty', 'plan-nonempty', 'claude-ordinary',
        'claude-channel', 'permission', 'question', 'steer', 'codex-retry', 'claude-retry', 'metadata', 'guards'] as const) {
        it(`full envelope ${scenario} capability=${capability}`, async () => {
            const h = await harness(capability);
            const client = h.client as any;
            const state: any = { currentTurnId: null, pendingRequestId: scenario === 'codex-channel' ? 'channel-A' : null };
            const codex = (message: any) => {
                const mapped = mapCodexMcpMessageToSessionEnvelopes(message, state, h.enabled);
                Object.assign(state, { currentTurnId: mapped.currentTurnId, currentProviderTurnId: mapped.currentProviderTurnId,
                    startedSubagents: mapped.startedSubagents, activeSubagents: mapped.activeSubagents,
                    providerSubagentToSessionSubagent: mapped.providerSubagentToSessionSubagent });
                for (const envelope of mapped.envelopes) h.client.sendSessionProtocolMessage(envelope);
            };
            try {
                if (scenario.startsWith('plan-')) {
                    const plan = codexPlanEvent({ plan: scenario === 'plan-empty' ? [] : [{ step: 'finish', status: 'completed' }] }, h.enabled);
                    if (plan) h.client.sendSessionProtocolMessage(createEnvelope('agent', plan));
                } else if (scenario.startsWith('codex-') || scenario === 'steer') {
                    client.setPendingInputEvidence?.({ inputs: [{ kind: 'rest', serverMessageId: 'A', serverSeq: 1 }], inputCount: 1 });
                    codex({ type: 'task_started', turn_id: 'provider-A' });
                    if (scenario === 'steer') {
                        let steer!: (params: Record<string, unknown>) => Promise<unknown>;
                        vi.mocked(h.client.rpcHandlerManager.registerHandler).mockImplementation((name, handler) => {
                            if (name === 'steer') steer = handler as any;
                        });
                        registerCodexSteerHandler({ client: { steerTurn: vi.fn(async () => {}) }, session: h.client,
                            protocolTurnId: () => state.currentTurnId, onFailure: vi.fn() });
                        await steer({ text: 'steer A' });
                    }
                    if (scenario === 'codex-retry') {
                        client.inputEvidence?.continuePending('codex-capacity');
                        codex({ type: 'task_complete', status: 'failed', turn_id: 'provider-A' });
                        client.setPendingInputEvidence?.({ inputs: [], inputCount: 0, continuation: client.inputEvidence?.takeContinuation() });
                        client.inputEvidence?.commitPending();
                        codex({ type: 'task_started', turn_id: 'provider-B' });
                    }
                    codex({ type: 'agent_message', phase: 'final_answer', message: 'done' });
                    codex({ type: 'task_complete', status: 'completed' });
                } else if (scenario === 'metadata') {
                    client.setInputSteerAvailable?.(true);
                    client.setInputMode?.('local'); client.setInputMode?.('remote');
                } else if (scenario === 'guards') {
                    const guard = { v: 1, targetSessionId: h.client.sessionId, expectedRuntimeId: client.runtimeId ?? 'base',
                        expectedMode: 'remote', expectedModeEpoch: client.inputGate?.modeEpoch ?? 1 };
                    const accept = (id: string, value: unknown) => client.admitInput?.({
                        ref: { kind: 'rest', serverMessageId: id, serverSeq: 1 }, guard: value,
                    }, true);
                    accept('accepted', guard); accept('malformed', null);
                    accept('stale', { ...guard, expectedModeEpoch: 0 });
                    client.setInputMode?.('local'); accept('changed', guard);
                } else {
                    h.batch('A', scenario === 'claude-channel' ? 'channel-A' : null);
                    if (scenario === 'permission' || scenario === 'question') {
                        const tool = scenario === 'question' ? 'AskUserQuestion' : 'Bash';
                        h.sdk({ type: 'assistant', message: { role: 'assistant', content: [
                            { type: 'tool_use', id: 'tool-A', name: tool, input: {} },
                        ] } });
                        await h.queue.flush();
                        client.recordPermissionInput?.('tool-A', tool, { id: 'tool-A', approved: true,
                            ...(scenario === 'question' ? { updatedInput: { answers: { question: 'yes' } } } : {}) })?.();
                        h.sdk({ type: 'user', message: { role: 'user', content: [
                            { type: 'tool_result', tool_use_id: 'tool-A', content: 'allowed' },
                        ] } });
                    } else h.assistant('working');
                    if (scenario === 'claude-retry') {
                        await h.queue.flush(); client.continueClaudeInputEvidence?.('claude-transient');
                        h.queue.enqueue(turnEndItem('failed')); await h.queue.flush();
                        const receipt = client.inputEvidence?.takeContinuation();
                        h.queue.enqueue(pendingRequestItem(null, { inputs: [], inputCount: 0,
                            continuation: receipt ? client.inputEvidence.claimContinuation(receipt) : undefined }));
                        h.assistant('recovered');
                    }
                    await h.answer('done'); await h.end();
                }
                await h.result(`full-${scenario}-${capability}`);
            } finally { await h.cleanup(); }
        });
    }

    for (const { failure, empty } of [
        { failure: 'exception', empty: false }, { failure: 'result', empty: false }, { failure: 'exception', empty: true },
    ] as const) it(`T20/24 account ${failure} empty=${empty} capability=${capability}`, async () => {
        const oldToken = process.env.CLAUDE_CODE_OAUTH_TOKEN, oldBinding = process.env.HAPPY_AI_AUTH_SETUP_TOKEN_BINDING;
        process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-first';
        process.env.HAPPY_AI_AUTH_SETUP_TOKEN_BINDING = '{"account":"first"}';
        const h = await harness(capability);
        const handlers = new Map<string, () => Promise<unknown>>();
        vi.mocked(h.client.rpcHandlerManager.registerHandler).mockImplementation((name, handler) => { handlers.set(name, handler as any); });
        vi.spyOn(h.client, 'updateAgentState').mockImplementation(() => undefined);
        const queue = new MessageQueue2<any>(hashObject);
        (h.client as any).configureInputQueue?.(queue, 'remote', process.env.HAPPY_INPUT_EVIDENCE === '1');
        let generation = 0;
        const prompts: unknown[] = [];
        vi.mocked(query).mockImplementation(({ prompt }: any) => {
            const n = ++generation;
            return Object.assign((async function* () {
                yield { type: 'system', subtype: 'init', session_id: '', tools: [], mcp_servers: [], apiKeySource: 'none' };
                for await (const input of prompt) {
                    prompts.push(input.message.content);
                    if (n === 1 || !empty) yield { type: 'assistant', uuid: `partial-${n}`, session_id: 'claude-1', parent_tool_use_id: null,
                        message: { id: `m-${n}`, role: 'assistant', model: 'claude-sonnet-5',
                            content: [{ type: 'text', text: n === 1 ? 'working before refusal' : 'recovered' }],
                            usage: { input_tokens: 1, output_tokens: 1 } } };
                    if (n === 1) {
                        yield { type: 'rate_limit_event', uuid: 'rl-1', session_id: 'claude-1', rate_limit_info: {
                            status: 'rejected', rateLimitType: 'five_hour', resetsAt: Math.floor(Date.now() / 1000) + 3600 } };
                        if (failure === 'exception') throw new Error('provider exited after account refusal');
                        yield { type: 'result', subtype: 'success', result: 'rate limited', is_error: true, uuid: 'r-1' };
                        return;
                    }
                    yield { type: 'result', subtype: 'success', result: empty ? '' : 'recovered', is_error: false, uuid: 'r-2' };
                    void handlers.get('switch')!();
                    return;
                }
            })(), { mcpServerStatus: async () => [], setPermissionMode: async () => {} }) as any;
        });
        queue.push('hello', { permissionMode: 'default', model: 'claude-sonnet-5' }, undefined, undefined, undefined, undefined,
            { ref: { kind: 'rest', serverMessageId: 'A', serverSeq: 1 } });
        try {
            await claudeRemoteLauncher({ lessonReviewLifecycle: { controller: new AbortController(), completedAssistantTurns: 0 },
                cancelLessonReview: vi.fn(), onAbort: vi.fn(), sessionId: 'claude-1', path: process.cwd(), queue, client: h.client,
                mcpServers: {}, api: { push: () => ({ sendSessionNotification: vi.fn() }) },
                consumeOneTimeFlags: vi.fn(), onThinkingChange: vi.fn() } as any);
            expect(generation).toBe(2); expect(prompts).toHaveLength(2);
            await h.result(`account-${empty ? 'empty-' : ''}${failure}-${capability}`, { prompts,
                sourceEvidence: (h.events.find(event => event.ev.t === 'turn-start')?.ev as any)?.inputEvidence,
                settledEvidence: (h.client as any).inputEvidence?.snapshot() });
        } finally {
            await h.cleanup();
            if (oldToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN; else process.env.CLAUDE_CODE_OAUTH_TOKEN = oldToken;
            if (oldBinding === undefined) delete process.env.HAPPY_AI_AUTH_SETUP_TOKEN_BINDING; else process.env.HAPPY_AI_AUTH_SETUP_TOKEN_BINDING = oldBinding;
        }
    }, 15_000);

    it(`evidence cannot control automation capability=${capability}`, async () => {
        const h = await harness(capability, false, true);
        try {
            h.batch('A'); h.assistant('mapped failure'); await h.queue.flush();
            (h.client as any).continueClaudeInputEvidence?.('claude-account-switch');
            h.queue.enqueue(turnEndItem('failed')); await h.queue.flush();
            await new Promise(resolve => setTimeout(resolve, 0));
            const reportsBeforeCancel = structuredClone(mocks.report.mock.calls);
            (h.client as any).inputEvidence?.cancelContinuation('cancelled');
            await h.result(`evidence-automation-${capability}`, { reportsBeforeCancel });
        } finally { await h.cleanup(); }
    });

    it(`T2RT-16 scanner rearm capability=${capability}`, async () => {
        const h = await harness(capability);
        try {
            h.batch('A', 'channel-A');
            h.sdk({ type: 'assistant', uuid: 'launch-A', message: { role: 'assistant', content: [
                { type: 'tool_use', id: 'launch', name: 'Bash', input: { command: 'sleep 10', run_in_background: true } },
            ] } });
            h.sdk({ type: 'user', message: { role: 'user', content: [
                { type: 'tool_result', tool_use_id: 'launch', content: 'Command running in background with ID: job.' },
            ] } });
            await h.end();
            const before = h.routing(); await h.answer('unmapped final'); expect(h.routing()).toEqual(before);
            await h.consume('attachment', true); await h.end();
            await h.result(`T16-${capability}`);
        } finally { await h.cleanup(); }
    }, 15_000);

    for (const scenario of [
        { source: 'consumed' as const, mapped: false, ordinary: false },
        { source: 'attachment' as const, mapped: false, ordinary: false },
        { source: 'sdk' as const, mapped: false, ordinary: false },
        { source: 'consumed' as const, mapped: true, ordinary: false },
        { source: 'consumed' as const, mapped: true, ordinary: true },
    ]) it(`T17/19 ${JSON.stringify(scenario)} capability=${capability}`, async () => {
        const h = await harness(capability);
        let ready = 0, next = 0, after = 0;
        try {
            vi.mocked(query).mockReturnValue({ setPermissionMode: vi.fn(), mcpServerStatus: vi.fn(async () => []),
                async *[Symbol.asyncIterator]() {
                    yield { type: 'system', subtype: 'background_tasks_changed', tasks: [
                        { task_id: 'job', task_type: 'local_agent', description: 'resumed work' },
                    ] };
                    yield { type: 'result', subtype: 'success', is_error: false, result: 'A initial final' };
                    await h.queue.flush();
                    if (!scenario.ordinary) { expect(ready).toBe(0); await h.consume(scenario.source); }
                    if (scenario.mapped) yield { type: 'assistant', uuid: 'F-text', parent_tool_use_id: null,
                        message: { role: 'assistant', content: [{ type: 'text', text: review }] } };
                    yield { type: 'system', subtype: 'background_tasks_changed', tasks: [] };
                    yield { type: 'result', subtype: 'success', is_error: false, result: 'F background final' };
                },
            } as any);
            await claudeRemote({ sessionId: null, path: process.cwd(), allowedTools: [], hookSettingsPath: '/tmp/synthetic-settings.json',
                exitAfterFirstTurn: !scenario.ordinary,
                nextMessage: async () => scenario.ordinary && next++ > 0 ? null : {
                    message: 'A', mode: { permissionMode: 'default' }, commitInput: () => { h.batch('A'); return true; },
                },
                afterTurn: async () => { if (scenario.ordinary && after++ === 0) { await h.queue.flush(); await h.consume('consumed'); } },
                onReady: () => { ready++; h.queue.enqueue(turnEndItem('completed')); },
                canCallTool: async () => ({ behavior: 'allow' }) as any, isAborted: () => false,
                onSessionFound: vi.fn(), onThinkingChange: vi.fn(),
                onMessage: msg => { if (msg.type === 'result') {
                    if (msg.subtype === 'success' && !msg.is_error) h.queue.enqueue(finalAnswerItem(msg.result));
                } else h.sdk(msg); },
            });
            await h.queue.flush();
            await h.result(`T17-19-${scenario.source}-${scenario.mapped}-${scenario.ordinary}-${capability}`, { ready });
        } finally { await h.cleanup(); }
    }, 15_000);

    for (const boundary of [false, true]) it(`T18 scheduled afterTurn capability=${capability} boundary=${boundary}`, async () => {
        const h = await harness(capability, false, true);
        let ready = 0, next = 0;
        try {
            vi.mocked(query).mockReturnValue({ setPermissionMode: vi.fn(), mcpServerStatus: vi.fn(async () => []),
                async *[Symbol.asyncIterator]() { yield { type: 'result', subtype: 'success', is_error: false, result: 'A initial final' }; },
            } as any);
            await claudeRemote({ sessionId: null, path: process.cwd(), allowedTools: [], hookSettingsPath: '/tmp/synthetic-settings.json',
                nextMessage: async () => next++ > 0 ? null : { message: 'A', mode: { permissionMode: 'default' },
                    commitInput: () => { h.batch('A'); return true; } },
                afterTurn: async () => { await h.queue.flush(); expect(ready).toBe(0); if (boundary) await h.consume('consumed'); },
                onReady: () => { ready++; h.queue.enqueue(turnEndItem('completed')); },
                canCallTool: async () => ({ behavior: 'allow' }) as any, isAborted: () => false,
                onSessionFound: vi.fn(), onThinkingChange: vi.fn(),
                onMessage: msg => { if (msg.type === 'result') {
                    if (msg.subtype === 'success' && !msg.is_error) h.queue.enqueue(finalAnswerItem(msg.result));
                } else h.sdk(msg); },
            });
            await h.queue.flush(); await h.result(`T18-${boundary}-${capability}`, { ready });
        } finally { await h.cleanup(); }
    }, 15_000);

    for (const source of ['consumed', 'attachment', 'sdk'] as const) it(`v12 outbox ${source} capability=${capability}`, async () => {
        const h = await harness(capability, true);
        const posted: Array<{ localId: string; content: any }> = [];
        let release!: () => void, seq = 0, first = true;
        const gate = new Promise<void>(resolve => { release = resolve; });
        vi.mocked(axios.post).mockImplementation(async (_url, data: any) => {
            posted.push(...data.messages.map((row: any) => ({ localId: row.localId,
                content: decrypt(new Uint8Array(32), 'legacy', decodeBase64(row.content)) })));
            if (first) { first = false; await gate; }
            return { data: { messages: data.messages.map((row: any) => ({ id: `server-${++seq}`, seq, localId: row.localId, createdAt: 1 })) } };
        });
        let draining: Promise<unknown> | undefined;
        try {
            // A normal session frame makes even evidence-disabled main's outbox nonempty.
            h.client.sendSessionEvent({ type: 'message', message: 'start outbox' });
            h.batch('A'); await h.answer('textless A');
            draining = (h.client as any).flushOutbox();
            await vi.waitFor(() => expect(posted.length).toBeGreaterThan(0));
            h.batch('B', 'request-B');
            h.sdk({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [
                { type: 'tool_use', id: 'B-tool', name: 'Bash', input: { command: 'pwd' } },
            ] } });
            h.sdk({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [
                { type: 'tool_result', tool_use_id: 'B-tool', content: '/workspace' },
            ] } });
            await h.answer('B answer'); await h.consume(source); await h.end();
            release(); await draining;
            const transmitted = posted.filter(row => row.content?.role === 'session').map(row => row.content.content);
            expect(transmitted).toEqual(h.events);
            expect(new Set(posted.map(row => row.localId)).size).toBe(posted.length);
            await h.result(`outbox-${source}-${capability}`, { emissions: transmitted, outboxTurns: transmitted.filter(e =>
                e.ev.t === 'turn-start' || e.ev.t === 'turn-end').length });
        } finally { release(); await draining; await h.cleanup(); }
    }, 15_000);
}

it.each([false, true])('Codex no-start terminal channel=%s', async channel => {
    const state = { currentTurnId: null, dispatchedInput: true, pendingRequestId: channel ? 'channel-A' : null };
    const mapped = mapCodexMcpMessageToSessionEnvelopes({ type: 'turn_aborted' }, state);
    await appendFile(process.env.T2RT_PARITY_OUTPUT!, JSON.stringify({ name: `codex-${channel}`,
        wire: mapped.envelopes,
        turns: mapped.envelopes.map(e => ({ id: e.id, role: e.role, turn: e.turn, ev: e.ev })) }) + '\n');
});
