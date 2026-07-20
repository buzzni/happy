import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const GUARD_SCRIPT = join(__dirname, '..', 'guard-publish-artifact.cjs')
const temporaryDirectories: string[] = []

function writeFixtureFile(packageRoot: string, relativePath: string, contents: string): void {
    const filePath = join(packageRoot, relativePath)
    mkdirSync(join(filePath, '..'), { recursive: true })
    writeFileSync(filePath, contents)
}

function createPublishTarball(
    packageVersion: string,
    cliVersion: string,
    options: {
        extraVersionOutput?: string
        writeHomeSentinel?: boolean
        removeFastifyTransitiveAfterInstall?: boolean
        brokenFastifyRuntime?: boolean
    } = {}
): string {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'happy-cli-guard-test-'))
    temporaryDirectories.push(fixtureRoot)
    const packageRoot = join(fixtureRoot, 'package')

    writeFixtureFile(packageRoot, 'package.json', JSON.stringify({
        name: '@buzzni/happy-cli',
        version: packageVersion,
        bin: { happy: 'bin/happy.mjs' },
        dependencies: {
            '@slopus/happy-wire': '0.0.0-test',
            zod: '0.0.0-test',
            '@paralleldrive/cuid2': '0.0.0-test',
            fastify: '0.0.0-test'
        },
        bundledDependencies: [
            '@slopus/happy-wire',
            'zod',
            '@paralleldrive/cuid2',
            'fastify'
        ],
        ...(options.removeFastifyTransitiveAfterInstall
            ? { scripts: { postinstall: 'node scripts/remove-fastify-transitive.mjs' } }
            : {})
    }))
    writeFixtureFile(
        packageRoot,
        'bin/happy.mjs',
        [
            `import { writeFileSync } from 'node:fs'`,
            `import { join } from 'node:path'`,
            options.writeHomeSentinel
                ? `writeFileSync(join(process.env.HOME, 'guard-cli-was-here'), 'touched')`
                : '',
            `if (process.argv.includes('--version')) console.log('happy version: ' + ${JSON.stringify(cliVersion)} + ${JSON.stringify(options.extraVersionOutput ?? '')})`,
            `if (process.argv[2] === 'daemon' && process.argv[3] === 'preflight') { const { createRequire } = await import('node:module'); const require = createRequire(import.meta.url); const app = require('fastify')({ logger: false }); await app.ready(); await app.close() }`
        ].filter(Boolean).join('\n')
    )
    writeFixtureFile(packageRoot, 'node_modules/@slopus/happy-wire/package.json', JSON.stringify({ name: '@slopus/happy-wire', version: '0.0.0-test' }))
    writeFixtureFile(packageRoot, 'node_modules/@slopus/happy-wire/dist/index.mjs', 'export {};\n')
    writeFixtureFile(packageRoot, 'node_modules/zod/package.json', JSON.stringify({ name: 'zod', version: '0.0.0-test' }))
    writeFixtureFile(packageRoot, 'node_modules/@paralleldrive/cuid2/package.json', JSON.stringify({ name: '@paralleldrive/cuid2', version: '0.0.0-test' }))
    writeFixtureFile(packageRoot, 'node_modules/@paralleldrive/cuid2/node_modules/@noble/hashes/package.json', JSON.stringify({ name: '@noble/hashes', version: '0.0.0-test' }))
    writeFixtureFile(packageRoot, 'node_modules/fastify/package.json', JSON.stringify({
        name: 'fastify',
        version: '0.0.0-test',
        ...(!options.brokenFastifyRuntime ? { dependencies: { 'abstract-logging': '0.0.0-test' } } : {})
    }))
    writeFixtureFile(
        packageRoot,
        'node_modules/fastify/index.js',
        `require(${JSON.stringify(options.brokenFastifyRuntime ? 'abstract-logging/missing-runtime-entry' : 'abstract-logging')})\nmodule.exports = () => ({ ready: async () => {}, close: async () => {} })\n`
    )
    if (!options.brokenFastifyRuntime) {
        writeFixtureFile(packageRoot, 'node_modules/fastify/node_modules/abstract-logging/package.json', JSON.stringify({
            name: 'abstract-logging',
            version: '0.0.0-test'
        }))
        writeFixtureFile(packageRoot, 'node_modules/fastify/node_modules/abstract-logging/index.js', 'module.exports = {}\n')
    }
    if (options.removeFastifyTransitiveAfterInstall) {
        writeFixtureFile(
            packageRoot,
            'scripts/remove-fastify-transitive.mjs',
            `import { rmSync } from 'node:fs'\nrmSync(new URL('../node_modules/fastify/node_modules/abstract-logging', import.meta.url), { recursive: true, force: true })\n`
        )
    }

    const tarball = join(fixtureRoot, 'happy-cli.tgz')
    const tarResult = spawnSync('tar', ['-czf', tarball, '-C', fixtureRoot, 'package'], { encoding: 'utf8' })
    expect(tarResult.status, tarResult.stderr).toBe(0)
    return tarball
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { force: true, recursive: true })
    }
})

describe('guard-publish-artifact', () => {
    it('accepts an installed CLI whose reported Happy version matches package metadata', () => {
        const tarball = createPublishTarball('1.1.10-aplus.56', '1.1.10-aplus.56')
        const result = spawnSync(process.execPath, [GUARD_SCRIPT, tarball, '--install-smoke'], {
            encoding: 'utf8',
            timeout: 30_000
        })

        expect(result.status, result.stderr).toBe(0)
    }, 40_000)

    it('rejects an installed CLI whose runtime version differs from package metadata', () => {
        const tarball = createPublishTarball('1.1.10-aplus.56', '1.1.10-aplus.55')
        const result = spawnSync(process.execPath, [GUARD_SCRIPT, tarball, '--install-smoke'], {
            encoding: 'utf8',
            timeout: 30_000
        })

        expect(result.status).toBe(1)
        expect(result.stderr).toContain('CLI version output mismatch')
        expect(result.stderr).toContain('happy version: 1.1.10-aplus.55')
    }, 40_000)

    it('rejects extra provider output from the version command', () => {
        const tarball = createPublishTarball('1.1.10-aplus.56', '1.1.10-aplus.56', {
            extraVersionOutput: '\nprovider version: test'
        })
        const result = spawnSync(process.execPath, [GUARD_SCRIPT, tarball, '--install-smoke'], {
            encoding: 'utf8',
            timeout: 30_000
        })

        expect(result.status).toBe(1)
        expect(result.stderr).toContain('CLI version output mismatch')
        expect(result.stderr).toContain('provider version: test')
    }, 40_000)

    it('isolates HOME and HAPPY_HOME_DIR for every installed CLI command', () => {
        const realHome = mkdtempSync(join(tmpdir(), 'happy-cli-guard-real-home-'))
        temporaryDirectories.push(realHome)
        const sentinel = join(realHome, 'guard-cli-was-here')
        const tarball = createPublishTarball('1.1.10-aplus.56', '1.1.10-aplus.56', {
            writeHomeSentinel: true
        })
        const result = spawnSync(process.execPath, [GUARD_SCRIPT, tarball, '--install-smoke'], {
            encoding: 'utf8',
            timeout: 30_000,
            env: { ...process.env, HOME: realHome, HAPPY_HOME_DIR: realHome }
        })

        expect(result.status, result.stderr).toBe(0)
        expect(existsSync(sentinel)).toBe(false)
    }, 40_000)

    it('rejects an installed artifact with a missing production transitive dependency', () => {
        const tarball = createPublishTarball('1.1.10-aplus.56', '1.1.10-aplus.56', {
            removeFastifyTransitiveAfterInstall: true
        })
        const result = spawnSync(process.execPath, [GUARD_SCRIPT, tarball, '--install-smoke'], {
            encoding: 'utf8',
            timeout: 30_000
        })

        expect(result.status).toBe(1)
        expect(result.stderr).toContain('Production dependency closure failed')
        expect(result.stderr).toContain('abstract-logging')
    }, 40_000)

    it('rejects a dependency-complete artifact whose Fastify runtime cannot initialize', () => {
        const tarball = createPublishTarball('1.1.10-aplus.56', '1.1.10-aplus.56', {
            brokenFastifyRuntime: true
        })
        const result = spawnSync(process.execPath, [GUARD_SCRIPT, tarball, '--install-smoke'], {
            encoding: 'utf8',
            timeout: 30_000
        })

        expect(result.status).toBe(1)
        expect(result.stderr).toContain('Daemon runtime preflight failed')
        expect(result.stderr).toContain('abstract-logging')
    }, 40_000)
})
