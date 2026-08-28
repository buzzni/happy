import type { AutomationTickRunner } from './automations/automationTickRunner'

export type AutomationAwareHandoffDecision =
  | 'run-automations'
  | 'defer-handoff'
  | 'handoff'

export function decideAutomationAwareHandoff(input: {
  bundleReplaced: boolean
  legacyAutomationRunning: boolean
  serverAutomationRunning: boolean
  serverAutomationLeaseRunning?: boolean
  activeSessionCount?: number
}): AutomationAwareHandoffDecision {
  if (!input.bundleReplaced) return 'run-automations'
  if (input.legacyAutomationRunning
    || input.serverAutomationRunning
    || input.serverAutomationLeaseRunning
    || (input.activeSessionCount ?? 0) > 0) return 'defer-handoff'
  return 'handoff'
}

export function resumeAutomationRunnersAfterFailedHandoff(input: {
  legacyAutomationEnabled: boolean
  legacyRunner: AutomationTickRunner
  serverRunner: AutomationTickRunner
}): void {
  input.legacyRunner.resume({ trigger: input.legacyAutomationEnabled })
  input.serverRunner.resume({ trigger: true })
}
