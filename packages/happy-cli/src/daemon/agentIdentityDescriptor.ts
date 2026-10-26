/** Personal same-account authority for the agent broker (Desktop P0a §4.4).
 * The runtime adapter must supply HTTP authentication, signature/key policy and local machine/account registration state.
 * An absent adapter is unknown, never evidence of a personal machine. */
import { MachineAgentIdentitySchema, type MachineAgentIdentity } from '@slopus/happy-wire'

export type AgentIdentityDescriptor = MachineAgentIdentity
export interface AgentIdentityState {
  machineId: string; happyAccountId: string; epoch: string
}
export interface AgentOwnershipVerdict {
  relation: 'own-sibling' | 'other' | 'unknown'; proof: 'personal-same-account' | null; reason: string
}
export interface AgentIdentityAuthority { inspect(targetSessionId: string): Promise<AgentOwnershipVerdict> }
export interface AgentIdentityDependencies {
  /** Daemon-owned runtime-home identity, never request env/metadata. */
  readState(): AgentIdentityState | null
  fetchDescriptor(state: AgentIdentityState): Promise<unknown>
  /** Must verify the unmodified fetched document's issuer/audience/key/signature against registered server authority. */
  verifyDescriptor(descriptor: unknown, state: AgentIdentityState): Promise<boolean>
  /** Authenticated Happy ownership lookup; list visibility is not ownership. */
  targetAccount(targetSessionId: string, state: AgentIdentityState): Promise<string | null>
  now(): number
}
const unknown = (reason: string): AgentOwnershipVerdict => ({ relation: 'unknown', proof: null, reason })

export function createAgentIdentityAuthority(deps?: AgentIdentityDependencies): AgentIdentityAuthority {
  let bound: { state: AgentIdentityState; descriptor: MachineAgentIdentity } | null = null
  let invalidated = false
  const sameBinding = (state: AgentIdentityState, value: MachineAgentIdentity) => !bound || (
    bound.state.epoch === state.epoch && bound.state.machineId === state.machineId && bound.state.happyAccountId === state.happyAccountId
    && bound.descriptor.machineId === value.machineId && bound.descriptor.happyAccountId === value.happyAccountId
    && bound.descriptor.registrationRevision === value.registrationRevision
    && bound.descriptor.ownerSubject?.issuer === value.ownerSubject?.issuer
    && bound.descriptor.ownerSubject?.userId === value.ownerSubject?.userId)
  const changed = () => { invalidated = true; return unknown('identity-changed') }
  return { async inspect(targetSessionId) {
    if (invalidated) return changed()
    if (!deps || !targetSessionId) return unknown('identity-unavailable')
    try {
      const current = deps.readState()
      if (!current?.machineId || !current.happyAccountId || !current.epoch) return unknown('identity-unknown')
      const state = { ...current }
      // Epoch is local host state, not a field in A+'s signed descriptor. Keep it
      // in the same live registration fence across every asynchronous boundary.
      const unchanged = () => {
        const latest = deps.readState()
        return latest?.epoch === state.epoch && latest.machineId === state.machineId
          && latest.happyAccountId === state.happyAccountId
      }
      const rawDescriptor = await deps.fetchDescriptor(state)
      if (!unchanged()) return changed()
      const parsed = MachineAgentIdentitySchema.safeParse(rawDescriptor)
      if (!parsed.success) return unknown('identity-unproven')
      const descriptor = parsed.data
      if (!sameBinding(state, descriptor)) return changed()
      const valid = () => descriptor.registrationType === 'personal' && descriptor.accountKind === 'personal'
        && descriptor.ownerSubject?.issuer === descriptor.issuer && descriptor.machineId === state.machineId && descriptor.happyAccountId === state.happyAccountId
        && descriptor.observedAt <= deps.now()
        && descriptor.expiresAt > deps.now() && descriptor.expiresAt - descriptor.observedAt <= 60_000
        && descriptor.expiresAt > descriptor.observedAt
      if (!valid() || !await deps.verifyDescriptor(rawDescriptor, state)) return unknown('identity-unproven')
      if (!unchanged()) return changed()
      if (!valid()) return unknown('identity-unproven')
      const account = await deps.targetAccount(targetSessionId, state)
      if (!unchanged() || !valid()) {
        return changed()
      }
      if (invalidated || !sameBinding(state, descriptor)) return changed()
      bound ??= { state, descriptor }
      if (!account) return unknown('target-owner-unknown')
      return account === state.happyAccountId
        ? { relation: 'own-sibling', proof: 'personal-same-account', reason: 'same-account' }
        : { relation: 'other', proof: null, reason: 'different-account' }
    } catch { return unknown('identity-unavailable') }
  } }
}
