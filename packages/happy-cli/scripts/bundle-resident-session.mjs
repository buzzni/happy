import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))

// Splitting preserves the dynamic imports of the ordinary CLI. Inlining
// the dynamic graph can evaluate the CLI command entry during provider load.
// Follow the CLI graph from its stable entry, independent of pkgroll chunk names.
await build({
  absWorkingDir: dist,
  entryPoints: ['index.mjs'],
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
