/** Personal same-account authority for the agent broker (Desktop P0a §4.4).
 * The T4o adapter owns HTTP authentication, signature/key policy and registration lookup.
 * An absent adapter is unknown, never evidence of a personal machine. */
import { z } from 'zod'

const descriptorSchema = z.object({
  descriptorId: z.string().min(1), machineId: z.string().min(1), happyAccountId: z.string().min(1),
  epoch: z.string().min(1),
  ownerSubject: z.object({ issuer: z.string().min(1), userId: z.string().min(1) }),
  registrationType: z.literal('personal'), accountKind: z.literal('personal'),
  registrationRevision: z.number().int().nonnegative(), observedAt: z.number().finite(), expiresAt: z.number().finite(),
  issuer: z.string().min(1), audience: z.string().min(1), keyId: z.string().min(1), signature: z.string().min(1),
})
export type AgentIdentityDescriptor = z.infer<typeof descriptorSchema>
export interface AgentIdentityState {
  machineId: string; happyAccountId: string; registrationRevision: number; epoch: string
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
      if (!current?.machineId || !current.happyAccountId || !current.epoch) return unknown('identity-unknown')
      const state = { ...current }
      const rawDescriptor = await deps.fetchDescriptor(state)
      const parsed = descriptorSchema.safeParse(rawDescriptor)
      if (!parsed.success) return unknown('identity-unproven')
      const descriptor = parsed.data
      const valid = () => descriptor.machineId === state.machineId && descriptor.happyAccountId === state.happyAccountId
        && descriptor.epoch === state.epoch && descriptor.registrationRevision === state.registrationRevision && descriptor.observedAt <= deps.now()
        && descriptor.expiresAt > deps.now() && descriptor.expiresAt - descriptor.observedAt <= 60_000
        && descriptor.expiresAt > descriptor.observedAt
      if (!valid() || !await deps.verifyDescriptor(rawDescriptor, state)) return unknown('identity-unproven')
      const account = await deps.targetAccount(targetSessionId, state)
      const latest = deps.readState()
      if (!latest || latest.epoch !== state.epoch || latest.machineId !== state.machineId
        || latest.happyAccountId !== state.happyAccountId || latest.registrationRevision !== state.registrationRevision || !valid()) {
        return unknown('identity-changed')
      }
      if (!account) return unknown('target-owner-unknown')
      return account === state.happyAccountId
        ? { relation: 'own-sibling', proof: 'personal-same-account', reason: 'same-account' }
        : { relation: 'other', proof: null, reason: 'different-account' }
    } catch { return unknown('identity-unavailable') }
  } }
}
