/** Production T4rt adapter. Credentials stay in daemon custody; only creation POST carries proofs. */
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { rotationIsFresh, verifyOwnership, rotationDecodeBinary, sessionCreateBodyHash, OwnershipCallerBindingSchema } from '@slopus/happy-wire';
import { ApiClient } from '@/api/api';
import { decodeBase64, decrypt, encodeBase64 } from '@/api/encryption';
import type { Metadata, Session } from '@/api/types';
import type { Credentials, SessionPersistenceResult } from '@/persistence';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';
import { createOwnedSpawn, OwnedSpawnRejected, OwnedStartRefused, type OwnedSpawnRecord, type OwnedSpawnSnapshot } from './ownedSpawn';
import { createOwnedSpawnJournal } from './ownedSpawnJournal';
import { createAgentCallerBindings } from './agentCallerBinding';
import type { MachineSetupTokenRuntime } from './machineSetupTokenRuntime';
import { readSetupTokenResumeSelection, isMachineSetupTokenBinding, parseAiAuthSelection } from './sessionEnv';
import { buildReconnectSessionEnvironment, RECONNECT_FRESH_LAUNCH_ENV } from './reconnectSessionEnv';
import type { TrackedSession } from './types';
import type { OwnedSpawnRpc } from './ownedSpawnRpc';
import type { OwnedLaunchLineage } from './agentCallerLaunches';

type Caller = z.infer<typeof OwnershipCallerBindingSchema>;

const spawnSchema = z.object({ directory: z.string().min(1), agent: z.enum(['claude', 'codex']), model: z.string().optional(),
    effort: z.string().optional(), initialPrompt: z.string().optional(), initialPromptLocalId: z.string().optional(),
    permissionMode: z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'read-only', 'safe-yolo', 'yolo']).optional(),
    additionalDirectories: z.array(z.string()).optional(), environmentVariables: z.record(z.string(), z.string()).optional(),
    mcpConfigProjectId: z.string().optional(), mcpCallerGrantEnvelope: z.string().optional(), expectedConnectors: z.array(z.string()).optional(),
    approvedNewDirectoryCreation: z.boolean().optional(), aiAuthSelection: z.unknown().optional(),
}).strict();
const rawSessionSchema = z.object({ id: z.string(), seq: z.number().int().nonnegative(), metadata: z.string(), metadataVersion: z.number().int().nonnegative(),
    agentState: z.string().nullable(), agentStateVersion: z.number().int().nonnegative(), dataEncryptionKey: z.string().nullable().optional() });
type RawSession = z.infer<typeof rawSessionSchema>;
type PreparedLaunch = Awaited<ReturnType<MachineSetupTokenRuntime['prepareLaunch']>>;
export interface OwnedSpawnRuntimeDependencies {
    home: string; happyOrigin: string; env: NodeJS.ProcessEnv;
    /** Always read the current runtime-home credential and registration, not RPC claims. */
    registration(): Promise<{ machineId: string; credentials: Credentials; epoch: string }>;
    metadata(options: SpawnSessionOptions): Metadata;
    rotation(options: SpawnSessionOptions, companyId?: string): Promise<MachineSetupTokenRuntime | null>;
    start(options: SpawnSessionOptions, launch?: PreparedLaunch): Promise<SpawnSessionResult>;
    tracked(sessionId: string): TrackedSession | undefined;
    live(session: TrackedSession): boolean;
    persist(session: Session): Promise<SessionPersistenceResult>;
    fetch?: typeof fetch;
    /** T1c-b2 H2: daemon-vouched bindings of other daemon launches (agentCallerLaunches). */
    launchCallers?: { query(raw: unknown): Promise<unknown>;
        /** H3 host custody: owner contact on and trusted, so an owned child host holds its own key. */
        available?(): boolean;
        currentCaller?(sessionId: string): Promise<Caller | null> };
    /** How long an owned start waits for the child host's own binding before answering `starting` (H3). */
    hostBindingWaitMs?: number;
    realpath?(path: string): string;
}
export type OwnedSpawnRuntime = OwnedSpawnRpc & {
    /** Daemon-internal, never an RPC: the lineage a launch of this owned session must bind (H3). */
    launchLineage(sessionId: string): Promise<OwnedLaunchLineage | 'unknown' | null>;
    /** Daemon-internal: this launch must carry the owner-contact pipe, so it may not go through tmux (H3). */
    pipeOnlyLaunch(options: SpawnSessionOptions): boolean;
};
/** Private daemon dispatch evidence; never accepted from RPC, argv, or provider environment. */
export function createOwnedStartGuard() {
    const active = new WeakSet<SpawnSessionOptions>(), submitted = new WeakSet<SpawnSessionOptions>();
    return {
        submitted(options: SpawnSessionOptions) { if (active.has(options)) submitted.add(options); },
        wasSubmitted(options: SpawnSessionOptions) { return submitted.has(options); },
        async start(options: SpawnSessionOptions, launch: () => Promise<SpawnSessionResult>) {
            active.add(options);
            try {
                const result = await launch();
                if (result.type !== 'success' && !submitted.has(options)) {
                    throw new OwnedStartRefused(result.type === 'requestToApproveDirectoryCreation' ? 'directory-approval-required'
                        : result.code === 'daemon-restarting' ? 'daemon-restarting' : 'validation-error');
                }
                return result;
            } finally { active.delete(options); submitted.delete(options); }
        },
    };
}
export function createOwnedSpawnRuntime(deps: OwnedSpawnRuntimeDependencies): OwnedSpawnRuntime {
    const journal = createOwnedSpawnJournal(deps.home), fetcher = deps.fetch ?? fetch;
    let local: { machineId: string; happyAccountId: string; epoch: string } | null = null;
    const running = new Map<string, { stamp: string; binding: z.infer<typeof OwnershipCallerBindingSchema> }>();
    const startPrepared = new Map<string, { options: SpawnSessionOptions; launch?: PreparedLaunch }>();
    const launchFlights = new Map<string, { reject(error: Error): void; runtime: MachineSetupTokenRuntime; resolve(session: Session): void; complete: Promise<PreparedLaunch> }>();
    const stamps = new WeakMap<TrackedSession, string>();
    const stamp = (s: TrackedSession) => { let value = stamps.get(s); if (!value) { value = randomUUID(); stamps.set(s, value); } return `${s.pid}:${value}`; };
    const caller = createAgentCallerBindings({ identity: () => local, live: binding => {
        const session = deps.tracked(binding.sessionId), bound = running.get(binding.sessionId);
        return !!session && deps.live(session) && bound?.stamp === stamp(session) && bound.binding.callerBindingId === binding.callerBindingId;
    } });
    /** Host custody (H3): the child host binds itself at provider start; the daemon keeps no key for it. */
    const hostCallers = () => {
        const launches = deps.launchCallers, currentCaller = launches?.currentCaller;
        return launches?.available?.() === true && currentCaller ? { currentCaller: currentCaller.bind(launches), query: launches.query.bind(launches) } : null;
    };
    /** Lineages fixed for owned starts in flight, until the child host's binding is adopted. */
    const lineages = new Map<string, OwnedLaunchLineage>();
    /** Recovery follows the custody the journal fixed at start, never today's trust (H3-R1-01). */
    const hostCustody = (record: OwnedSpawnRecord) => record.callerCustody === 'host';
    const pipeLaunches = new WeakSet<SpawnSessionOptions>();
    const realpath = (path: string) => { try { return (deps.realpath ?? realpathSync)(path); } catch { return path; } };
    function options(record: OwnedSpawnRecord): SpawnSessionOptions {
        const parsed = spawnSchema.parse(record.spawn), aiAuthSelection = parseAiAuthSelection(parsed.aiAuthSelection);
        if (parsed.aiAuthSelection !== undefined && !aiAuthSelection) throw new Error('invalid-ai-selection');
        return { ...parsed, aiAuthSelection } as SpawnSessionOptions;
    }
    async function json(path: string, body?: unknown) {
        const state = await deps.registration();
        const response = await fetcher(deps.happyOrigin + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
            signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${state.credentials.token}`, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        if (!response.ok) {
            if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) throw new OwnedSpawnRejected();
            throw new Error('owned-spawn-transport-unavailable');
        }
        const latest = await deps.registration();
        if (latest.epoch !== state.epoch || latest.machineId !== state.machineId) throw new Error('identity-changed');
        return response.json();
    }
    async function scope() {
        const state = await deps.registration();
        const account = z.object({ id: z.string().min(1) }).parse(await json('/v1/account/profile'));
        const latest = await deps.registration();
        if (latest.epoch !== state.epoch || latest.machineId !== state.machineId) throw new Error('identity-changed');
        local = { machineId: state.machineId, happyAccountId: account.id, epoch: state.epoch };
        return { machineId: state.machineId, machineAccountId: account.id, sessionAccountId: account.id };
    }
    async function verify(raw: unknown) {
        try {
            const doc = z.object({ issuer: z.string(), audience: z.string(), keyId: z.string(), issuedAt: z.number(), expiresAt: z.number() }).passthrough().parse(raw);
            const keys = JSON.parse(deps.env.HAPPY_SESSION_OWNERSHIP_PUBLIC_KEYS ?? '{}');
            if (deps.env.HAPPY_SESSION_OWNERSHIP_ENABLED !== '1' || doc.issuer !== deps.env.HAPPY_SESSION_OWNERSHIP_ISSUER || doc.audience !== deps.happyOrigin
                || deps.env.HAPPY_SESSION_OWNERSHIP_AUDIENCE !== deps.happyOrigin) return false;
            return verifyOwnership(raw as Parameters<typeof verifyOwnership>[0], rotationDecodeBinary(keys[doc.keyId], 32));
        } catch { return false; }
    }
    function session(snapshot: OwnedSpawnSnapshot, raw: RawSession): Session {
        const encryptionKey = decodeBase64(snapshot.encryptionKey), encryptionVariant = snapshot.encryptionVariant;
        return { id: raw.id, seq: raw.seq, encryptionKey, encryptionVariant,
            metadata: decrypt(encryptionKey, encryptionVariant, decodeBase64(raw.metadata)) as Metadata, metadataVersion: raw.metadataVersion,
            agentState: raw.agentState ? decrypt(encryptionKey, encryptionVariant, decodeBase64(raw.agentState)) as Session['agentState'] : null,
            agentStateVersion: raw.agentStateVersion };
    }
    async function find(record: OwnedSpawnRecord): Promise<RawSession | null> {
        const seen = new Set<string>(); let cursor: string | null = null, candidate: RawSession | null = null;
        for (;;) {
            const page = z.object({ sessions: z.array(rawSessionSchema), nextCursor: z.string().nullable(), hasNext: z.boolean() })
                .parse(await json(`/v2/sessions?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
            const body = record.snapshot!.body;
            // Legacy proof-less creation does not persist agentState. Proof-bound creation does,
            // so retain its exact encrypted-state binding (including execution-only launches).
            const bindsAgentState = Boolean(record.proof || record.snapshot!.executionProof);
            for (const raw of page.sessions) {
                if (record.created ? raw.id === record.created.sessionId
                    : raw.metadata === body.metadata && (!bindsAgentState || raw.agentState === (body.agentState ?? null))
                        && (raw.dataEncryptionKey ?? null) === (body.dataEncryptionKey ?? null)) {
                    if (record.created) return raw;
                    if (candidate && candidate.id !== raw.id) throw new Error('ambiguous-created-session');
                    candidate = raw;
                }
            }
            if (!page.hasNext) return candidate;
            if (!page.nextCursor || seen.has(page.nextCursor)) throw new Error('invalid-session-cursor');
            seen.add(page.nextCursor); cursor = page.nextCursor;
        }
    }
    async function complete(record: OwnedSpawnRecord, raw: RawSession) {
        const flight = launchFlights.get(record.preparationId);
        if (flight) { flight.resolve(session(record.snapshot!, raw)); await flight.complete; }
    }
    async function recoverLaunch(record: OwnedSpawnRecord, created: Session): Promise<PreparedLaunch | undefined> {
        const company = record.snapshot?.runtimeState?.executionCompanyId;
        if (typeof company !== 'string') return undefined;
        const flight = launchFlights.get(record.preparationId);
        if (flight) { flight.resolve(created); return flight.complete; }
        const runtime = await deps.rotation(options(record), company);
        if (!runtime) throw new Error('execution-unavailable');
        const recovered = await runtime.recoverLaunches();
        const tracked = recovered.find(s => s.happySessionId === created.id) ?? deps.tracked(created.id);
        const binding = tracked && readSetupTokenResumeSelection(tracked.agentEnvironment)?.binding;
        if (!tracked || !binding || !isMachineSetupTokenBinding(binding)) throw new Error('execution-recovery-pending');
        const environment = await runtime.resume(tracked, binding);
        return { session: created, environment, reconnectEnvironment: { ...buildReconnectSessionEnvironment({ sessionId: created.id,
            encryption: created, serverSnapshot: created, baselineSeq: 0 }), [RECONNECT_FRESH_LAUNCH_ENV]: '1' } };
    }
    async function bind(record: OwnedSpawnRecord) {
        const sessionId = record.created!.sessionId;
        const parentId = record.intent.parentHubSessionId;
        let depth = 0, scopePath = options(record).directory;
        if (parentId) {
            const parent = await caller.query({ sessionId: parentId, nonce: randomUUID() });
            depth = parent.caller.depth + 1; scopePath = parent.caller.scope;
            // Existing launch scope cannot widen while adding owner inheritance.
            if (scopePath !== options(record).directory) throw new Error('caller-scope-mismatch');
        }
        const binding = caller.prepare({ sessionId, scope: scopePath, depth });
        const tracked = deps.tracked(sessionId);
        running.set(sessionId, { stamp: tracked ? stamp(tracked) : '', binding }); return binding;
    }
    /** Depth and scope come from the journal and the parent's current binding, never from the parent's contact. */
    async function lineageOf(record: OwnedSpawnRecord): Promise<OwnedLaunchLineage> {
        const sessionId = record.created!.sessionId, parentId = record.intent.parentHubSessionId, directory = realpath(options(record).directory);
        if (!parentId) return { sessionId, scope: directory, depth: 0 };
        const parent = await hostCallers()?.currentCaller(parentId)
            ?? (await caller.query({ sessionId: parentId, nonce: randomUUID() }).catch(() => null))?.caller;
        if (!parent) throw new Error('caller-unavailable');
        // Existing launch scope cannot widen while adding owner inheritance.
        if (parent.scope !== directory) throw new Error('caller-scope-mismatch');
        return { sessionId, scope: parent.scope, depth: parent.depth + 1, parentCallerPublicKey: parent.callerPublicKey };
    }
    /** The child host's own binding for its live launch, matching the fixed lineage; waits up to waitMs. */
    async function hostStarted(record: OwnedSpawnRecord, waitMs = 0) {
        const sessionId = record.created!.sessionId, hosts = hostCallers();
        const lineage = hosts && (lineages.get(sessionId) ?? await lineageOf(record).catch(() => null));
        if (!hosts || !lineage) return null;
        for (const deadline = Date.now() + waitMs; ;) {
            const tracked = deps.tracked(sessionId);
            const bound = tracked && deps.live(tracked) ? await hosts.currentCaller(sessionId) : null;
            if (bound && bound.depth === lineage.depth && bound.scope === lineage.scope && bound.callerPublicKey !== lineage.parentCallerPublicKey) {
                lineages.delete(sessionId);
                return { providerRuntimeId: bound.runtimeId, caller: bound };
            }
            if (Date.now() >= deadline) return null;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    const coordinator = createOwnedSpawn({ journal, now: Date.now, verify, scope,
        async prepare(record, publish) {
            const opts = options(record), state = await deps.registration(), api = await ApiClient.create(state.credentials);
            const company = record.snapshot?.runtimeState?.executionCompanyId;
            const rotation = record.snapshot && company === null ? null : await deps.rotation(opts, typeof company === 'string' ? company : undefined);
            const makeSnapshot = (metadata: Metadata, tag: string) => {
                const prepared = api.prepareSessionCreation({ tag, metadata, state: { controlledByUser: false } });
                return { body: prepared.body, encryptionKey: encodeBase64(prepared.encryptionKey), encryptionVariant: prepared.encryptionVariant };
            };
            if (!rotation) {
                if (company) throw new Error('execution-unavailable');
                return record.snapshot ?? { ...makeSnapshot(deps.metadata(opts), record.preparationId), runtimeState: { executionCompanyId: null } };
            }
            if (!record.intent.companyId) throw new Error('execution-company-required');
            let resolveSession!: (value: Session) => void, rejectSession!: (error: Error) => void;
            const sessionReady = new Promise<Session>((resolve, reject) => { resolveSession = resolve; rejectSession = reject });
            void sessionReady.catch(() => undefined);
            let ready!: (snapshot: OwnedSpawnSnapshot) => void, failed!: (error: unknown) => void;
            const prepared = new Promise<OwnedSpawnSnapshot>((resolve, reject) => { ready = resolve; failed = reject });
            const metadata = record.snapshot ? decrypt(decodeBase64(record.snapshot.encryptionKey), record.snapshot.encryptionVariant, decodeBase64(record.snapshot.body.metadata)) as Metadata : deps.metadata(opts);
            const complete = rotation.prepareLaunch({ metadata, ownerAccountId: record.intent.sessionAccountId,
                machineOwnerAccountId: record.intent.machineAccountId, ownershipPreparation: { launchId: record.preparationId, tag: record.preparationId },
                createSession: async input => {
                    const snapshot: OwnedSpawnSnapshot = record.snapshot ?? { ...makeSnapshot(input.metadata, input.tag), runtimeState: { executionCompanyId: record.intent.companyId } };
                    await publish(snapshot);
                    snapshot.executionProof = await input.executionProof(snapshot.body, { encryptionKey: decodeBase64(snapshot.encryptionKey), encryptionVariant: snapshot.encryptionVariant });
                    await publish(snapshot); ready(snapshot); return sessionReady;
                } });
            void complete.catch(error => { launchFlights.delete(record.preparationId); failed(error); });
            launchFlights.set(record.preparationId, { resolve: resolveSession, reject: rejectSession, runtime: rotation, complete });
            return prepared;
        },
        async failed(record) {
            const flight = launchFlights.get(record.preparationId);
            if (flight) {
                flight.reject(new OwnedSpawnRejected());
                await flight.complete.catch(() => undefined);
                await flight.runtime.abandonOwnedLaunch(record.preparationId);
                launchFlights.delete(record.preparationId);
            } else {
                const company = record.snapshot?.runtimeState?.executionCompanyId;
                if (typeof company === 'string') {
                    const runtime = await deps.rotation(options(record), company);
                    if (!runtime) throw new Error('execution-unavailable');
                    await runtime.abandonOwnedLaunch(record.preparationId);
                }
            }
        },
        async commit(record) {
            const snapshot = record.snapshot!;
            if (snapshot.executionProof && (!rotationIsFresh(snapshot.executionProof.ticket.body, Date.now())
                || !rotationIsFresh(snapshot.executionProof.deviceProof.body, Date.now()))) throw new OwnedSpawnRejected('execution-proof-expired');
            const response = z.object({ session: rawSessionSchema, ownership: z.unknown().optional() }).parse(await json('/v1/sessions', { ...snapshot.body,
                ...(snapshot.executionProof ? { executionProof: snapshot.executionProof } : {}), ...(record.proof ? { ownershipProof: record.proof } : {}) }));
            const created = record.proof ? z.object({ sessionId: z.string(), ownershipBindingId: z.string(), registrationState: z.enum(['pending', 'confirmed']), createDigest: z.string() }).strict().parse(response.ownership)
                : { sessionId: response.session.id, createDigest: await sessionCreateBodyHash(snapshot.body) };
            if (created.sessionId !== response.session.id) throw new Error('creation-receipt-mismatch');
            await complete(record, response.session); return created;
        },
        async discover(record) {
            const raw = await find(record); if (!raw) return null;
            await complete(record, raw);
            return { sessionId: raw.id, createDigest: await sessionCreateBodyHash(record.snapshot!.body) };
        },
        async caller(record) {
            if (!hostCallers()) return bind(record);
            lineages.set(record.created!.sessionId, await lineageOf(record));
            return null;
        },
        async prepareStart(record) {
            const raw = await find(record); if (!raw) throw new Error('created-session-unavailable');
            const created = session(record.snapshot!, raw), opts = options(record);
            if (created.metadata.path !== opts.directory) throw new Error('created-session-scope-changed');
            const launch = await recoverLaunch(record, created);
            if ((await deps.persist(created)).status !== 'committed') throw new Error('session-persistence-failed');
            const reconnectEnvironment = { ...buildReconnectSessionEnvironment({ sessionId: created.id, encryption: created, serverSnapshot: created, baselineSeq: 0 }), [RECONNECT_FRESH_LAUNCH_ENV]: '1' };
            startPrepared.set(record.preparationId, { options: { ...opts, reconnectEnvironment }, launch });
        },
        async start(record) {
            const prepared = startPrepared.get(record.preparationId); if (!prepared) throw new Error('start-not-prepared');
            startPrepared.delete(record.preparationId);
            if (hostCustody(record)) pipeLaunches.add(prepared.options);
            const result = await deps.start(prepared.options, prepared.launch);
            launchFlights.delete(record.preparationId);
            const created = { id: record.created!.sessionId };
            if (result.type !== 'success' || result.sessionId !== created.id) throw new Error('provider-start-unknown');
            if (hostCustody(record)) {
                // Unconfirmed until the child host binds itself; status recovers it without another launch.
                // Short: main's start RPC has a 20s deadline and the webhook wait already spent part of it.
                const found = await hostStarted(record, deps.hostBindingWaitMs ?? 5_000);
                if (!found) throw new Error('provider-start-unknown');
                return found;
            }
            const tracked = deps.tracked(created.id), entry = running.get(created.id);
            if (!tracked || !deps.live(tracked) || !entry) throw new Error('provider-start-unknown');
            entry.stamp = stamp(tracked);
            return { providerRuntimeId: entry.binding.runtimeId, caller: entry.binding };
        },
        async observeStart(record) {
            const tracked = deps.tracked(record.created!.sessionId); if (!tracked || !deps.live(tracked)) return null;
            // Host custody never falls back to a daemon key, whatever the trust is now.
            if (hostCustody(record)) return hostStarted(record);
            const binding = await bind(record); return { providerRuntimeId: binding.runtimeId, caller: binding };
        },
    });
    return { ...coordinator,
        async capabilities(raw) {
            const parsed = z.object({ spawn: spawnSchema }).strict().safeParse(raw);
            const configured = deps.env.HAPPY_SESSION_OWNERSHIP_ENABLED === '1' && !!deps.env.HAPPY_SESSION_OWNERSHIP_PUBLIC_KEYS
                && !!deps.env.HAPPY_SESSION_OWNERSHIP_ISSUER && deps.env.HAPPY_SESSION_OWNERSHIP_AUDIENCE === deps.happyOrigin;
            const supported = parsed.success && configured;
            // Contacting an owned child is advertised apart from creating one; switch off answers exactly as before.
            return hostCallers() ? { ownedSpawnPrepareV1: supported, ownedChildOwnerContactV1: supported } : { ownedSpawnPrepareV1: supported };
        },
        async launchLineage(sessionId) {
            if (!hostCallers()) return null;
            const reserved = lineages.get(sessionId); if (reserved) return { ...reserved };
            for (const record of await journal.list()) {
                if (record.created?.sessionId !== sessionId) continue;
                // A daemon-custody session already has its binding; its host gets no second one.
                if (!hostCustody(record)) return 'unknown';
                if (record.caller) return { sessionId, scope: record.caller.scope, depth: record.caller.depth };
                // An owned session whose lineage cannot be read is never launched as depth 0.
                return lineageOf(record).catch(() => 'unknown' as const);
            }
            return null;
        },
        pipeOnlyLaunch: options => pipeLaunches.has(options),
        async callerBinding(raw) {
            const input = z.object({ sessionId: z.string().min(1).max(128), nonce: z.string().min(16).max(256) }).strict().parse(raw);
            await scope();
            // Reconstruct only from the daemon's persisted creation and actual live launch, never the query's claims.
            for (const record of await journal.list()) {
                if (record.created?.sessionId !== input.sessionId) continue;
                if (record.intent.machineId !== local?.machineId || record.intent.sessionAccountId !== local?.happyAccountId) throw new Error('identity-changed');
                const tracked = deps.tracked(input.sessionId); if (!tracked || !deps.live(tracked)) throw new Error('caller-not-running');
                // Host custody: only the binding the child host holds the key for, never a daemon-made replacement.
                if (hostCustody(record)) {
                    if (!deps.launchCallers) throw new Error('caller-unavailable');
                    return deps.launchCallers.query(input);
                }
                const known = running.get(input.sessionId);
                if (!known || known.stamp !== stamp(tracked)) await bind(record);
                return caller.query(input);
            }
            if (deps.launchCallers) return deps.launchCallers.query(input);
            throw new Error('caller-unavailable');
        },
    };
}
