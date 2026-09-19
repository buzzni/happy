// Scores are uncalibrated model outputs, not probabilities of task difficulty.
// Frozen on development data; see Desktop specs/org-shared-difficulty-routing/quality-improvement.md.
export const DIFFICULTY_DECISION_REVISION = 'binary-recall-v2-t010'
export const DIFFICULTY_HARD_SCORE_THRESHOLD = 0.1

export function decideDifficultyFromScores(value: unknown): 'hard' | 'routine' | null {
  if (!Array.isArray(value) || value.length !== 2) return null
  const scores = new Map<string, number>()
  for (const row of value) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null
    const { label, score } = row as Record<string, unknown>
    if ((label !== 'hard' && label !== 'routine') || scores.has(label)
      || typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) return null
    scores.set(label, score)
  }
  const hard = scores.get('hard')
  const routine = scores.get('routine')
  if (hard === undefined || routine === undefined || Math.abs(hard + routine - 1) > 1e-5) return null
  return hard >= DIFFICULTY_HARD_SCORE_THRESHOLD ? 'hard' : 'routine'
}
