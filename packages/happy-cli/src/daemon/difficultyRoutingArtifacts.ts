import { DIFFICULTY_DECISION_REVISION } from './difficultyRoutingDecision'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
export const DIFFICULTY_ARTIFACTS = {
  'onnx/model.onnx': { bytes: 1116153796, sha256: '444c99b6f4d417e50859f73e1557db11943a2ad073ce4050a65f1b7d39403038' },
  'tokenizer.json': { bytes: 16034114, sha256: 'acadd7d076a55a97edf9fb0521a0a2e9cf8cbbdd62e4d793f2aa3d1900916356' },
  'config.json': { bytes: 978, sha256: '545292533946fa54503fb4ccedca867748c845a469110f5af35ef6f6675150e0' },
  'tokenizer_config.json': { bytes: 2928, sha256: 'c12b7b3bab6cd638f70b203daf1438bf7fedbeab4728a1e155728af9a5a55687' },
} as const
export const DIFFICULTY_CLASSIFIER_REVISION = `artifact-sha256:${DIFFICULTY_ARTIFACTS['onnx/model.onnx'].sha256}:${DIFFICULTY_DECISION_REVISION}`
export async function verifyDifficultyArtifactDirectory(directory: string, signal?: AbortSignal): Promise<boolean> {
  try {
    for (const [file, expected] of Object.entries(DIFFICULTY_ARTIFACTS)) {
      if (!await matches(join(directory, file), expected, signal)) return false
    }
    return true
  } catch { return false }
}
async function matches(path: string, expected: { bytes: number; sha256: string }, signal?: AbortSignal): Promise<boolean> {
  const hash = createHash('sha256'); let bytes = 0
  try {
    for await (const chunk of createReadStream(path, { signal })) {
      bytes += chunk.length
      if (bytes > expected.bytes) return false
      hash.update(chunk)
    }
    return bytes === expected.bytes && hash.digest('hex') === expected.sha256
  } catch { return false }
}
/** Called only after this daemon has been elected by an enabled organization policy. */
export async function prepareDifficultyRoutingArtifacts(input: { signal: AbortSignal; directory?: string; cacheRoot?: string; fetcher?: typeof fetch }): Promise<string> {
  if (input.signal.aborted) throw new Error('preparation-aborted')
  if (input.directory) {
    if (!await verifyDifficultyArtifactDirectory(input.directory, input.signal)) throw new Error('artifact-integrity')
    return input.directory
  }
  const directory = join(input.cacheRoot ?? join(homedir(), '.cache', 'saycode', 'difficulty-routing'), DIFFICULTY_ARTIFACTS['onnx/model.onnx'].sha256)
  await mkdir(join(directory, 'onnx'), { recursive: true, mode: 0o700 })
  for (const [file, expected] of Object.entries(DIFFICULTY_ARTIFACTS)) {
    input.signal.throwIfAborted()
    const target = join(directory, file)
    if (await matches(target, expected, input.signal)) continue
    const temporary = `${target}.${randomUUID()}.partial`
    const handle = await open(temporary, 'wx', 0o600)
    try {
      // Bytes are pinned by digest, so a mutable Hub alias cannot silently change the model.
      const response = await (input.fetcher ?? fetch)(`https://huggingface.co/buzzni/aplus-difficulty-classifier-binary/resolve/main/${file}`, {
        signal: AbortSignal.any([input.signal, AbortSignal.timeout(10 * 60000)]), credentials: 'omit',
      })
      if (!response.ok || !response.body) throw new Error('artifact-unavailable')
      const reader = response.body.getReader(), hash = createHash('sha256'); let bytes = 0
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          bytes += value.byteLength
          if (bytes > expected.bytes) throw new Error('artifact-size')
          hash.update(value)
          await handle.writeFile(value)
        }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
      if (bytes !== expected.bytes || hash.digest('hex') !== expected.sha256) throw new Error('artifact-integrity')
      input.signal.throwIfAborted()
      await handle.sync(); await handle.close(); await rename(temporary, target)
    } finally { await handle.close().catch(() => undefined); await rm(temporary, { force: true }) }
  }
  return directory
}
