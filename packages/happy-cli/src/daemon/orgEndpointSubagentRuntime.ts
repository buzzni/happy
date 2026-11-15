/** Production adapter for user-gated roots and endpoint children. All keys, create snapshots and execution decisions stay in daemon custody. */
import { readFile, realpath } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiClient } from '@/api/api';
import type { Metadata, Session } from '@/api/types';
import type { Credentials } from '@/persistence';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';
import { HappySessionCreateProofBodySchema, SessionExecutionCreateBodySchema, SessionExecutionTicketSchema,
    rotationDigest, sessionCreateBodyHash, sessionTagHash, signRotationDocument, type SessionExecutionTicket } from '@slopus/happy-wire';
import type { DeviceKeys } from './deviceKeys';
import { createOrgEndpointSubagent, orgSubagentInputSchema, OrgSubagentRefused, type OrgSubagentParent, type OrgSubagentSelection } from './orgEndpointSubagent';
import { createOrgSubagentJournal } from './orgEndpointSubagentJournal';
import { createOrgSubagentRoot } from './orgEndpointSubagentRoot';
import { createOrgSubagentStudio, type OrgSubagentStudioAction } from './orgEndpointSubagentStudio';
import { parseOrgLlmEndpointStore } from './orgLlmEndpoint';
import { parseAiAuthSelection, parseOrgEndpointBinding, type SaycodeAgentEnvironment } from './sessionEnv';
import { ORG_ENDPOINT_BINDING_ENV, ORG_SUBAGENT_LAUNCH_ENV, ORG_SUBAGENT_OPERATION_ENV } from '@/utils/childEnv';
import { buildReconnectSessionEnvironment, RECONNECT_FRESH_LAUNCH_ENV } from './reconnectSessionEnv';

export interface OrgSubagentPersisted { metadata: Metadata; agentEnvironment?: SaycodeAgentEnvironment }
interface Dependencies {
    home: string; endpointStorePath: string; machineId: string; studioOrigin: string; happyOrigin: string; keys: DeviceKeys;
    strict(): boolean; pin(companyId: string): Promise<unknown>;
    records(): Record<string, OrgSubagentPersisted>;
    registration(): Promise<{ machineId: string; credentials: Credentials; happyAccountId: string }>;
    metadata(options: SpawnSessionOptions): Metadata;
    sync(raw: unknown): Promise<unknown>;
    environment(selection: OrgSubagentSelection): Promise<Record<string, string>>;
    persist(session: Session, environment: SaycodeAgentEnvironment): Promise<boolean>;
    start(options: SpawnSessionOptions): Promise<SpawnSessionResult>;
    reportParent?(sessionId: string): Promise<void>;
    warn?(message: string): void;
}
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const snapshotSchema = z.object({ options: z.record(z.string(), z.unknown()),
    metadata: z.object({ path: z.string(), host: z.string(), homeDir: z.string(), happyHomeDir: z.string(), happyLibDir: z.string(), happyToolsDir: z.string() }).passthrough(),
    body: SessionExecutionCreateBodySchema, encryptionKey: z.string().refine(value => Buffer.from(value, 'base64').length === 32),
    encryptionVariant: z.enum(['legacy', 'dataKey']), initialNonce: z.string(),
    session: z.object({ id, seq: z.number().int().nonnegative(), metadataVersion: z.number().int().nonnegative(), agentStateVersion: z.number().int().nonnegative() }).optional(),
}).strict();
type Snapshot = z.infer<typeof snapshotSchema>;
const code = (name: string): never => { throw new OrgSubagentRefused(`ORG_LLM_ENDPOINT_${name}`); };

/** Current account-authenticated ownership, without the obsolete and unwritten settings confirmation flag. */
export async function readOrgSubagentRegistration(input: {
    machineId: string; credentials: Credentials; happyOrigin: string;
    read(): Promise<{ credentials: Credentials | null; settings: { machineId?: string } }>;
}) {
    const current = async () => {
        const value = await input.read();
        if (!value.credentials || value.settings.machineId !== input.machineId
            || !isDeepStrictEqual(value.credentials, input.credentials)) return code('MACHINE_FORBIDDEN');
        return value.credentials;
    };
    const credentials = await current();
    let response: Response, raw: unknown;
    try {
        response = await fetch(input.happyOrigin + '/v1/machines/' + encodeURIComponent(input.machineId), {
            headers: { Authorization: `Bearer ${credentials.token}` }, redirect: 'error', signal: AbortSignal.timeout(10_000),
        });
        if (response.ok) raw = await response.json();
    } catch { return code('VERIFICATION_UNAVAILABLE'); }
    if (!response.ok) return code([401, 403, 404].includes(response.status) ? 'MACHINE_FORBIDDEN' : 'VERIFICATION_UNAVAILABLE');
    const verified = z.object({ machine: z.object({ id, accountId: id }) }).safeParse(raw);
    if (!verified.success) return code('VERIFICATION_UNAVAILABLE');
    if (verified.data.machine.id !== input.machineId) return code('MACHINE_FORBIDDEN');
    // A slow owner lookup must not keep credentials that were replaced while it was pending.
    await current();
    return { machineId: input.machineId, credentials, happyAccountId: verified.data.machine.accountId };
}

export function createOrgSubagentRuntime(deps: Dependencies) {
    const journal = createOrgSubagentJournal(deps.home);
    async function happyCapabilities() {
        const current = await registration();
        const response = await fetch(deps.happyOrigin + '/v1/org-endpoint-subagent/capabilities', { method: 'GET', redirect: 'error',
            headers: { Authorization: `Bearer ${current.credentials.token}` }, signal: AbortSignal.timeout(10_000) });
        if (response.status === 404 || response.status === 405) return code('HAPPY_SERVER_UNSUPPORTED');
        if (!response.ok) return code('VERIFICATION_UNAVAILABLE');
        if (response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') { await response.body?.cancel(); return code('HAPPY_SERVER_UNSUPPORTED'); }
        const reader = response.body?.getReader(); if (!reader) return code('HAPPY_SERVER_UNSUPPORTED');
        let bytes = 0; const chunks: Uint8Array[] = [];
        try {
            for (;;) {
                const chunk = await reader.read(); if (chunk.done) break;
                bytes += chunk.value.byteLength;
                if (bytes > 4096) { await reader.cancel(); return code('HAPPY_SERVER_UNSUPPORTED'); }
                chunks.push(chunk.value);
            }
        } finally { reader.releaseLock(); }
        let raw: unknown;
        try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return code('HAPPY_SERVER_UNSUPPORTED'); }
        const value = z.object({ orgEndpointSubagentVersion: z.literal(1), executionProofVersion: z.literal(1), relayTimeoutMs: z.literal(630000) }).strict().safeParse(raw);
        if (!value.success) return code('HAPPY_SERVER_UNSUPPORTED');
    }
    async function registration() {
        const current = await deps.registration();
        if (current.machineId !== deps.machineId) return code('MACHINE_FORBIDDEN');
        return current;
    }
    async function capture(options: SpawnSessionOptions, tag: string, initialNonce: string): Promise<Snapshot> {
        const current = await registration(), api = await ApiClient.create(current.credentials);
        const metadata = deps.metadata(options), selection = parseAiAuthSelection(options.aiAuthSelection);
        if (selection?.kind === 'org-endpoint') metadata.orgLlmEndpoint = { version: 1, bindingId: selection.bindingId, endpointId: selection.endpointId };
        const prepared = api.prepareSessionCreation({ tag, metadata, state: { controlledByUser: false } });
        return snapshotSchema.parse({ options, metadata, body: prepared.body, encryptionKey: Buffer.from(prepared.encryptionKey).toString('base64'),
            encryptionVariant: prepared.encryptionVariant, initialNonce });
    }
    async function create(snapshot: Snapshot, ticket: SessionExecutionTicket, launchId: string, operationId?: string) {
        const current = await registration();
        if (ticket.body.machineOwnerAccountId !== current.happyAccountId || ticket.body.sessionOwnerAccountId !== current.happyAccountId) return code('PROOF_FORBIDDEN');
        const api = await ApiClient.create(current.credentials);
        const prepared = { body: { ...snapshot.body, agentState: snapshot.body.agentState ?? null, dataEncryptionKey: snapshot.body.dataEncryptionKey ?? null }, encryptionKey: new Uint8Array(Buffer.from(snapshot.encryptionKey, 'base64')), encryptionVariant: snapshot.encryptionVariant };
        const session = await api.getOrCreateSession({ tag: snapshot.body.tag, metadata: snapshot.metadata as Metadata, state: null, prepared,
            executionProof: async body => ({ ticket, deviceProof: await signRotationDocument(HappySessionCreateProofBodySchema.parse({
                version: 1, type: 'happy-session-create-proof', audience: deps.happyOrigin, method: 'POST', path: '/v1/sessions',
                ticketDigest: await rotationDigest(ticket), sessionOwnerAccountId: current.happyAccountId,
                sessionTagHash: await sessionTagHash(body.tag), sessionCreateBodyHash: await sessionCreateBodyHash(body),
                issuedAt: Date.now(), expiresAt: Date.now() + 60_000,
            }), deps.keys.signing.secretKey) }),
        });
        if (!session) return code('PROOF_FORBIDDEN');
        const environment: SaycodeAgentEnvironment = { [ORG_SUBAGENT_LAUNCH_ENV]: launchId,
            ...(operationId ? { [ORG_SUBAGENT_OPERATION_ENV]: operationId } : {}) };
        if (!await deps.persist(session, environment)) throw new Error('ORG_LLM_ENDPOINT_PERSISTENCE_UNCONFIRMED');
        return { sessionId: session.id, snapshot: { ...snapshot, session: { id: session.id, seq: session.seq,
            metadataVersion: session.metadataVersion, agentStateVersion: session.agentStateVersion } } };
    }
    async function start(snapshot: Snapshot, launchId: string, operationId?: string) {
        if (!snapshot.session) return code('PROOF_REQUIRED');
        await happyCapabilities();
        const saved = snapshot.session;
        const reconnect = { ...buildReconnectSessionEnvironment({ sessionId: saved.id, encryption: {
            encryptionKey: new Uint8Array(Buffer.from(snapshot.encryptionKey, 'base64')), encryptionVariant: snapshot.encryptionVariant,
            seq: saved.seq, metadataVersion: saved.metadataVersion, agentStateVersion: saved.agentStateVersion,
        }, serverSnapshot: { metadata: snapshot.metadata as Metadata, ...saved }, baselineSeq: 0 }),
        [RECONNECT_FRESH_LAUNCH_ENV]: '1', [ORG_SUBAGENT_LAUNCH_ENV]: launchId,
        ...(operationId ? { [ORG_SUBAGENT_OPERATION_ENV]: operationId } : {}) };
        // Recheck current actor/device/execution authority after create and immediately before the provider may start.
        const evidence = await post({ sessionId: saved.id, launchId }, 'capabilities', { operationId: launchId,
            digest: createHash('sha256').update(snapshot.body.tag).digest('hex') });
        if (evidence.orgEndpointSubagentVersion !== 1 || evidence.proofVersion !== 1) return code('SERVER_UNSUPPORTED');
        const options = snapshot.options as unknown as SpawnSessionOptions;
        if (operationId) {
            const operation = await journal.read(operationId);
            if (!operation || Date.now() >= operation.createdAt + 620_000) return code('DEADLINE_EXCEEDED');
        }
        const result = await deps.start({ ...options, reconnectEnvironment: reconnect });
        if (result.type !== 'success' || result.sessionId !== saved.id) throw new Error('ORG_LLM_ENDPOINT_EXECUTION_UNCONFIRMED');
        const selection = parseAiAuthSelection(options.aiAuthSelection);
        if (selection?.kind === 'org-endpoint' && (result.appliedAiAuthSource !== 'org-endpoint'
            || result.appliedOrgLlmEndpoint?.bindingId !== selection.bindingId
            || !selection.candidates.includes(result.appliedOrgLlmEndpoint.targetId))) throw new Error('ORG_LLM_ENDPOINT_APPLIED_SOURCE_UNCONFIRMED');
        return { sessionId: result.sessionId, ...(result.additionalDirectories ? { additionalDirectories: result.additionalDirectories } : {}),
            ...(result.launchMcpDropped ? { launchMcpDropped: result.launchMcpDropped } : {}) };
    }
    const root = createOrgSubagentRoot({ home: deps.home, studioOrigin: deps.studioOrigin, happyOrigin: deps.happyOrigin,
        deviceSigningPublicKey: Buffer.from(deps.keys.signing.publicKey).toString('base64url'), now: Date.now,
        capture: async (raw, launchId, initialNonce) => {
            const parsed = z.object({ companyId: id, options: z.record(z.string(), z.unknown()) }).strict().parse(raw);
            if (!await deps.pin(parsed.companyId)) return code('PROOF_REQUIRED');
            await happyCapabilities();
            const options: SpawnSessionOptions = { ...parsed.options, directory: z.string().min(1).parse(parsed.options.directory),
                agent: z.enum(['claude', 'codex']).parse(parsed.options.agent ?? 'claude') };
            for (const key of ['sessionId', 'parentSessionId', 'resumeClaudeSessionId', 'resumeCodexThreadId', 'reconnectEnvironment'])
                if (parsed.options[key] !== undefined) return code('PARENT_BOUND');
            const current = await registration(), snapshot = await capture(options, `org-root-${launchId}`, initialNonce);
            return { companyId: parsed.companyId, machineAccountId: current.happyAccountId, snapshot,
                request: { machineId: deps.machineId, launchId, initialNonce, sessionTagHash: await sessionTagHash(snapshot.body.tag), sessionCreateBodyHash: await sessionCreateBodyHash(snapshot.body) } };
        },
        create: (record, ticket) => create(snapshotSchema.parse(record.snapshot), ticket, record.operationId),
        start: record => start(snapshotSchema.parse(record.snapshot), record.operationId),
    });
    async function post(parent: OrgSubagentParent, action: OrgSubagentStudioAction, body: Record<string, unknown>) {
        const current = await registration();
        const operation = ['prepare', 'launching', 'child-ticket'].includes(action) && typeof body.operationId === 'string' ? await journal.read(body.operationId) : null;
        const deadlineAt = operation ? operation.createdAt + 620_000 : Date.now() + (action === 'prepare' ? 70_000 : 10_000);
        const value = await createOrgSubagentStudio({ origin: deps.studioOrigin, machineId: deps.machineId, signingKey: deps.keys.signing.secretKey,
            bearer: () => current.credentials.token, fetch, remainingMs: () => deadlineAt - Date.now() })(parent, action, body);
        if (!value || typeof value !== 'object' || Array.isArray(value)) return code('SERVER_RESPONSE_INVALID');
        return value as Record<string, unknown>;
    }
    function sourceRecord(sessionId: string) {
        const record = deps.records()[sessionId];
        if (!record || record.metadata.machineId !== deps.machineId) return code('PROOF_REQUIRED');
        return record;
    }
    function policyDigest(record: OrgSubagentPersisted) {
        const env = record.agentEnvironment ?? {};
        return createHash('sha256').update(JSON.stringify({ directory: record.metadata.path, root: env.SAYCODE_AGENT_ROOT,
            scope: env.SAYCODE_AGENT_SCOPE, depth: env.SAYCODE_AGENT_DEPTH, maxSpawn: env.SAYCODE_AGENT_MAX_SPAWN,
            sandbox: env.HAPPY_PROJECT_SANDBOX_CONFIG, sandboxMode: env.HAPPY_SANDBOX_POLICY_MODE })).digest('hex');
    }
    function endpoint(record: OrgSubagentPersisted) {
        const raw = record.agentEnvironment?.[ORG_ENDPOINT_BINDING_ENV], marker = record.metadata.orgLlmEndpoint;
        if (raw === undefined && marker === undefined) return undefined;
        const bound = raw === undefined ? null : parseOrgEndpointBinding(raw);
        if (!bound) return code('PARENT_BOUND');
        if (marker !== undefined) {
            const parsed = z.object({ version: z.literal(1), bindingId: id, endpointId: id }).strict().safeParse(marker);
            if (!parsed.success || parsed.data.bindingId !== bound.bindingId || parsed.data.endpointId !== bound.endpointId) return code('PARENT_BOUND');
        }
        return { endpointId: bound.endpointId, generation: bound.generation };
    }
    async function parent(sessionId: string, allowCeiling = false): Promise<OrgSubagentParent> {
        const record = sourceRecord(sessionId), environment = record.agentEnvironment ?? {}, orgEndpoint = endpoint(record);
        const launchId = id.safeParse(environment[ORG_SUBAGENT_LAUNCH_ENV]);
        if (!launchId.success) return code('PROOF_REQUIRED');
        const operationId = environment[ORG_SUBAGENT_OPERATION_ENV];
        if (operationId !== undefined) {
            const own = await journal.read(operationId);
            if (!own || own.sessionId !== sessionId || own.selection?.bindingId !== launchId.data) return code('PROOF_FORBIDDEN');
            if (!orgEndpoint || own.selection.endpointId !== orgEndpoint.endpointId || own.selection.generation !== orgEndpoint.generation) return code('PARENT_BOUND');
        } else {
            const own = await root.read(launchId.data);
            if (!own || own.sessionId !== sessionId) return code('PROOF_FORBIDDEN');
            const original = parseAiAuthSelection(snapshotSchema.parse(own.snapshot).options.aiAuthSelection);
            if (original?.kind === 'org-endpoint' && (!orgEndpoint || original.endpointId !== orgEndpoint.endpointId || original.generation !== orgEndpoint.generation)) return code('PARENT_BOUND');
        }
        const depth = Number(environment.SAYCODE_AGENT_DEPTH ?? '0');
        if (!Number.isSafeInteger(depth) || depth < 0 || !allowCeiling && depth >= 2) return code('SPAWN_DEPTH_EXCEEDED');
        return { sessionId, launchId: launchId.data, ...(orgEndpoint ? { orgEndpoint } : {}) };
    }
    async function localEndpoint(endpointId: string) {
        let raw: string;
        try { raw = await readFile(deps.endpointStorePath, 'utf8'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
        const entry = parseOrgLlmEndpointStore(raw).endpoints[endpointId];
        return entry ? { endpointId: entry.id, generation: entry.generation } : null;
    }
    const engine = createOrgEndpointSubagent({ journal, parent: source => parent(source), strict: deps.strict, localEndpoint, now: Date.now, warn: deps.warn,
        studio: post, sync: async raw => { await deps.sync(raw); },
        environment: async selection => {
            const environment = await deps.environment(selection), bound = parseOrgEndpointBinding(environment[ORG_ENDPOINT_BINDING_ENV] ?? '');
            if (!bound || bound.bindingId !== selection.bindingId || bound.endpointId !== selection.endpointId || bound.generation !== selection.generation) return code('NOT_SYNCED');
            return { targetId: bound.targetId, environment };
        },
        createSession: async (record, save) => {
            const selection = record.selection; if (!selection || !record.targetId) return code('NOT_SYNCED');
            const source = await parent(record.sourceSessionId), persisted = sourceRecord(record.sourceSessionId);
            if (record.request.sourcePolicyDigest !== policyDigest(persisted)) return code('OPERATION_CONFLICT');
            const inherited = { ...persisted.agentEnvironment };
            const options: SpawnSessionOptions = { directory: record.request.directory, agent: 'claude', initialPrompt: record.request.initialPrompt,
                model: record.request.model, effort: record.request.effort, outputFormat: record.request.outputFormat,
                aiAuthSelection: { ...selection, candidates: [record.targetId] },
                environmentVariables: { SAYCODE_AGENT_ENV: '1', SAYCODE_AGENT_ROOT: inherited.SAYCODE_AGENT_ROOT ?? record.request.directory,
                    SAYCODE_AGENT_SCOPE: inherited.SAYCODE_AGENT_SCOPE ?? inherited.SAYCODE_AGENT_ROOT ?? record.request.directory,
                    SAYCODE_AGENT_DEPTH: String(Number(inherited.SAYCODE_AGENT_DEPTH ?? '0') + 1),
                    SAYCODE_AGENT_MAX_SPAWN: inherited.SAYCODE_AGENT_MAX_SPAWN ?? '24', SAYCODE_AGENT_ID: record.request.spawnId,
                    ...(inherited.HAPPY_PROJECT_SANDBOX_CONFIG ? { HAPPY_PROJECT_SANDBOX_CONFIG: inherited.HAPPY_PROJECT_SANDBOX_CONFIG } : {}),
                    ...(inherited.HAPPY_SANDBOX_POLICY_MODE ? { HAPPY_SANDBOX_POLICY_MODE: inherited.HAPPY_SANDBOX_POLICY_MODE } : {}) },
            };
            const snapshot = await capture(options, `org-child-${selection.bindingId}`, randomBytes(32).toString('base64url'));
            await save(snapshot);
            const reply = await post(source, 'child-ticket', { operationId: record.operationId, digest: record.digest, initialNonce: snapshot.initialNonce,
                sessionTagHash: await sessionTagHash(snapshot.body.tag), sessionCreateBodyHash: await sessionCreateBodyHash(snapshot.body) });
            const ticket = SessionExecutionTicketSchema.parse(reply.executionTicket);
            if (ticket.body.launchId !== selection.bindingId || ticket.body.machineId !== deps.machineId) return code('PROOF_FORBIDDEN');
            return create(snapshot, ticket, selection.bindingId, record.operationId);
        },
        start: record => {
            if (!record.selection) return code('PROOF_REQUIRED');
            return start(snapshotSchema.parse(record.snapshot), record.selection.bindingId, record.operationId);
        },
    });
    async function reportParent(sessionId: string) {
        const operationId = sourceRecord(sessionId).agentEnvironment?.[ORG_SUBAGENT_OPERATION_ENV];
        if (!operationId) { await deps.reportParent?.(sessionId); return; }
        const own = await journal.read(operationId);
        if (!own || own.sessionId !== sessionId || !own.selection) return code('PROOF_FORBIDDEN');
        if (own.phase === 'started' || !own.providerConfirmed || !own.targetId) return;
        const issuer = await parent(own.sourceSessionId, true);
        const report = await post(issuer, 'started', { operationId, digest: own.digest, sessionId, targetId: own.targetId });
        if (report.state !== 'started') return code('PARENT_BINDING_PENDING');
        own.phase = 'started'; own.result = { ok: true, state: 'started', operationId, sessionId, endpointId: own.selection.endpointId,
            ...(own.displayName ? { displayName: own.displayName } : {}), ...(own.warnings ? { warnings: own.warnings } : {}) };
        await journal.write(own);
    }
    async function context(raw: unknown) {
        const input = z.object({ sourceSessionId: id, checkServer: z.boolean().optional() }).strict().parse(raw);
        const record = sourceRecord(input.sourceSessionId), bound = endpoint(record);
        const source = bound ? { kind: 'org-endpoint' as const, ...bound } : { kind: 'default' as const };
        if (record.agentEnvironment?.[ORG_SUBAGENT_LAUNCH_ENV] === undefined)
            return { orgEndpointSubagentVersion: 1 as const, proofAvailable: false, serverStatus: 'unknown' as const, source };
        const evidence = await parent(input.sourceSessionId, true);
        if (input.checkServer) {
            await happyCapabilities();
            await reportParent(input.sourceSessionId);
            const reply = await post(evidence, 'capabilities', { operationId: randomUUID(), digest: createHash('sha256').update(input.sourceSessionId).digest('hex') });
            if (reply.orgEndpointSubagentVersion !== 1 || reply.proofVersion !== 1) return code('SERVER_UNSUPPORTED');
        }
        return { orgEndpointSubagentVersion: 1 as const, proofAvailable: true, serverStatus: input.checkServer ? 'supported' as const : 'unknown' as const, source };
    }
    async function checkResume(query: { bindingId: string; sessionId: string; endpointId: string; targetId: string; generation: number }) {
        try {
            const source = await parent(query.sessionId, true);
            const { sessionId: _session, ...binding } = query;
            const reply = await post(source, 'resume', { ...binding, operationId: randomUUID(), digest: createHash('sha256').update(JSON.stringify(query)).digest('hex') });
            return reply.ok === true ? { ok: true as const } : { ok: false as const, reason: 'REFUSED' as const };
        } catch (error) {
            return { ok: false as const, reason: error instanceof OrgSubagentRefused ? 'REFUSED' as const : 'UNREACHABLE' as const,
                code: error instanceof OrgSubagentRefused ? error.code : 'ORG_LLM_ENDPOINT_VERIFICATION_UNAVAILABLE' };
        }
    }
    return { spawn: async (raw: unknown) => {
        const request = orgSubagentInputSchema.parse(raw);
        try {
            await parent(request.sourceSessionId);
            const source = sourceRecord(request.sourceSessionId);
            let directory: string, sourceDirectory: string;
            try { [directory, sourceDirectory] = await Promise.all([realpath(request.directory), realpath(source.metadata.path)]); }
            catch { return code('PARENT_BOUND'); }
            if (directory !== sourceDirectory) return code('PARENT_BOUND');
            // A caller cannot supply or override the daemon-held sandbox/lineage policy commitment.
            request.sourcePolicyDigest = policyDigest(source);
            await reportParent(request.sourceSessionId);
            return await engine.spawn(request);
        } catch (error) {
            // Without a reservation nothing was submitted and status has nothing to observe: the caller must retry, not wait.
            if (error instanceof OrgSubagentRefused || await journal.read(request.operationId).catch(() => undefined) !== null) throw error;
            return code('VERIFICATION_UNAVAILABLE');
        }
    }, status: engine.status, context, checkResume,
        hasAuthority: (sessionId: string) => deps.records()[sessionId]?.agentEnvironment?.[ORG_SUBAGENT_LAUNCH_ENV] !== undefined,
        capabilities: async (raw: unknown) => {
            const input = z.object({ companyId: id.optional() }).strict().parse(raw);
            const pin = input.companyId ? await deps.pin(input.companyId) as { approval?: { body?: { machineType?: unknown } } } | null : null;
            if (pin?.approval?.body?.machineType === 'dedicated') await happyCapabilities();
            return { orgEndpointSubagentVersion: 1 as const, rootProofVersion: pin?.approval?.body?.machineType === 'dedicated' ? 1 : 0,
                rootAgents: ['claude', 'codex'] };
        }, prepareRoot: root.prepare, startRoot: root.start, statusRoot: root.status };
}
