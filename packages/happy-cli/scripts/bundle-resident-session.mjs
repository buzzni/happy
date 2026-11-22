import { build } from 'esbuild'
import { cp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
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
  // The daemon serves this snapshot on Windows, macOS and Linux. Bundling SRT's JS keeps Lodash's
  // module graph in memory. Windows SRT rejects sandbox initialization before accessing platform
  // binaries and macOS generates its Seatbelt profile; Linux needs the seccomp assets copied below.
  external: ['node-pty', 'onnxruntime-node', '@anthropic-ai/claude-agent-sdk', 'b4a', 'bare-os'],
  banner: { js: 'import { createRequire as createResidentRequire } from "node:module"; const require = createResidentRequire(import.meta.url);' },
})

// Served from dist/, the bundled SRT looks for vendor/seccomp/<arch> next to its own module URL. Without
// the filter it only warns and runs with unix sockets unrestricted, so the assets travel with the bundle.
const srtRoot = dirname(dirname(createRequire(import.meta.url).resolve('@anthropic-ai/sandbox-runtime')))
await rm(join(dist, 'vendor', 'seccomp'), { recursive: true, force: true })
await cp(join(srtRoot, 'vendor', 'seccomp'), join(dist, 'vendor', 'seccomp'), { recursive: true })
