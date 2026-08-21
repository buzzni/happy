import { describe, expect, it } from 'vitest'

import {
  consumePendingInitialEffort,
  consumePendingInitialModel,
  consumePendingInitialSaycodeSystemPromptEnabled,
} from './initialPrompt'

describe('consumePendingInitialModel', () => {
  it('reads the seed exactly once and scrubs it from the environment', () => {
    const env: NodeJS.ProcessEnv = { HAPPY_INITIAL_MODEL: ' opus ' }

    expect(consumePendingInitialModel(env)).toBe('opus')
    expect(env).not.toHaveProperty('HAPPY_INITIAL_MODEL')
    expect(consumePendingInitialModel(env)).toBeNull()
  })

  it('treats a blank value as absent', () => {
    expect(consumePendingInitialModel({ HAPPY_INITIAL_MODEL: '   ' })).toBeNull()
    expect(consumePendingInitialModel({})).toBeNull()
  })
})

describe('consumePendingInitialEffort', () => {
  it('reads the seed exactly once and scrubs it from the environment', () => {
    const env: NodeJS.ProcessEnv = { HAPPY_INITIAL_EFFORT: 'high' }

    expect(consumePendingInitialEffort(env)).toBe('high')
    expect(env).not.toHaveProperty('HAPPY_INITIAL_EFFORT')
    expect(consumePendingInitialEffort(env)).toBeNull()
  })

  it('treats a blank value as absent', () => {
    expect(consumePendingInitialEffort({ HAPPY_INITIAL_EFFORT: '' })).toBeNull()
    expect(consumePendingInitialEffort({})).toBeNull()
  })
})

describe('consumePendingInitialSaycodeSystemPromptEnabled', () => {
  it('reads an explicit recovery policy exactly once', () => {
    const env: NodeJS.ProcessEnv = {
      HAPPY_INITIAL_SAYCODE_SYSTEM_PROMPT_ENABLED: 'false',
    }

    expect(consumePendingInitialSaycodeSystemPromptEnabled(env)).toBe(false)
    expect(env).not.toHaveProperty('HAPPY_INITIAL_SAYCODE_SYSTEM_PROMPT_ENABLED')
    expect(consumePendingInitialSaycodeSystemPromptEnabled(env)).toBeUndefined()
  })

  it('preserves legacy enabled behavior for absent or invalid values', () => {
    expect(consumePendingInitialSaycodeSystemPromptEnabled({})).toBeUndefined()
    expect(consumePendingInitialSaycodeSystemPromptEnabled({
      HAPPY_INITIAL_SAYCODE_SYSTEM_PROMPT_ENABLED: 'invalid',
    })).toBeUndefined()
  })
})
