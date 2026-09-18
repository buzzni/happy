import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
const run = promisify(execFile)
describe('quality evaluation input gate', () => {
  it.each([1, 500])('rejects %i incorrectly distributed examples before loading a model', async (count) => {
    const directory = await mkdtemp(join(tmpdir(), 'difficulty-eval-'))
    const input = join(directory, 'input.jsonl'), output = join(directory, 'output.json')
    try {
      await writeFile(input, Array.from({ length: count }, (_, i) => JSON.stringify({
        id: `synthetic-${i}`, language: 'en', label: 'hard', prompt: `Synthetic request ${i}`,
      })).join('\n'))
      await expect(run(process.execPath, ['--import', 'tsx', resolve('scripts/evalDifficultyRouting.ts'),
        '--input', input, '--model-dir', '/nonexistent', '--baseline-policy', '/nonexistent', '--output', output],
      )).rejects.toMatchObject({ stderr: expect.stringContaining('evaluation-quota-mismatch') })
      await expect(access(output)).rejects.toThrow()
      await expect(access(output + '.manifest.json')).rejects.toThrow()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
