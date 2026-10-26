/** Personal same-account authority for the agent broker (Desktop P0a §4.4).
 * The runtime adapter must supply HTTP authentication, signature/key policy and independent local registration state.
 * An absent adapter is unknown, never evidence of a personal machine. */
import { MachineAgentIdentitySchema, type MachineAgentIdentity } from '@slopus/happy-wire'

export type AgentIdentityDescriptor = MachineAgentIdentity
export interface AgentIdentityState {
  machineId: string; happyAccountId: string; registrationRevision: string; epoch: string
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
  return { async inspect(targetSessionId) {
    if (!deps || !targetSessionId) return unknown('identity-unavailable')
    try {
      const current = deps.readState()
      if (!current?.machineId || !current.happyAccountId || !current.epoch || !/^[a-f0-9]{64}$/.test(current.registrationRevision)) return unknown('identity-unknown')
      const state = { ...current }
      // Epoch is local host state, not a field in A+'s signed descriptor. Keep it
      // in the same live registration fence across every asynchronous boundary.
      const unchanged = () => {
        const latest = deps.readState()
        return latest?.epoch === state.epoch && latest.machineId === state.machineId
          && latest.happyAccountId === state.happyAccountId && latest.registrationRevision === state.registrationRevision
      }
      const rawDescriptor = await deps.fetchDescriptor(state)
      if (!unchanged()) return unknown('identity-changed')
      const parsed = MachineAgentIdentitySchema.safeParse(rawDescriptor)
      if (!parsed.success) return unknown('identity-unproven')
      const descriptor = parsed.data
      const valid = () => descriptor.registrationType === 'personal' && descriptor.accountKind === 'personal'
        && descriptor.ownerSubject?.issuer === descriptor.issuer && descriptor.machineId === state.machineId && descriptor.happyAccountId === state.happyAccountId
        && descriptor.registrationRevision === state.registrationRevision && descriptor.observedAt <= deps.now()
        && descriptor.expiresAt > deps.now() && descriptor.expiresAt - descriptor.observedAt <= 60_000
        && descriptor.expiresAt > descriptor.observedAt
      if (!valid() || !await deps.verifyDescriptor(rawDescriptor, state)) return unknown('identity-unproven')
      if (!unchanged()) return unknown('identity-changed')
      if (!valid()) return unknown('identity-unproven')
      const account = await deps.targetAccount(targetSessionId, state)
      if (!unchanged() || !valid()) {
        return unknown('identity-changed')
      }
      if (!account) return unknown('target-owner-unknown')
      return account === state.happyAccountId
        ? { relation: 'own-sibling', proof: 'personal-same-account', reason: 'same-account' }
        : { relation: 'other', proof: null, reason: 'different-account' }
    } catch { return unknown('identity-unavailable') }
  } }
}
