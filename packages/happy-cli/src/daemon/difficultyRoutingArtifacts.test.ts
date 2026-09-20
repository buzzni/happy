import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { prepareDifficultyRoutingArtifacts, DIFFICULTY_ARTIFACTS } from './difficultyRoutingArtifacts'
describe('classifier artifact preparation', () => {
  it('never downloads after OFF cancels preparation', async () => {
    const controller = new AbortController(); controller.abort()
    const fetcher = vi.fn()
    await expect(prepareDifficultyRoutingArtifacts({ signal: controller.signal, fetcher })).rejects.toThrow('preparation-aborted')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('fails closed for an invalid explicit local-only directory', async () => {
    const fetcher = vi.fn()
    await expect(prepareDifficultyRoutingArtifacts({ signal: new AbortController().signal, directory: '/nonexistent', fetcher })).rejects.toThrow('artifact-integrity')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('rejects mismatched public artifacts and removes partial files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'routing-artifact-'))
    try {
      const fetcher = vi.fn<typeof fetch>(async () => new Response('bad artifact'))
      await expect(prepareDifficultyRoutingArtifacts({ signal: new AbortController().signal, cacheRoot: root, fetcher })).rejects.toThrow('artifact-integrity')
      expect(await readdir(join(root, DIFFICULTY_ARTIFACTS['onnx/model.onnx'].sha256, 'onnx'))).toEqual([])
      expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: 'omit' })
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
