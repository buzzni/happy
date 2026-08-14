import { createEnvelope, type SessionEnvelope } from '@slopus/happy-wire'

import {
  consumePendingInitialPrompt,
  consumePendingInitialPromptLocalId,
} from '@/utils/initialPrompt'

export type PreparedCodexInitialPrompt = {
  prompt: string | null
  localId?: string
  exitAfterFirstTurn: boolean
}

export function prepareCodexInitialPrompt(input: {
  env: NodeJS.ProcessEnv
  reconnectSessionId?: string
  automationRunOnceRequested: boolean
  allowAutomationReconnectPrompt?: boolean
}): PreparedCodexInitialPrompt {
  const consumedPrompt = consumePendingInitialPrompt(input.env)
  const localId = consumePendingInitialPromptLocalId(input.env)
  const prompt = consumedPrompt
    && (!input.reconnectSessionId || input.allowAutomationReconnectPrompt)
    ? consumedPrompt
    : null

  if ((input.automationRunOnceRequested || input.allowAutomationReconnectPrompt) && !prompt) {
    throw new Error('Codex automation cannot start without a fresh initial prompt')
  }

  return {
    prompt,
    ...(prompt && localId ? { localId } : {}),
    exitAfterFirstTurn: input.automationRunOnceRequested && prompt !== null,
  }
}

export function assertCodexAutomationServerAvailable(input: {
  automationRunOnceRequested: boolean
  serverAvailable: boolean
}): void {
  if (input.automationRunOnceRequested && !input.serverAvailable) {
    throw new Error('Codex automation cannot start while the Happy server is unavailable')
  }
}

export function deliverCodexInitialPrompt(input: {
  prepared: PreparedCodexInitialPrompt
  sendSessionMessage: (envelope: SessionEnvelope, localId?: string) => void
  pushPrompt: (prompt: string) => void
}): boolean {
  const prompt = input.prepared.prompt
  input.prepared.prompt = null
  if (!prompt) return false

  input.sendSessionMessage(
    createEnvelope('user', { t: 'text', text: prompt }),
    input.prepared.localId,
  )
  input.pushPrompt(prompt)
  return true
}

export async function prepareCodexSessionStart(input: {
  prepared: PreparedCodexInitialPrompt
  sendSessionMessage: (envelope: SessionEnvelope, localId?: string) => void
  pushPrompt: (prompt: string) => void
  reportStarted?: () => Promise<void>
}): Promise<boolean> {
  const delivered = deliverCodexInitialPrompt(input)
  await input.reportStarted?.()
  return delivered
}
