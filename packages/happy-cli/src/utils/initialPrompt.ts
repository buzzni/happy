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
