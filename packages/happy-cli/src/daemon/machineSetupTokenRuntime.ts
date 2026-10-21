/** Actual launch/rotation coordinator. Only this trusted daemon path constructs machine records. */
import { createHash, randomUUID } from 'node:crypto'
import { rotationDigest, rotationIsFresh, rotationDecodeBinary, rotationSha256, verifyRotationDocument, sessionTagHash, sessionCreateBodyHash,
  type HappySessionCreateProofBody, type DaemonRotationRequestBody, type HappySessionExecutionProof, type SessionExecutionCreateBody, type RotationObservation } from '@slopus/happy-wire'
import type { Metadata, Session } from '@/api/types'
import { type SessionPersistenceResult, type PersistedSession } from '@/persistence'
import { encodeBase64, decodeBase64, decrypt } from '@/api/encryption'
import { buildReconnectSessionEnvironment, RECONNECT_FRESH_LAUNCH_ENV } from './reconnectSessionEnv'
import { formatSetupTokenBinding, isMachineSetupTokenBinding, readSetupTokenResumeSelection, SETUP_TOKEN_BINDING_ENV,
  type MachineSetupTokenBindingRecord, type SetupTokenBinding, type AiAuthSelection } from './sessionEnv'
import { assertMachineRevision, journalCurrent, type MachineRotationJournal, type MachineRotationJournalRecord } from './machineSetupTokenJournal'
import { MachineRotationError, type MachineSetupTokenProtocol, type MachineRotationResult } from './machineSetupTokenProtocol'
import type { SetupTokenUsageObservation } from './setupTokenAccountSwitch'
import type { TrackedSession } from './types'
import { logger } from '@/ui/logger'

export function createMachineSetupTokenRuntime(deps: {
  allowInitialIssue?(): boolean;
  protocol: MachineSetupTokenProtocol; journal: MachineRotationJournal;
  sessionEnvironment(agent: string, selection: AiAuthSelection, binding: SetupTokenBinding): Promise<Record<string, string>>;
  persist(session: TrackedSession, binding: string): SessionPersistenceResult | Promise<SessionPersistenceResult>;
  recoverPersistence?(session: TrackedSession, binding: string): SessionPersistenceResult | Promise<SessionPersistenceResult>;
  savePrepared(launchId: string, createBodyHash: string, snapshot: PersistedSession): SessionPersistenceResult | Promise<SessionPersistenceResult>;
  loadPrepared(launchId: string, createBodyHash: string): PersistedSession | null | Promise<PersistedSession | null>;
  discoverSession(state: MachineRotationJournalRecord, snapshot: PersistedSession, proof?: HappySessionExecutionProof): Promise<{ id: string; seq: number; metadata: string; metadataVersion: number; agentState: string | null; agentStateVersion: number } | null>;
  findSession(sessionId: string): TrackedSession | undefined;
}) {
  const { protocol, journal } = deps
  const activeLaunches = new Set<string>();
  let recoveryFlight: Promise<TrackedSession[]> | null = null;
  const flight = new Map<string, Promise<Record<string, string>>>()
  const serial = <T>(id: string, operation: () => Promise<T>): Promise<T> => {
    // All same-launch mutation callers join the same operation, including resume after a timed-out rebind.
    const prior = flight.get(id)
    if (prior) return prior as Promise<T>
    const result = operation().finally(() => flight.delete(id)); flight.set(id, result as Promise<Record<string, string>>); return result
  }
  const bindingOf = (raw: string): MachineSetupTokenBindingRecord => {
    const parsed = readSetupTokenResumeSelection({ [SETUP_TOKEN_BINDING_ENV]: raw })?.binding
    if (!parsed || !isMachineSetupTokenBinding(parsed)) throw new MachineRotationError('NOT_BOUND')
    return parsed
  }
  async function validateAuthority(binding: MachineSetupTokenBindingRecord) {
    const authority = await protocol.authority();
    if (binding.companyId !== protocol.config.companyId || binding.machineId !== protocol.config.machineId
      || binding.approvalId !== authority.approvalId || binding.deviceKeyId !== authority.deviceKeyId) throw new MachineRotationError('FORBIDDEN');
  }
  async function environment(binding: MachineSetupTokenBindingRecord) {
    await validateAuthority(binding)
    return deps.sessionEnvironment('claude', { kind: 'claude-setup-token', managedAccountId: binding.managedAccountId,
      credentialGeneration: binding.credentialGeneration, groupScope: binding.groupScope }, binding)
  }
  async function queryOrRetry(request: DaemonRotationRequestBody, signal?: AbortSignal, allowSelection = true): Promise<MachineRotationResult> {
    try { return await protocol.post(await protocol.query(request.launchId, request.operationId), true, signal) }
    catch (error) { if (!(error instanceof MachineRotationError) || error.reason !== 'OPERATION_NOT_FOUND') throw error }
    if (!allowSelection) throw new MachineRotationError('ISSUANCE_DISABLED');
    return protocol.post(request, false, signal)
  }
  async function finish(state: MachineRotationJournalRecord, session: TrackedSession, recovering = false, requireLive = true, returnToken = true, signal?: AbortSignal): Promise<Record<string, string>> {
    const pending = state.pending
    if (!pending?.record || !pending.binding || !pending.bindingDigest || !session.happySessionId) throw new MachineRotationError('PERSISTENCE_FAILED')
    const next = bindingOf(pending.record), sessionId = session.happySessionId
    if (next.execution.sessionId !== sessionId) throw new MachineRotationError('FORBIDDEN')
    assertMachineRevision(journalCurrent(state), next)
    const fields = { launchId: state.launchId, sessionId, nonce: next.nonce, bindingRevision: next.bindingRevision }
    const live = () => { signal?.throwIfAborted(); if (requireLive && session.pid > 0 && deps.findSession(sessionId) !== session) throw new MachineRotationError('NOT_BOUND') }
    live()
    // Same action IDs survive a crash. Query is authenticated and bound to the stored execution.
    const claim = await protocol.request({ action: 'claim', operationId: pending.claimOperationId, ...fields })
    const claimed = recovering ? await queryOrRetry(claim, signal) : await protocol.post(claim, false, signal)
    if (!['claimed', 'committed'].includes(claimed.state)) throw new MachineRotationError('BINDING_REJECTED')
    // Never hand a token to the provider before local publication AND Studio commit ACK.
    live()
    const recovered = recovering ? await deps.recoverPersistence?.(session, pending.record) : undefined
    const saved = recovered?.status === 'committed' ? recovered : await deps.persist(session, pending.record)
    if (saved.status !== 'committed') throw new MachineRotationError(saved.status === 'failed' ? 'PERSISTENCE_FAILED' : 'PERSISTENCE_INDETERMINATE')
    const commit = await protocol.request({ action: 'commit', operationId: pending.commitOperationId, ...fields, bindingDigest: pending.bindingDigest })
    const committed = recovering ? await queryOrRetry(commit, signal) : await protocol.post(commit, false, signal)
    if (committed.state !== 'committed') throw new MachineRotationError('REQUEST_FAILED')
    await journal.write({ version: 1, launchId: state.launchId, current: pending.record, currentOperationId: pending.request.operationId, startSubmitted: state.startSubmitted })
    if (deps.findSession(sessionId) && deps.findSession(sessionId) !== session) throw new MachineRotationError('NOT_BOUND')
    live()
    if (!returnToken) return {};
    const env = await environment(next); live(); return env;
  }
  async function recover(binding: MachineSetupTokenBindingRecord, session: TrackedSession, requireLive = true, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const state = await journal.read(binding.launchId)
    if (!state) throw new MachineRotationError('PERSISTENCE_FAILED')
    const current = journalCurrent(state)
    if (current && ((!state.pending && current.bindingRevision < binding.bindingRevision) || current.execution.sessionId !== binding.execution.sessionId)) throw new MachineRotationError('STALE')
    if (state.pending) {
      const result = await queryOrRetry(state.pending.request, signal)
      if (result.state === 'exhausted') {
        if (!current) throw new MachineRotationError('NO_ACCOUNT')
        await journal.write({ version: 1, launchId: state.launchId, current: state.current, currentOperationId: state.currentOperationId, startSubmitted: state.startSubmitted });
        throw new MachineRotationError('NO_ACCOUNT')
      }
      if (!result.binding) throw new MachineRotationError('BINDING_REJECTED')
      const body = await protocol.verifyBinding(result.binding, binding.launchId, true)
      if (state.pending.binding && await rotationDigest(state.pending.binding) !== await rotationDigest(body)) throw new MachineRotationError('STALE')
      const next = { ...body, execution: binding.execution }
      state.pending = { ...state.pending, binding: body, bindingDigest: await rotationDigest(result.binding), record: formatSetupTokenBinding(next) }
      await journal.write(state)
      return finish(state, session, true, requireLive, true, signal)
    }
    if (!current) throw new MachineRotationError('PERSISTENCE_FAILED')
    // Revalidate execution/current company on every reconnect without selecting another account.
    if (!state.currentOperationId) throw new MachineRotationError('PERSISTENCE_FAILED');
    const result = await protocol.post(await protocol.query(current.launchId, state.currentOperationId), true, signal)
    const { execution: _execution, ...claims } = current;
    if (result.state !== 'committed' || !result.binding || await rotationDigest(result.binding.body) !== await rotationDigest(claims)) throw new MachineRotationError('REQUEST_FAILED')
    // The daemon's journal is authoritative when a child missed a completed switch.
    if (session.agentEnvironment?.[SETUP_TOKEN_BINDING_ENV] !== state.current) {
      if ((await deps.persist(session, state.current!)).status !== 'committed') throw new MachineRotationError('PERSISTENCE_FAILED')
    }
    signal?.throwIfAborted();
    return environment(current)
  }
  async function recoverLaunches() {
    const recoveredSessions: TrackedSession[] = [];
    // Initial creates have no child yet. Reconstruct only from the exact encrypted body,
    // original credential custody and authenticated execution relation; never select again.
    for (const id of await journal.list()) {
      if (activeLaunches.has(id)) continue;
      try {
      const state = await journal.read(id), pending = state?.pending;
      if (!state || state.current || !pending || pending.request.action !== 'issue') continue;
      if (!pending.createBody) throw new MachineRotationError('PERSISTENCE_INDETERMINATE');
      const snapshot = await deps.loadPrepared(id, pending.request.sessionCreateBodyHash);
      if (!snapshot) throw new MachineRotationError('PERSISTENCE_INDETERMINATE');
      const issued = await queryOrRetry(pending.request, undefined, deps.allowInitialIssue?.() ?? true);
      if (issued.state === 'exhausted') { await journal.write({ version: 1, launchId: id }); continue; }
      if (!issued.binding) throw new MachineRotationError('BINDING_REJECTED');
      const body = await protocol.verifyBinding(issued.binding, id, true);
      if (pending.binding && await rotationDigest(pending.binding) !== await rotationDigest(body)) throw new MachineRotationError('STALE');
      if (!issued.executionTicket || !pending.machineOwnerAccountId) throw new MachineRotationError('BINDING_REJECTED');
      await verifyRotationDocument(issued.executionTicket, rotationDecodeBinary(protocol.config.studioPublicKey, 32));
      const ticket = issued.executionTicket.body, authority = await protocol.authority();
      if (ticket.audience !== protocol.config.happyOrigin || ticket.studioOrigin !== protocol.config.studioOrigin || ticket.keyId !== body.keyId
        || ticket.companyId !== body.companyId || ticket.machineId !== body.machineId || ticket.approvalId !== authority.approvalId
        || ticket.deviceKeyId !== authority.deviceKeyId || await rotationSha256(rotationDecodeBinary(ticket.deviceSigningPublicKey, 32)) !== authority.deviceKeyId
        || ticket.launchId !== id || ticket.initialNonce !== body.nonce || ticket.operationId !== pending.request.operationId
        || ticket.sessionOwnerAccountId !== pending.request.sessionOwnerAccountId || ticket.machineOwnerAccountId !== pending.machineOwnerAccountId
        || ticket.sessionTagHash !== pending.request.sessionTagHash || ticket.sessionCreateBodyHash !== pending.request.sessionCreateBodyHash
        || await sessionCreateBodyHash(pending.createBody) !== pending.request.sessionCreateBodyHash) throw new MachineRotationError('BINDING_REJECTED');
      const proofBody = pending.createProofBody ?? { version: 1 as const, type: 'happy-session-create-proof' as const, audience: protocol.config.happyOrigin,
        method: 'POST' as const, path: '/v1/sessions' as const, ticketDigest: await rotationDigest(issued.executionTicket),
        sessionOwnerAccountId: pending.request.sessionOwnerAccountId, sessionTagHash: pending.request.sessionTagHash,
        sessionCreateBodyHash: pending.request.sessionCreateBodyHash, issuedAt: protocol.now(), expiresAt: Math.min(ticket.expiresAt, protocol.now() + 60000) };
      state.pending = { ...pending, binding: body, ...(rotationIsFresh(proofBody, protocol.now()) ? { createProofBody: proofBody } : {}) };
      await journal.write(state);
      const proof = rotationIsFresh(ticket, protocol.now()) && rotationIsFresh(proofBody, protocol.now())
        ? { ticket: issued.executionTicket, deviceProof: await protocol.sign(proofBody) } : undefined;
      const raw = await deps.discoverSession(state, snapshot, proof);
      if (!raw) throw new MachineRotationError('PERSISTENCE_INDETERMINATE');
      const binding: MachineSetupTokenBindingRecord = { ...body, execution: { sessionId: raw.id, initialNonce: body.nonce,
        issueOperationId: pending.request.operationId, sessionOwnerAccountId: pending.request.sessionOwnerAccountId,
        machineOwnerAccountId: pending.machineOwnerAccountId } };
      // Query must return the original ticket body, not a replacement Happy owner.
      if (!binding.execution.machineOwnerAccountId) throw new MachineRotationError('BINDING_REJECTED');
      const encryptionKey = decodeBase64(snapshot.encryptionKey), encryptionVariant = snapshot.encryptionVariant;
      const metadata = decrypt(encryptionKey, encryptionVariant, decodeBase64(raw.metadata)) as Metadata;
      if (!metadata || metadata.setupTokenRotation?.bindingVersion !== 2) throw new MachineRotationError('BINDING_REJECTED');
      const tracked: TrackedSession = { pid: 0, startedBy: 'daemon', happySessionId: raw.id, happySessionMetadataFromLocalWebhook: metadata,
        encryption: { encryptionKey, encryptionVariant, seq: raw.seq, metadataVersion: raw.metadataVersion, agentStateVersion: raw.agentStateVersion },
        userHomeDir: snapshot.userHomeDir, persistedLastProcessedSeq: 0 };
      state.pending = { ...pending, binding: body, bindingDigest: await rotationDigest(issued.binding), record: formatSetupTokenBinding(binding) };
      await journal.write(state);
      await finish(state, tracked, true, false, false);
      recoveredSessions.push(tracked);
      } catch (error) {
        // Keep this launch fenced and its evidence intact; it must not block unrelated launches.
        const code = error instanceof MachineRotationError ? error.reason : 'RECOVERY_FAILED';
        logger.warn(`[machine-rotation] Recovery blocked for ${createHash('sha256').update(id).digest('hex').slice(0, 12)}: ${code}`);
      }
    }
    return recoveredSessions;
  }
  return {
    validateAuthority,
    async canStartWithoutConversation(binding: MachineSetupTokenBindingRecord) {
      const state = await journal.read(binding.launchId);
      return !!state && !state.pending && !state.startSubmitted && binding.bindingRevision === 1 && state.current === formatSetupTokenBinding(binding);
    },
    async recordProviderStart(binding: MachineSetupTokenBindingRecord) {
      await validateAuthority(binding);
      const state = await journal.read(binding.launchId);
      if (!state || state.pending || state.current !== formatSetupTokenBinding(binding)) throw new MachineRotationError('STALE');
      // Durable before process submission; an uncertain outcome cannot authorize a fresh conversation.
      if (!state.startSubmitted) await journal.write({ ...state, startSubmitted: true });
    },
    recoverLaunches() { recoveryFlight ??= recoverLaunches().finally(() => { recoveryFlight = null }); return recoveryFlight; },
    async prepareLaunch(input: {
      metadata: Metadata; ownerAccountId: string; machineOwnerAccountId: string; userHomeDir?: string;
      createSession(input: { tag: string; metadata: Metadata; state: { controlledByUser: false }; executionProof(body: Readonly<SessionExecutionCreateBody>, encryption: { encryptionKey: Uint8Array; encryptionVariant: 'legacy' | 'dataKey' }): Promise<HappySessionExecutionProof> }): Promise<Session | null>;
    }) {
      await protocol.checkPublicKey()
      const launchId = randomUUID(), tag = randomUUID()
      activeLaunches.add(launchId);
      try {
      let state: MachineRotationJournalRecord | undefined
      const metadata = { ...input.metadata, setupTokenRotation: { version: 1 as const, principalType: 'machine' as const, bindingVersion: 2 as const } }
      const session = await input.createSession({ tag, metadata, state: { controlledByUser: false }, executionProof: async (body, encryption) => {
        const hashes = { sessionTagHash: await sessionTagHash(body.tag), sessionCreateBodyHash: await sessionCreateBodyHash(body) }
        const request = await protocol.request({ action: 'issue', operationId: randomUUID(), launchId, sessionOwnerAccountId: input.ownerAccountId, ...hashes })
        const saved = await deps.savePrepared(launchId, hashes.sessionCreateBodyHash, { ...encryption, encryptionKey: encodeBase64(encryption.encryptionKey),
          seq: 0, metadataVersion: 0, agentStateVersion: 0, metadata, savedAt: protocol.now(), userHomeDir: input.userHomeDir, lastProcessedSeq: 0 });
        if (saved.status !== 'committed') throw new MachineRotationError('PERSISTENCE_INDETERMINATE');
        state = { version: 1, launchId, pending: { request, createBody: body, machineOwnerAccountId: input.machineOwnerAccountId, claimOperationId: randomUUID(), commitOperationId: randomUUID() } }
        await journal.write(state)
        const issued = await protocol.post(request)
        if (issued.state === 'exhausted') throw new MachineRotationError('NO_ACCOUNT')
        if (!issued.binding || !issued.executionTicket || issued.state !== 'pending') throw new MachineRotationError('BINDING_REJECTED')
        const binding = await protocol.verifyBinding(issued.binding, launchId)
        await verifyRotationDocument(issued.executionTicket, rotationDecodeBinary(protocol.config.studioPublicKey, 32))
        const t = issued.executionTicket.body
        const a = await protocol.authority()
        if (!rotationIsFresh(t, protocol.now()) || t.audience !== protocol.config.happyOrigin || t.studioOrigin !== protocol.config.studioOrigin
          || t.keyId !== binding.keyId || t.companyId !== binding.companyId || t.machineId !== binding.machineId || t.approvalId !== a.approvalId
          || t.deviceKeyId !== a.deviceKeyId || await rotationSha256(rotationDecodeBinary(t.deviceSigningPublicKey, 32)) !== a.deviceKeyId || t.launchId !== launchId || t.initialNonce !== binding.nonce || t.operationId !== request.operationId
          || t.sessionOwnerAccountId !== input.ownerAccountId || t.machineOwnerAccountId !== input.machineOwnerAccountId
          || t.sessionTagHash !== hashes.sessionTagHash || t.sessionCreateBodyHash !== hashes.sessionCreateBodyHash) throw new MachineRotationError('BINDING_REJECTED')
        const createProofBody: HappySessionCreateProofBody = { version: 1, type: 'happy-session-create-proof', audience: protocol.config.happyOrigin,
          method: 'POST', path: '/v1/sessions', ticketDigest: await rotationDigest(issued.executionTicket), sessionOwnerAccountId: input.ownerAccountId,
          ...hashes, issuedAt: protocol.now(), expiresAt: Math.min(t.expiresAt, protocol.now() + 60000) };
        state.pending = { ...state.pending!, binding, bindingDigest: await rotationDigest(issued.binding), createProofBody }
        await journal.write(state)
        return { ticket: issued.executionTicket, deviceProof: await protocol.sign(createProofBody) }
      } })
      if (!session || !state?.pending?.binding || state.pending.request.action !== 'issue') throw new MachineRotationError('REQUEST_FAILED')
      const binding: MachineSetupTokenBindingRecord = { ...state.pending.binding, execution: { sessionId: session.id, initialNonce: state.pending.binding.nonce,
        issueOperationId: state.pending.request.operationId, sessionOwnerAccountId: input.ownerAccountId, machineOwnerAccountId: input.machineOwnerAccountId } }
      state.pending.record = formatSetupTokenBinding(binding)
      await journal.write(state)
      const tracked: TrackedSession = { pid: 0, startedBy: 'daemon', happySessionId: session.id, happySessionMetadataFromLocalWebhook: session.metadata,
        encryption: { encryptionKey: session.encryptionKey, encryptionVariant: session.encryptionVariant, seq: session.seq, metadataVersion: session.metadataVersion,
          agentStateVersion: session.agentStateVersion }, userHomeDir: input.userHomeDir, persistedLastProcessedSeq: session.seq }
      if ((await deps.persist(tracked, state.pending.record)).status !== 'committed') throw new MachineRotationError('PERSISTENCE_FAILED');
      const env = await finish(state, tracked)
      return { session, environment: env, reconnectEnvironment: { ...buildReconnectSessionEnvironment({ sessionId: session.id, encryption: tracked.encryption!,
        serverSnapshot: { metadata: session.metadata, seq: session.seq, metadataVersion: session.metadataVersion, agentStateVersion: session.agentStateVersion }, baselineSeq: session.seq }), [RECONNECT_FRESH_LAUNCH_ENV]: '1' as const } }
      } finally { activeLaunches.delete(launchId); }
    },
    resume(session: TrackedSession, binding: MachineSetupTokenBindingRecord) {
      if (activeLaunches.has(binding.launchId)) return Promise.reject(new MachineRotationError('LAUNCH_IN_PROGRESS'));
      return serial(binding.launchId, () => recover(binding, session, false)) },
    async reportUsage(sessionId: string, running: string, observation: SetupTokenUsageObservation, signal?: AbortSignal) {
      signal?.throwIfAborted();
      const binding = bindingOf(running), session = deps.findSession(sessionId)
      if (!session || session.agentEnvironment?.[SETUP_TOKEN_BINDING_ENV] !== running || binding.execution.sessionId !== sessionId) throw new MachineRotationError('STALE')
      const request = await protocol.request({ action: 'usage', operationId: randomUUID(), launchId: binding.launchId, sessionId,
        nonce: binding.nonce, bindingRevision: binding.bindingRevision, observation: toRotationObservation(binding, observation) })
      const result = await protocol.post(request, false, signal)
      if (result.state !== 'recorded') throw new MachineRotationError('REQUEST_FAILED')
      return { ok: true as const }
    },
    rebind(sessionId: string, running: string, observation?: SetupTokenUsageObservation, signal?: AbortSignal) {
      const binding = bindingOf(running)
      return serial(binding.launchId, async () => {
        signal?.throwIfAborted();
        const session = deps.findSession(sessionId)
        if (!session || binding.execution.sessionId !== sessionId) throw new MachineRotationError('NOT_BOUND')
        const state = await journal.read(binding.launchId)
        if (!state) throw new MachineRotationError('PERSISTENCE_FAILED')
        if (state.pending) return recover(binding, session, true, signal)
        const current = journalCurrent(state)
        if (!current || current.bindingRevision < binding.bindingRevision) throw new MachineRotationError('STALE')
        if (current.bindingRevision > binding.bindingRevision) return recover(binding, session, true, signal)
        if (formatSetupTokenBinding(current) !== running || session.agentEnvironment?.[SETUP_TOKEN_BINDING_ENV] !== running) throw new MachineRotationError('STALE')
        if (!observation) throw new MachineRotationError('REQUEST_FAILED')
        if (current.bindingRevision >= 6) throw new MachineRotationError('ROTATION_LIMIT')
        const request = await protocol.request({ action: 'rebind', operationId: randomUUID(), launchId: binding.launchId, sessionId,
          nonce: binding.nonce, bindingRevision: binding.bindingRevision, observation: toRotationObservation(binding, observation) })
        state.pending = { request, claimOperationId: randomUUID(), commitOperationId: randomUUID() }
        await journal.write(state)
        const result = await protocol.post(request, false, signal)
        if (deps.findSession(sessionId) !== session) throw new MachineRotationError('NOT_BOUND')
        if (result.state === 'exhausted') { await journal.write({ version: 1, launchId: state.launchId, current: state.current, currentOperationId: state.currentOperationId, startSubmitted: state.startSubmitted }); throw new MachineRotationError('NO_ACCOUNT') }
        if (!result.binding || result.state !== 'pending') throw new MachineRotationError('BINDING_REJECTED')
        const body = await protocol.verifyBinding(result.binding, binding.launchId)
        const next = { ...body, execution: current.execution }; assertMachineRevision(current, next)
        state.pending = { ...state.pending, binding: body, bindingDigest: await rotationDigest(result.binding), record: formatSetupTokenBinding(next) }
        await journal.write(state)
        return finish(state, session, false, true, true, signal)
      })
    },
  }
}
function toRotationObservation(binding: MachineSetupTokenBindingRecord, observation: SetupTokenUsageObservation): RotationObservation {
  return { observationId: observation.observationId ?? createHash('sha256').update(JSON.stringify([binding.nonce, observation])).digest('hex'), observedAt: observation.observedAt,
    managedAccountId: binding.managedAccountId, credentialGeneration: binding.credentialGeneration,
    windows: observation.windows.filter(w => w.pct !== null).map(w => ({ kind: w.kind === 'unified5h' ? 'five_hour' : 'seven_day',
      utilizationBps: Math.round(w.pct! * 100), resetsAt: w.resetsAt })), accountWideRefusal: observation.reason === 'rate-limited' ? 'account_limit' : null }
}
export type MachineSetupTokenRuntime = ReturnType<typeof createMachineSetupTokenRuntime>
