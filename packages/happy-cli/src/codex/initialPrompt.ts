import { createEnvelope, type SessionEnvelope } from '@slopus/happy-wire'

import { consumePendingInitialPrompt } from '@/utils/initialPrompt'

export function deliverCodexInitialPrompt(input: {
  env: NodeJS.ProcessEnv
  reconnectSessionId?: string
  sendSessionMessage: (envelope: SessionEnvelope) => void
  pushPrompt: (prompt: string) => void
}): boolean {
  const prompt = consumePendingInitialPrompt(input.env)
  if (!prompt || input.reconnectSessionId) return false

  input.sendSessionMessage(createEnvelope('user', { t: 'text', text: prompt }))
  input.pushPrompt(prompt)
  return true
}
