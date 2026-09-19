import { describe, expect, it } from 'vitest'
import { decideDifficultyFromScores } from './difficultyRoutingDecision'
const scores = (hard: number) => [{ label: 'routine', score: 1 - hard }, { label: 'hard', score: hard }]
describe('binary score decision', () => {
  it('retains uncertain hard candidates rather than taking the routine argmax', () => {
    expect(decideDifficultyFromScores(scores(0.1))).toBe('hard')
    expect(decideDifficultyFromScores(scores(0.32))).toBe('hard')
    expect(decideDifficultyFromScores(scores(0.099))).toBe('routine')
  })
  it('uses label identity rather than result ordering', () => {
    expect(decideDifficultyFromScores(scores(0.8).reverse())).toBe('hard')
    expect(decideDifficultyFromScores(scores(0.01).reverse())).toBe('routine')
  })
  it.each([
    null, [], {}, [{ label: 'routine', score: 0.99 }],
    [{ label: 'hard', score: 0.9 }, { label: 'hard', score: 0.1 }],
    [{ label: 'hard', score: 0.9 }, { label: 'trivial', score: 0.1 }],
    [{ label: 'hard', score: NaN }, { label: 'routine', score: 0.1 }],
    [{ label: 'hard', score: Infinity }, { label: 'routine', score: 0 }],
    [{ label: 'hard', score: -0.1 }, { label: 'routine', score: 1.1 }],
    [{ label: 'hard', score: 0.7 }, { label: 'routine', score: 0.7 }],
    [{ label: 'hard', score: '0.2' }, { label: 'routine', score: 0.8 }],
  ])('rejects incomplete or malformed score output %#', (value) => {
    expect(decideDifficultyFromScores(value)).toBeNull()
  })
})
