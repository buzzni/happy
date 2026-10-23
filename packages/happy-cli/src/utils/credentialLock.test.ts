import { afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { CredentialLockTimeoutError, credentialFileLockPath, withCredentialLock } from './credentialLock'

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })

async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'credential-lock-')); dirs.push(dir)
    return dir
}

const PACKAGE_ROOT = resolve(__dirname, '../..')
const SECRET = 'rt-CHILD-SECRET-0001'

/** 갱신 1회를 세는 자식 프로세스. 실제 credentialLock·refreshRecovery 를 tsx 로 불러 쓴다. */
const CHILD = String.raw`
import { appendFile, readFile, writeFile, access } from 'node:fs/promises'
import { credentialFileLockPath, withCredentialLock } from '${resolve(__dirname, 'credentialLock.ts')}'
import { credentialFingerprint, recoverCredential } from '${resolve(__dirname, 'refreshRecovery.ts')}'
const [file, counter, go] = process.argv.slice(2)
const fp = (secret) => credentialFingerprint('test', 'account-1', secret)
const used = fp(JSON.parse(await readFile(file, 'utf8')).refreshToken)
const lockPath = credentialFileLockPath(file)
console.log('ready')
for (;;) { try { await access(go); break } catch { await new Promise(r => setTimeout(r, 5)) } }
const outcome = await recoverCredential({
    read: async () => JSON.parse(await readFile(file, 'utf8')).refreshToken,
    fingerprint: fp,
    refresh: async () => {
        await appendFile(counter, 'refresh\n')
        // 상대가 락 앞에서 기다리게 만들 만큼 길게.
        await new Promise(r => setTimeout(r, 400))
        return 'rt-REFRESHED-' + process.pid
    },
    write: async (next) => writeFile(file, JSON.stringify({ refreshToken: next })),
}, used, { lock: (work) => withCredentialLock(lockPath, work) })
console.log(JSON.stringify(outcome.status))
`

function runChild(script: string, args: string[], home: string) {
    const child = spawn(process.execPath, ['--import', 'tsx', script, ...args], {
        cwd: PACKAGE_ROOT,
        env: { ...process.env, HAPPY_HOME_DIR: home },
        stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const ready = new Promise<void>((resolveReady) => {
        child.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString()
            if (stdout.includes('ready')) resolveReady()
        })
    })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    const done = new Promise<string>((resolveDone, reject) => {
        child.once('exit', code => code === 0 ? resolveDone(stdout) : reject(new Error(`child exited ${code}: ${stderr}`)))
    })
    return { ready, done }
}

const ownerJson = (overrides: Record<string, unknown>) => JSON.stringify({
    version: 1, pid: process.pid, startedAt: 1_000, token: '22222222-2222-4222-8222-222222222222', acquiredAt: Date.now(), ...overrides,
})

describe('withCredentialLock across processes', () => {
    it('lets two processes refresh the same credential only once; the second skips after reloading', async () => {
        const dir = await tempDir()
        const file = join(dir, 'auth.json')
        const counter = join(dir, 'refresh-count')
        const go = join(dir, 'go')
        const script = join(dir, 'child.mts')
        await writeFile(file, JSON.stringify({ refreshToken: SECRET }))
        await writeFile(counter, '')
        await writeFile(script, CHILD)

        const a = runChild(script, [file, counter, go], dir)
        const b = runChild(script, [file, counter, go], dir)
        await Promise.all([a.ready, b.ready])
        await writeFile(go, '')
        const outputs = await Promise.all([a.done, b.done])

        expect((await readFile(counter, 'utf8')).trim().split('\n')).toEqual(['refresh'])
        const statuses = outputs.map(out => out.trim().split('\n').at(-1)).sort()
        expect(statuses).toEqual(['"lost-race"', '"refreshed"'])
        // 락은 풀렸고, 락 파일 어디에도 자격 값은 남지 않았다.
        expect((await readdir(dir)).filter(name => name.includes('saycode-credential'))).toEqual([])
    }, 60_000)
})

describe('withCredentialLock reclaim and wait', () => {
    it('reclaims a lock whose owner has exited', async () => {
        const dir = await tempDir()
        const lockPath = credentialFileLockPath(join(dir, 'auth.json'))
        const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
        await new Promise(resolveExit => dead.once('exit', resolveExit))
        await writeFile(lockPath, ownerJson({ pid: dead.pid }))
        const logs: string[] = []
        expect(await withCredentialLock(lockPath, async () => 'ran', { waitMs: 500, deps: { log: line => { logs.push(line) } } })).toBe('ran')
        expect(logs.join('\n')).toContain('owner-exited')
    })

    it('reclaims a live owner\'s lock recorded under another boot', async () => {
        const dir = await tempDir()
        const lockPath = credentialFileLockPath(join(dir, 'auth.json'))
        await writeFile(lockPath, ownerJson({ bootId: 'boot-before-restart' }))
        const logs: string[] = []
        expect(await withCredentialLock(lockPath, async () => 'ran', { waitMs: 500, deps: { bootId: 'boot-now', log: line => { logs.push(line) } } })).toBe('ran')
        expect(logs.join('\n')).toContain('other-boot')
    })

    it('reclaims a live owner\'s lock held for more than 120 seconds', async () => {
        const dir = await tempDir()
        const lockPath = credentialFileLockPath(join(dir, 'auth.json'))
        await writeFile(lockPath, ownerJson({ acquiredAt: Date.now() - 121_000 }))
        const logs: string[] = []
        expect(await withCredentialLock(lockPath, async () => 'ran', { waitMs: 500, deps: { log: line => { logs.push(line) } } })).toBe('ran')
        expect(logs.join('\n')).toContain('hold-expired')
    })

    it('waits for a live, fresh holder and gives up with a timeout', async () => {
        const dir = await tempDir()
        const lockPath = credentialFileLockPath(join(dir, 'auth.json'))
        await writeFile(lockPath, ownerJson({ bootId: 'boot-now' }))
        const startedAt = Date.now()
        await expect(withCredentialLock(lockPath, async () => 'ran', { waitMs: 300, deps: { bootId: 'boot-now', log: () => {} } }))
            .rejects.toBeInstanceOf(CredentialLockTimeoutError)
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(300)
        expect(JSON.parse(await readFile(lockPath, 'utf8')).token).toBe('22222222-2222-4222-8222-222222222222')
    })

    it('gets the lock as soon as the holder releases it', async () => {
        const dir = await tempDir()
        const lockPath = credentialFileLockPath(join(dir, 'auth.json'))
        let release!: () => void
        const held = withCredentialLock(lockPath, () => new Promise<void>(resolveHeld => { release = resolveHeld }))
        await new Promise(resolveTick => setTimeout(resolveTick, 50))
        const second = withCredentialLock(lockPath, async () => 'second', { waitMs: 5_000 })
        setTimeout(() => release(), 100)
        await held
        expect(await second).toBe('second')
    })

    it('passes errors from the work through instead of retrying', async () => {
        const dir = await tempDir()
        const lockPath = credentialFileLockPath(join(dir, 'auth.json'))
        await expect(withCredentialLock(lockPath, async () => { throw new Error('work failed') })).rejects.toThrow('work failed')
    })
})

describe('credentialFileLockPath', () => {
    it('puts the lock beside the credential, named by a hash of its real path', async () => {
        const dir = await tempDir()
        const file = join(dir, 'auth.json')
        await writeFile(file, '{}')
        const alias = join(await tempDir(), 'linked')
        await symlink(dir, alias)

        const lockPath = credentialFileLockPath(file)
        expect(credentialFileLockPath(join(alias, 'auth.json'))).toBe(lockPath)
        expect(dirname(lockPath)).toBe(await realpath(dir))
        expect(lockPath).toMatch(/\.saycode-credential-[0-9a-f]{32}\.lock$/)
        expect(lockPath).not.toContain('auth.json')
        // 파일이 아직 없어도 같은 키다.
        expect(credentialFileLockPath(join(dir, 'missing.json'))).not.toBe(lockPath)
        expect(credentialFileLockPath(join(alias, 'missing.json'))).toBe(credentialFileLockPath(join(dir, 'missing.json')))
    })
})
