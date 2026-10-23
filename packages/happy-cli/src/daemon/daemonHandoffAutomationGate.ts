import type { AutomationTickRunner } from './automations/automationTickRunner'

/**
 * Bundle-replacement handoff in two stages (aplus specs/codexcli-daemon-restart-drain R4·R25).
 *
 * The old gate waited for "no live session process and no daemon terminal",
 * which on a machine with long-lived sessions never came (2026-09 #336): the
 * replaced bundle sat unused while the old daemon kept running. Sessions are
 * detached and survive a daemon restart, so what actually has to be quiet is
 * narrower — no turn in flight, no automation, no terminal being typed in.
 *
 * - Pre-wait: admission stays open and automation runners keep running
 *   (pausing them starved session follow-ups, 2026-09-03). On each heartbeat,
 *   before that beat's automation ticks start, hand off at the first quiet
 *   moment.
 * - Cap (30 min): stop waiting for a quiet moment and drain (grace 120 s) —
 *   but only while no terminal is busy; a handoff nobody asked for does not
 *   close admission to wait on someone's shell.
 * - Terminal cap (24 h): publish `forceAvailable` so Desktop can offer
 *   "지금 교대"; on the next beat drain with terminals waited up to grace.
 */
export interface PendingHandoff {
  detectedAt: number
  busyTerminalCount: number
  forceAvailable: boolean
}

export type HandoffStep =
  | 'none'
  | 'prewait'
  | 'try-now'
  | 'begin-cap-drain'
  | 'publish-force-available'
  | 'begin-terminal-cap-drain'

export const DEFAULT_HANDOFF_PREWAIT_CAP_MS = 30 * 60 * 1000
export const DEFAULT_HANDOFF_TERMINAL_CAP_MS = 24 * 60 * 60 * 1000

function positiveMs(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return value !== undefined && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/** `HAPPY_DAEMON_HANDOFF_PREWAIT_CAP_MS`·`HAPPY_DAEMON_HANDOFF_TERMINAL_CAP_MS` tune both caps. */
export function readHandoffCaps(env: NodeJS.ProcessEnv = process.env): { prewaitCapMs: number; terminalCapMs: number } {
  return {
    prewaitCapMs: positiveMs(env.HAPPY_DAEMON_HANDOFF_PREWAIT_CAP_MS, DEFAULT_HANDOFF_PREWAIT_CAP_MS),
    terminalCapMs: positiveMs(env.HAPPY_DAEMON_HANDOFF_TERMINAL_CAP_MS, DEFAULT_HANDOFF_TERMINAL_CAP_MS),
  }
}

export function decideHandoffStep(input: {
  bundleReplaced: boolean
  pending: PendingHandoff | null
  now: number
  inTurnCount: number
  automationCount: number
  busyTerminalCount: number
  /** A restart drain is already open; it owns the rest of the handoff. */
  drainOpen: boolean
  prewaitCapMs: number
  terminalCapMs: number
}): HandoffStep {
  if (!input.bundleReplaced || input.drainOpen) return 'none'
  if (input.inTurnCount === 0 && input.automationCount === 0 && input.busyTerminalCount === 0) return 'try-now'
  const waited = input.now - (input.pending?.detectedAt ?? input.now)
  if (input.busyTerminalCount > 0) {
    if (waited < input.terminalCapMs) return 'prewait'
    return input.pending?.forceAvailable ? 'begin-terminal-cap-drain' : 'publish-force-available'
  }
  return waited >= input.prewaitCapMs ? 'begin-cap-drain' : 'prewait'
}

export function resumeAutomationRunnersAfterFailedHandoff(input: {
  legacyAutomationEnabled: boolean
  legacyRunner: AutomationTickRunner
  serverRunner: AutomationTickRunner
}): void {
  input.legacyRunner.resume({ trigger: input.legacyAutomationEnabled })
  input.serverRunner.resume({ trigger: true })
}
