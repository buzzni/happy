// Local-only paired evaluation. Output includes scores/IDs, never input text.
// Run with pnpm exec tsx scripts/evalDifficultyRouting.ts --input ... --model-dir ...
// --baseline-policy <frozen pre-change pure policy.ts> --output ...
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { arch, cpus, platform } from 'node:os'
import type { classifyDifficultyHeuristic as ClassifyHeuristic } from '../src/difficultyRoutingPolicy'

const option = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1] }
const required = (name: string) => { const value = option(name); if (!value) throw new Error(`${name} required`); return resolve(value) }
const input = required('--input'), modelDir = required('--model-dir'), output = required('--output'), baselineFile = required('--baseline-policy')
const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex')
const inputBytes = await readFile(input, 'utf8')
const rows = inputBytes.trim().split('\n').map(line => JSON.parse(line)) as Array<{ id: string; language: string; label: string; prompt: string; familyId?: string }>
if (rows.length === 0 || rows.some(r => typeof r.id !== 'string' || !r.id || !['ko', 'en', 'ja', 'zh'].includes(r.language)
  || !['hard', 'routine', 'trivial'].includes(r.label) || typeof r.prompt !== 'string' || !r.prompt.trim() || r.prompt.length > 8000)
  || new Set(rows.map(r => r.id)).size !== rows.length || new Set(rows.map(r => r.prompt)).size !== rows.length) throw new Error('invalid-evaluation-data')
for (const language of ['ko', 'en', 'ja', 'zh']) {
  for (const [label, count] of Object.entries({ hard: 55, routine: 50, trivial: 20 })) {
    if (rows.filter(r => r.language === language && r.label === label).length !== count) throw new Error('evaluation-quota-mismatch')
  }
}
const sourceFiles = {
  dataset: input, baselinePolicy: baselineFile,
  candidatePolicy: new URL('../src/difficultyRoutingPolicy.ts', import.meta.url),
  decision: new URL('../src/daemon/difficultyRoutingDecision.ts', import.meta.url),
  artifacts: new URL('../src/daemon/difficultyRoutingArtifacts.ts', import.meta.url),
  worker: new URL('../src/daemon/difficultyRoutingWorkerProcess.ts', import.meta.url),
  evaluator: new URL(import.meta.url),
}
async function sourceManifest() {
  return Object.fromEntries(await Promise.all(Object.entries(sourceFiles).map(async ([name, file]) => [name, hash(await readFile(file, 'utf8'))])))
}
const manifest = await sourceManifest()
if (manifest.dataset !== hash(inputBytes)) throw new Error('evaluation-input-changed')
await writeFile(output + '.manifest.json', JSON.stringify({ frozenAt: new Date().toISOString(), sha256: manifest }, null, 2) + '\n')
const { classifyDifficultyHeuristic } = await import('../src/difficultyRoutingPolicy')
const { decideDifficultyFromScores, DIFFICULTY_HARD_SCORE_THRESHOLD } = await import('../src/daemon/difficultyRoutingDecision')
const { DIFFICULTY_CLASSIFIER_REVISION, verifyDifficultyArtifactDirectory } = await import('../src/daemon/difficultyRoutingArtifacts')
const baseline = await import(pathToFileURL(baselineFile).href) as { classifyDifficultyHeuristic: typeof ClassifyHeuristic }
if (JSON.stringify(await sourceManifest()) !== JSON.stringify(manifest)) throw new Error('evaluation-source-changed')
if (!await verifyDifficultyArtifactDirectory(modelDir)) throw new Error('artifact-integrity')
const { pipeline, env } = await import('@huggingface/transformers')
env.allowRemoteModels = false
const start = performance.now()
const classifier = await pipeline('text-classification', modelDir, { local_files_only: true, dtype: 'fp32', device: 'cpu' })
classifier.tokenizer.config.model_max_length = 512
const coldMs = performance.now() - start
type Prediction = {
  id: string; language: string; expected: string; familyId: string | null
  baselineP1: ReturnType<typeof classifyDifficultyHeuristic>; candidateP1: ReturnType<typeof classifyDifficultyHeuristic>
  hardScore: number; baselineP2: string; candidateP2: string
  baselineCombined: string; candidateCombined: string; ms: number
}
const predictions: Prediction[] = []
let peakRss = process.memoryUsage().rss
try {
  for (const row of rows) {
    const begin = performance.now()
    const scores = await classifier(row.prompt, { top_k: null }) as Array<{ label: string; score: number }>
    const candidateP2 = decideDifficultyFromScores(scores)
    if (!candidateP2) throw new Error('invalid-classifier-scores')
    const baselineP1 = baseline.classifyDifficultyHeuristic(row.prompt)
    const candidateP1 = classifyDifficultyHeuristic(row.prompt)
    const baselineP2 = scores.reduce((a, b) => a.score >= b.score ? a : b).label
    predictions.push({ id: row.id, language: row.language, expected: row.label, familyId: row.familyId ?? null, baselineP1, candidateP1,
      hardScore: scores.find(s => s.label === 'hard')!.score, baselineP2, candidateP2,
      baselineCombined: baselineP1.confident ? baselineP1.difficulty : baselineP2,
      candidateCombined: candidateP1.confident ? candidateP1.difficulty : candidateP2, ms: performance.now() - begin })
    peakRss = Math.max(peakRss, process.memoryUsage().rss)
  }
} finally { await classifier.dispose() }
type Decision = 'baselineP2' | 'candidateP2' | 'baselineCombined' | 'candidateCombined'
function wilson(success: number, count: number) {
  if (!count) return null
  const z = 1.95996398454, p = success / count, d = 1 + z * z / count
  const mid = (p + z * z / (2 * count)) / d
  const half = z * Math.sqrt(p * (1 - p) / count + z * z / (4 * count * count)) / d
  return [mid - half, mid + half]
}
function metrics(items: Prediction[], key: Decision) {
  let tp = 0, fn = 0, fp = 0, tn = 0
  for (const r of items) { const positive = r[key] === 'hard'; if (r.expected === 'hard') { if (positive) tp++; else fn++ } else { if (positive) fp++; else tn++ } }
  return { count: items.length, tp, fn, fp, tn, recall: tp + fn ? tp / (tp + fn) : null,
    precision: tp + fp ? tp / (tp + fp) : null, fpr: fp + tn ? fp / (fp + tn) : null, recallWilson95: wilson(tp, tp + fn) }
}
function comparison(items: Prediction[]) {
  return { baselineP2: metrics(items, 'baselineP2'), candidateP2: metrics(items, 'candidateP2'),
    baselineCombined: metrics(items, 'baselineCombined'), candidateCombined: metrics(items, 'candidateCombined') }
}
const overall = comparison(predictions)
const fixedP2 = comparison(predictions.filter(p => !p.baselineP1.confident))
const newlyEligible = predictions.filter(p => p.baselineP1.confident && !p.candidateP1.confident)
const hardRegressions = predictions.filter(p => p.expected === 'hard' &&
  ((p.baselineCombined === 'hard' && p.candidateCombined !== 'hard') || (p.baselineP2 === 'hard' && p.candidateP2 !== 'hard'))).map(p => p.id)
const recall = (m: ReturnType<typeof metrics>) => m.recall ?? NaN
const fpr = (m: ReturnType<typeof metrics>) => m.fpr ?? NaN
const sufficientCoverage = [overall, fixedP2].every(group => Object.values(group).every(m => m.recall !== null && m.fpr !== null))
const passes = sufficientCoverage && recall(overall.candidateCombined) >= recall(overall.baselineCombined)
  && recall(overall.candidateP2) >= recall(overall.baselineP2)
  && (recall(overall.candidateCombined) > recall(overall.baselineCombined) || recall(overall.candidateP2) > recall(overall.baselineP2))
  && fpr(overall.candidateCombined) - fpr(overall.baselineCombined) <= 0.03 + 1e-12
  && fpr(fixedP2.candidateP2) - fpr(fixedP2.baselineP2) <= 0.03 + 1e-12 && hardRegressions.length === 0
const routingTransitions: Record<string, number> = {}
for (const p of predictions) {
  const transition = `${p.baselineCombined}->${p.candidateCombined}`
  routingTransitions[transition] = (routingTransitions[transition] ?? 0) + 1
}
const ms = predictions.map(p => p.ms).sort((a, b) => a - b)
if (JSON.stringify(await sourceManifest()) !== JSON.stringify(manifest)) throw new Error('evaluation-source-changed')
const result = { manifest, evaluatedAt: new Date().toISOString(), synthetic: true, inputSha256: hash(inputBytes),
  baselinePolicySha256: manifest.baselinePolicy, candidatePolicySha256: manifest.candidatePolicy, decisionSha256: manifest.decision,
  classifierRevision: DIFFICULTY_CLASSIFIER_REVISION, hardScoreThreshold: DIFFICULTY_HARD_SCORE_THRESHOLD,
  platform: platform(), arch: arch(), cpu: cpus()[0]?.model, coldMs, peakObservedRssMiB: peakRss / 1024 / 1024,
  latencyMs: { p50: ms[Math.ceil(ms.length * .5) - 1], p95: ms[Math.ceil(ms.length * .95) - 1], p99: ms[Math.ceil(ms.length * .99) - 1] },
  overall, routingTransitions, fixedBaselineP2Eligible: fixedP2,
  candidateP2Eligible: comparison(predictions.filter(p => !p.candidateP1.confident)),
  newlyEligible: { ...comparison(newlyEligible), ids: newlyEligible.map(p => p.id) },
  p2Requests: { baseline: predictions.filter(p => !p.baselineP1.confident).length, candidate: predictions.filter(p => !p.candidateP1.confident).length },
  languages: Object.fromEntries(['ko', 'en', 'ja', 'zh'].map(l => [l, comparison(predictions.filter(p => p.language === l))])),
  improvementGate: { passes, sufficientCoverage, hardRegressions }, rolloutAccepted: false, predictions }
await writeFile(output, JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ count: rows.length, overall, fixedP2, p2Requests: result.p2Requests, improvementGate: result.improvementGate }))
