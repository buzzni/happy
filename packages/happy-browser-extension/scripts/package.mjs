/**
 * Build a distributable zip of the extension.
 *
 * Ships only what Chrome loads — the dev/verify scripts and tests stay out,
 * both to keep the package small and because `scripts/` contains a bridge
 * that would be confusing (and pointless) inside a packed extension.
 *
 *   node scripts/package.mjs [outDir]
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.resolve(process.argv[2] ?? path.join(root, 'dist'))

const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'))
const zipName = `happy-browser-bridge-${manifest.version}.zip`
const zipPath = path.join(outDir, zipName)

// Everything Chrome needs, and nothing else.
const INCLUDE = [
    'manifest.json',
    'src/background.js',
    'src/connection.js',
    'src/protocol.js',
    'src/snapshot.js',
    'src/actions.js',
    'src/allowlist.js',
    'src/cdp.js',
    'src/frameRefs.js',
    'src/backoff.js',
    'src/options.html',
    'src/options.js',
]

const missing = INCLUDE.filter((file) => !existsSync(path.join(root, file)))
if (missing.length > 0) {
    console.error(`Refusing to package — missing files:\n  ${missing.join('\n  ')}`)
    process.exit(1)
}

mkdirSync(outDir, { recursive: true })
rmSync(zipPath, { force: true })

execFileSync('zip', ['-q', zipPath, ...INCLUDE], { cwd: root, stdio: 'inherit' })

console.log(zipPath)
