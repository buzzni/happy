/** The agent broker's sibling ownership answer (Desktop P0a §4.4). A broker without an authority answers unknown,
 * never evidence of a personal machine. */
export interface AgentOwnershipVerdict {
  relation: 'own-sibling' | 'other' | 'unknown'; proof: 'personal-same-account' | null; reason: string
}
export interface AgentIdentityAuthority { inspect(targetSessionId: string): Promise<AgentOwnershipVerdict> }
export const unavailableAgentIdentityAuthority: AgentIdentityAuthority = {
  inspect: async () => ({ relation: 'unknown', proof: null, reason: 'identity-unavailable' }),
}
