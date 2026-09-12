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
  // Interactive/terminal sessions live for hours. Handoff still waits for them, but
  // pausing the runners meanwhile starved server session follow-ups until every
  // session on the machine ended (2026-09-03). Only pause when the sole blockers are
  // in-flight automation work, i.e. when handoff is imminent.
  if ((input.activeSessionCount ?? 0) > 0) return 'run-automations'
  if (input.legacyAutomationRunning
    || input.serverAutomationRunning
    || input.serverAutomationLeaseRunning) return 'defer-handoff'
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
