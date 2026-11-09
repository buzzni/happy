import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// aplus specs/org-llm-endpoints r3 — runClaude resolves a turn's model in several places (every message, the routed
// model, the organization gate, the boundary repair). Each must give the model one resolution, never a default
// applied on top of an already-normalized value: that replaced an endpoint's tier mapping (opus -> corp-big).
describe('runClaude model resolution call sites', () => {
    const source = readFileSync(join(__dirname, 'runClaude.ts'), 'utf8')

    it('applies the default only to the initial seed, whose value is a constant and not a normalized model', () => {
        const calls = source.match(/defaultClaudeModelForRuntime\(/g) ?? []
        expect(calls).toHaveLength(1)
        expect(source).toMatch(/explicitInitialModel \?\? defaultClaudeModelForRuntime\(process\.env, DEFAULT_CLAUDE_MODEL\)/)
    })

    it('never nests the normalization inside the default', () => {
        expect(source).not.toMatch(/defaultClaudeModelForRuntime\([^)]*normalizeClaudeModelForRuntime/s)
    })
})
