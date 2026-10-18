/** Recovers an uncertain initial create through existing authenticated APIs; exact proof replay never selects again. */
import { z } from 'zod'
import { ExecutionOwnerResponseSchema, type HappySessionExecutionProof, type SessionExecutionCreateBody } from '@slopus/happy-wire'
import type { MachineRotationJournalRecord } from './machineSetupTokenJournal'
import { MachineRotationError } from './machineSetupTokenProtocol'

const rawSession = z.object({ id: z.string(), seq: z.number().int().nonnegative(), metadata: z.string(), metadataVersion: z.number().int().nonnegative(),
  agentState: z.string().nullable(), agentStateVersion: z.number().int().nonnegative(), dataEncryptionKey: z.string().nullable() })
const pageSchema = z.object({ sessions: z.array(rawSession), nextCursor: z.string().nullable(), hasNext: z.boolean() })
export async function discoverMachineSetupTokenSession(input: {
  happyOrigin: string; ownerBearer: string; machineBearer: string; state: MachineRotationJournalRecord; executionProof?: HappySessionExecutionProof; fetch?: typeof fetch;
}) {
  const { state } = input, pending = state.pending, request = pending?.request, body: SessionExecutionCreateBody | undefined = pending?.createBody
  if (!pending?.binding || request?.action !== 'issue' || !body || !pending.machineOwnerAccountId) throw new MachineRotationError('PERSISTENCE_FAILED')
  const { companyId, machineId } = request, initialNonce = pending.binding.nonce, machineOwnerAccountId = pending.machineOwnerAccountId;
  const fetcher = input.fetch ?? fetch
  async function json(path: string, bearer: string, payload?: unknown) {
    const response = await fetcher(input.happyOrigin + path, { method: payload ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }, ...(payload ? { body: JSON.stringify(payload) } : {}) })
    if (!response.ok) throw new MachineRotationError(response.status === 401 || response.status === 403 ? 'FORBIDDEN' : 'REQUEST_FAILED')
    return response.json()
  }
  // Read the actual session owner, including staged personal accounts, not the daemon's account.
  const profile = z.object({ id: z.string() }).parse(await json('/v1/account/profile', input.ownerBearer))
  if (profile.id !== request.sessionOwnerAccountId) throw new MachineRotationError('FORBIDDEN')
  async function verifyExecution(session: z.infer<typeof rawSession>) {
    const relation = ExecutionOwnerResponseSchema.parse(await json(`/v1/machine-sessions/${encodeURIComponent(session.id)}/execution-owner`, input.machineBearer,
      { companyId, machineId, launchId: state.launchId, initialNonce })).owner
    if (!relation || relation.sessionId !== session.id || relation.companyId !== companyId || relation.machineId !== machineId
      || relation.launchId !== state.launchId || relation.initialNonce !== initialNonce || relation.sessionOwnerAccountId !== profile.id
      || relation.machineOwnerAccountId !== machineOwnerAccountId) throw new MachineRotationError('FORBIDDEN')
    return session;
  }
  const cursors = new Set<string>(); let cursor: string | null = null
  for (;;) {
    const page = pageSchema.parse(await json(`/v2/sessions?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, input.ownerBearer))
    for (const session of page.sessions) {
      if (session.metadata !== body.metadata || session.agentState !== body.agentState || session.dataEncryptionKey !== body.dataEncryptionKey) continue
      return verifyExecution(session)
    }
    if (!page.hasNext) {
      if (!input.executionProof) return null;
      // Exact same body + deterministic original proof. Expired/unknown authority never takes this path.
      const created = z.object({ session: rawSession }).parse(await json('/v1/sessions', input.ownerBearer, { ...body, executionProof: input.executionProof }));
      return verifyExecution(created.session);
    }
    if (!page.nextCursor || cursors.has(page.nextCursor)) throw new MachineRotationError('REQUEST_FAILED')
    cursors.add(page.nextCursor); cursor = page.nextCursor
  }
}
