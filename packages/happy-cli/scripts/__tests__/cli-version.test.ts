import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { version: string }
const temporaryDirectories: string[] = []

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true })
    }
})

describe.each(['--version', '-v'])('happy %s', (versionFlag) => {
    it('prints only the Happy CLI version without creating runtime state', () => {
        const isolatedHome = mkdtempSync(join(tmpdir(), 'happy-cli-version-'))
        temporaryDirectories.push(isolatedHome)
        const happyHome = join(isolatedHome, '.happy-test')

        const result = spawnSync(process.execPath, [join(packageRoot, 'bin', 'happy.mjs'), versionFlag], {
            cwd: packageRoot,
            encoding: 'utf8',
            timeout: 3_000,
            env: {
                ...process.env,
                HOME: isolatedHome,
                USERPROFILE: isolatedHome,
                HAPPY_HOME_DIR: happyHome,
                HAPPY_SERVER_URL: 'http://127.0.0.1:1',
            },
        })

        expect(result.error).toBeUndefined()
        expect(result.status).toBe(0)
        expect(result.stdout).toBe(`happy version: ${packageJson.version}\n`)
        expect(result.stderr).toBe('')
        expect(existsSync(happyHome)).toBe(false)
    })
})

describe('happy daemon preflight', () => {
    it('initializes and closes the packaged control-server runtime without daemon state', () => {
        const isolatedHome = mkdtempSync(join(tmpdir(), 'happy-cli-preflight-'))
        temporaryDirectories.push(isolatedHome)
        const happyHome = join(isolatedHome, '.happy-test')

        const result = spawnSync(process.execPath, [join(packageRoot, 'bin', 'happy.mjs'), 'daemon', 'preflight'], {
            cwd: packageRoot,
            encoding: 'utf8',
            timeout: 30_000,
            env: {
                ...process.env,
                HOME: isolatedHome,
                USERPROFILE: isolatedHome,
                HAPPY_HOME_DIR: happyHome,
                HAPPY_SERVER_URL: 'http://127.0.0.1:1',
            },
        })

        expect(result.error).toBeUndefined()
        expect(result.status, result.stderr).toBe(0)
        expect(existsSync(join(happyHome, 'daemon.state.json'))).toBe(false)
        expect(existsSync(join(happyHome, 'sessions.json'))).toBe(false)
    })
})

describe.each([
    ['packaged wrapper', join(packageRoot, 'bin', 'happy.mjs')],
    ['direct ESM entrypoint', join(packageRoot, 'dist', 'index.mjs')],
    ['direct CommonJS entrypoint', join(packageRoot, 'dist', 'index.cjs')],
])('Happy CLI agent via %s', (_name, entrypoint) => {
    it('routes malformed commands to Saycode without creating Happy runtime state', () => {
        const isolatedHome = mkdtempSync(join(tmpdir(), 'happy-cli-agent-entrypoint-'))
        temporaryDirectories.push(isolatedHome)
        const happyHome = join(isolatedHome, '.happy-test')

        const result = spawnSync(
            process.execPath,
            [entrypoint, 'agent', 'not-a-real-agent-verb'],
            {
                cwd: packageRoot,
                encoding: 'utf8',
                timeout: 3_000,
                env: {
                    ...process.env,
                    HOME: isolatedHome,
                    USERPROFILE: isolatedHome,
                    HAPPY_HOME_DIR: happyHome,
                    HAPPY_SERVER_URL: 'http://127.0.0.1:1',
                },
            },
        )

        expect(result.error).toBeUndefined()
        expect(result.status).toBe(2)
        expect(result.stdout).toBe('')
        expect(result.stderr).toMatch(/^saycode: agent needs one of:/)
        expect(result.stderr).not.toMatch(/claude|codex|gemini/i)
        expect(existsSync(happyHome)).toBe(false)
    })
})
