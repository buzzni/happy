import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const requireFromTsx = createRequire(createRequire(import.meta.url).resolve('tsx/package.json'))
const { build } = requireFromTsx('esbuild')

// Codex starts a copy per connector. A self-contained bridge keeps parallel
// Windows launches from scanning the same SDK dependency tree for each copy.
await build({
    absWorkingDir: packageDir,
    entryPoints: ['src/codex/happyMcpStdioBridge.ts'],
    outfile: join(packageDir, 'dist/codex/happyMcpStdioBridge.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    banner: { js: "import { createRequire as createBridgeRequire } from 'node:module'; const require = createBridgeRequire(import.meta.url);" },
})
