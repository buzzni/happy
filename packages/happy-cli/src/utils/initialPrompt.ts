import { randomUUID } from 'node:crypto'

import type { RawJSONLines } from '@/claude/types'
import type { PermissionMode } from '@/api/types'

/** Read a daemon-provided initial prompt exactly once without leaking it to children. */
export function consumePendingInitialPrompt(env: NodeJS.ProcessEnv): string | null {
  const raw = env.HAPPY_INITIAL_PROMPT
  delete env.HAPPY_INITIAL_PROMPT
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  return text.length > 0 ? text : null
}

/** Read the daemon-provided initial model seed exactly once (HAPPY_INITIAL_MODEL). */
export function consumePendingInitialModel(env: NodeJS.ProcessEnv): string | null {
  const raw = env.HAPPY_INITIAL_MODEL
  delete env.HAPPY_INITIAL_MODEL
  if (typeof raw !== 'string') return null
  const model = raw.trim()
  return model.length > 0 ? model : null
}

/**
 * Read the daemon-provided initial effort seed exactly once
 * (HAPPY_INITIAL_EFFORT). Validation against the agent's accepted set is the
 * caller's job — accepted values differ per agent (Claude vs Codex).
 */
export function consumePendingInitialEffort(env: NodeJS.ProcessEnv): string | null {
  const raw = env.HAPPY_INITIAL_EFFORT
  delete env.HAPPY_INITIAL_EFFORT
  if (typeof raw !== 'string') return null
  const effort = raw.trim()
  return effort.length > 0 ? effort : null
}

export function consumePendingInitialSaycodeSystemPromptEnabled(
  env: NodeJS.ProcessEnv,
): boolean | undefined {
  const raw = env.HAPPY_INITIAL_SAYCODE_SYSTEM_PROMPT_ENABLED
  delete env.HAPPY_INITIAL_SAYCODE_SYSTEM_PROMPT_ENABLED
  if (raw === 'true') return true
  if (raw === 'false') return false
  return undefined
}

export function consumePendingInitialPromptLocalId(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.HAPPY_INITIAL_PROMPT_LOCAL_ID
  delete env.HAPPY_INITIAL_PROMPT_LOCAL_ID
  if (typeof raw !== 'string') return undefined
  const localId = raw.trim()
  return localId.length > 0 ? localId : undefined
}

export function resolveInitialPromptPermissionMode(
  currentMode: PermissionMode,
  automationResume: boolean,
): PermissionMode {
  return automationResume ? 'bypassPermissions' : currentMode
}

/** Build the synthetic user record used to make a daemon prompt visible in history. */
export function buildInitialPromptUserRecord(text: string, happySessionId: string | null): RawJSONLines {
  return {
    type: 'user',
    uuid: randomUUID(),
    parentUuid: null,
    isSidechain: false,
    sessionId: happySessionId ?? 'unknown',
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: text },
  } as RawJSONLines
}
