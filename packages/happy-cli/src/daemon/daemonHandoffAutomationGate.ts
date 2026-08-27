export type AutomationAwareHandoffDecision =
  | 'run-automations'
  | 'defer-handoff'
  | 'handoff'

export function decideAutomationAwareHandoff(input: {
  bundleReplaced: boolean
  legacyAutomationRunning: boolean
  serverAutomationRunning: boolean
}): AutomationAwareHandoffDecision {
  if (!input.bundleReplaced) return 'run-automations'
  if (input.legacyAutomationRunning || input.serverAutomationRunning) return 'defer-handoff'
  return 'handoff'
}
