#!/usr/bin/env node
// Build inputs only: never installs a service, signs code or includes machine state.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
if (args.length !== 2 || args[0] !== '--out' || !args[1]) throw new Error('usage: build-native-browser-runtime.mjs --out <new directory>')
// Windows service/Job admission is not implemented yet. Do not label a Mac bundle
// or the primitive-only Windows host as a Windows native runtime.
if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) throw new Error('A supported macOS build host is required')
const platform = `darwin-${process.arch}`
const output = resolve(args[1])
const binaryInputs = [
  [`native/${platform}/browser-host.node`, `native/${platform}/browser-host.node`],
  [`native/${platform}/browser-guardian`, 'bin/browser-guardian'],
]
// Fail before writing output when the exact architecture inputs are absent.
for (const [input] of binaryInputs) {
  const info = lstatSync(join(packageDir, input))
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0) throw new Error(`Missing native build input: ${input}`)
  const arch = execFileSync('/usr/bin/lipo', ['-archs', join(packageDir, input)], { encoding: 'utf8' }).trim().split(/\s+/)
  if (arch.length !== 1 || arch[0] !== (process.arch === 'x64' ? 'x86_64' : 'arm64')) throw new Error(`Wrong native architecture: ${input}`)
}
const { version } = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
if (typeof version !== 'string' || !/^[0-9][A-Za-z0-9.+-]{0,100}$/.test(version)) throw new Error('Invalid runtime version')
// A failed build leaves its new directory for inspection. Never overwrite or
// recursively remove a caller-provided directory (including a prior artifact).
mkdirSync(output, { recursive: false, mode: 0o755 })
mkdirSync(join(output, 'dist'))
execFileSync(process.execPath, [join(packageDir, 'scripts/browser-poc/build-runtime.mjs'), join(output, 'dist/runtime.mjs')], { stdio: 'inherit' })
for (const [input, target] of binaryInputs) {
  mkdirSync(dirname(join(output, target)), { recursive: true })
  copyFileSync(join(packageDir, input), join(output, target))
}
const files = ['dist/runtime.mjs', ...binaryInputs.map(([, target]) => target)].map(path => {
  const bytes = readFileSync(join(output, path))
  return { path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
})
writeFileSync(join(output, 'runtime-manifest.json'), JSON.stringify({ schemaVersion: 1, version, platform, files }, null, 2) + '\n', { flag: 'wx', mode: 0o644 })
console.log(`Native runtime build: ${platform} ${version}`)
