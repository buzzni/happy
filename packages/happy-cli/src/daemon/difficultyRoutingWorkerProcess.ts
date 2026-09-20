import { decideDifficultyFromScores } from './difficultyRoutingDecision'
import { DIFFICULTY_CLASSIFIER_REVISION as REVISION, verifyDifficultyArtifactDirectory } from './difficultyRoutingArtifacts'

type Pipeline = ((text: string, options: { top_k: null }) => Promise<unknown>) & {
  tokenizer: { config: Record<string, unknown> }
  model: { config: { max_position_embeddings?: number } }
}
let classifierPromise: Promise<Pipeline> | null = null
let busy = false
process.on('disconnect', () => process.exit(0))
process.on('message', (message: unknown) => { void handleMessage(message) })

async function handleMessage(raw: unknown): Promise<void> {
  if (!raw || typeof raw !== 'object') return
  const message = raw as Record<string, unknown>
  if (message.type !== 'prepare' && message.type !== 'classify') return
  if (busy) { process.send?.({ type: 'error', requestId: message.requestId, error: 'busy' }); return }
  if (message.type === 'classify' && (typeof message.requestId !== 'string' || message.requestId.length > 256 || typeof message.text !== 'string' || message.text.length > 8000 || message.maxInputTokens !== 512)) {
    process.send?.({ type: 'error', requestId: message.requestId, error: 'invalid-input' }); return
  }
  busy = true
  try {
    const classifier = await loadClassifier()
    if (message.type === 'prepare') {
      process.send?.({ type: 'ready', classifierRevision: REVISION, rssBytes: process.memoryUsage().rss, cpuMicros: process.cpuUsage() })
    } else {
      const result = await classifier(message.text as string, { top_k: null })
      const label = decideDifficultyFromScores(result)
      if (!label) throw new Error('invalid-scores')
      process.send?.({ type: 'result', requestId: message.requestId, difficulty: label, classifierRevision: REVISION, rssBytes: process.memoryUsage().rss, cpuMicros: process.cpuUsage() })
    }
  } catch {
    // Never forward exception messages: tokenizer/backend errors may contain input or local paths.
    process.send?.({ type: 'error', requestId: message.requestId, error: 'classifier-unavailable' })
  } finally { busy = false }
}
async function loadClassifier(): Promise<Pipeline> {
  classifierPromise ??= (async () => {
    const modelDir = process.env.HAPPY_DIFFICULTY_ROUTING_MODEL_DIR
    if (!modelDir) throw new Error('model-path-required')
    if (!await verifyDifficultyArtifactDirectory(modelDir)) throw new Error('artifact-integrity')
    const imported = await import('@huggingface/transformers')
    imported.env.allowRemoteModels = false
    imported.env.allowLocalModels = true
    const classifier = await imported.pipeline('text-classification', modelDir, { local_files_only: true, dtype: 'fp32', device: 'cpu' }) as unknown as Pipeline
    const maxTokens = classifier.model?.config?.max_position_embeddings
    if (!Number.isSafeInteger(maxTokens) || maxTokens! <= 0 || maxTokens! > 512 || !classifier.tokenizer?.config) throw new Error('token-limit')
    classifier.tokenizer.config.model_max_length = maxTokens
    if (classifier.tokenizer.config.model_max_length !== maxTokens) throw new Error('token-limit')
    return classifier
  })()
  return classifierPromise
}
