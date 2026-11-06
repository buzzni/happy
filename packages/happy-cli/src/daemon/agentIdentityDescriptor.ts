/** The agent broker's sibling ownership answer (Desktop P0a §4.4). A broker without an authority answers unknown,
 * never evidence of a personal machine. */
export interface AgentOwnershipVerdict {
  relation: 'own-sibling' | 'other' | 'unknown'; proof: 'personal-same-account' | null; reason: string
}
export interface AgentIdentityAuthority {
  inspect(targetSessionId: string): Promise<AgentOwnershipVerdict>
  /** One observation for up to 100 targets; every requested id is answered. */
  inspectMany?(targetSessionIds: string[]): Promise<Record<string, AgentOwnershipVerdict>>
}
export const unavailableAgentIdentityAuthority: AgentIdentityAuthority = {
  inspect: async () => ({ relation: 'unknown', proof: null, reason: 'identity-unavailable' }),
}
