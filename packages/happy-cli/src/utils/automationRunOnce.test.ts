import { describe, expect, it } from 'vitest'

import { consumeAutomationRunOnce } from './automationRunOnce'

describe('consumeAutomationRunOnce', () => {
  it('shouldConsumeTheDaemonRunOnceMarkerExactlyOnce', () => {
    const env = { HAPPY_AUTOMATION_RUN_ONCE: '1' }

    expect(consumeAutomationRunOnce(env)).toBe(true)
    expect(env.HAPPY_AUTOMATION_RUN_ONCE).toBeUndefined()
    expect(consumeAutomationRunOnce(env)).toBe(false)
  })

  it('shouldIgnoreUnknownValuesWithoutLeakingThemToChildren', () => {
    const env = { HAPPY_AUTOMATION_RUN_ONCE: 'true' }

    expect(consumeAutomationRunOnce(env)).toBe(false)
    expect(env.HAPPY_AUTOMATION_RUN_ONCE).toBeUndefined()
  })
})
