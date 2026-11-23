import { build } from 'esbuild'
import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))
const files = await readdir(dist)
const providers = ['Claude', 'Codex'].map(provider =>
  files.find(name => new RegExp('^run' + provider + '-[\\w-]+\\.mjs$').test(name)))
if (providers.some(name => !name)) throw new Error('Missing Happy provider bundle entries')

// Splitting preserves the dynamic imports of the ordinary CLI. Inlining
// the dynamic graph can evaluate the CLI command entry during provider load.
await build({
  absWorkingDir: dist,
  entryPoints: [
    ...['index.mjs', ...providers].map(file => ({ in: file, out: file.slice(0, -4) })),
    { in: 'commands/residentCodexEntry.mjs', out: 'resident-codex-entry' },
  ],
  outdir: 'win32-resident',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  splitting: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // The daemon only serves this snapshot on Windows, where SRT rejects sandbox initialization
  // before accessing the platform binaries. Bundling its JS keeps Lodash's module graph in memory.
  external: ['node-pty', 'onnxruntime-node', '@anthropic-ai/claude-agent-sdk', 'b4a', 'bare-os'],
  banner: { js: 'import { createRequire as createResidentRequire } from "node:module"; const require = createResidentRequire(import.meta.url);' },
})
