import { createHash, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createStack } from './abp-stack.mjs'
import { mergeInstallOptions, PATHS } from './lib/abpPlan.mjs'

const RUNTIME_OLD = 'sha256:' + 'a'.repeat(64)
const BROWSER_OLD = 'sha256:' + 'b'.repeat(64)
const RUNTIME_NEW = 'sha256:' + 'c'.repeat(64)
const BROWSER_NEW = 'sha256:' + 'd'.repeat(64)

type Result = { status: number; stdout: string; stderr: string }
type Handler = (args: string[]) => Partial<Result> | undefined

/** Records every command; files live in a map; readiness is scripted per call. */
function fakeHost(options: { current?: { runtime: string; browser: string } | null; previous?: { runtime: string; browser: string } | null; ready?: Array<number>; handlers?: Array<[RegExp, Handler]> } = {}) {
    const calls: string[] = []
    const logs: string[] = []
    const files = new Map<string, { data: string; mode: number; owner: string; group: string }>()
    const install = mergeInstallOptions(undefined, {
        machineId: 'machine-1', workspaceId: 'ws-1',
        profiles: [{ profileId: 'main', principalId: 'user-1' }, { profileId: 'ops', principalId: 'user-2' }],
        issuers: [{ kid: 'k1', publicKeyPem: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString() }],
    })
    files.set(PATHS.installConfig, { data: JSON.stringify(install), mode: 0o600, owner: 'root', group: 'root' })
    files.set(PATHS.runtimeConfig, { data: JSON.stringify({ daemonTokenSha256: 'e'.repeat(64) }), mode: 0o600, owner: 'root', group: 'root' })
    files.set(PATHS.stackState, { data: JSON.stringify({ schemaVersion: 1, current: options.current === undefined ? { runtime: RUNTIME_OLD, browser: BROWSER_OLD } : options.current, previous: options.previous ?? null, history: [] }), mode: 0o600, owner: 'root', group: 'root' })
    const ready = [...(options.ready ?? [])]
    let secretCount = 0
    const deps = {
        run(cmd: string, args: string[], opts: { allowFail?: boolean } = {}): Result {
            const line = [cmd, ...args].join(' ')
            calls.push(line)
            for (const [pattern, handler] of options.handlers ?? []) {
                if (pattern.test(line)) {
                    const result = { status: 0, stdout: '', stderr: '', ...handler(args) }
                    if (result.status !== 0 && !opts.allowFail) throw new Error(`${cmd} failed`)
                    return result
                }
            }
            return { status: 0, stdout: '', stderr: '' }
        },
        readFile(path: string) {
            const file = files.get(path)
            if (!file) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
            return file.data
        },
        exists: (path: string) => files.has(path),
        writeFileAtomic(path: string, data: string, meta: { mode: number; owner: string; group: string }) { files.set(path, { data, ...meta }) },
        groupId: (name: string) => (name === 'abp-session' ? 990 : 1),
        async ready() { return { status: ready.length ? ready.shift()! : 200, body: {} } },
        async sleep() {},
        now: () => 1_000_000,
        log: (line: string) => { logs.push(line) },
        secret: (kind: string) => `synthetic-${kind}-${++secretCount}`.padEnd(kind === 'vnc-password' ? 0 : 40, 'x').slice(0, kind === 'vnc-password' ? 8 : 64),
    }
    return { deps, calls, logs, files, state: () => JSON.parse(files.get(PATHS.stackState)!.data) }
}

const indexOf = (calls: string[], pattern: RegExp) => calls.findIndex((line) => pattern.test(line))

describe('abp-stack start / supervise / stop', () => {
    it('creates missing networks and volumes, replaces old containers, starts browsers before the Runtime from the pinned digests', async () => {
        const host = fakeHost({ handlers: [
            [/^docker network inspect abp-net-ops/, () => ({ status: 1 })],
            [/^docker volume inspect abp-profile-ops/, () => ({ status: 1 })],
            [/^docker ps -aq --filter label=ai.saycode.abp=stack/, () => ({ stdout: 'old1\nold2' })],
        ] })
        await createStack(host.deps).start()
        const { calls } = host
        expect(calls).toContain('docker network create --driver=bridge --label=ai.saycode.abp=stack abp-net-ops')
        expect(calls.some((line) => line.startsWith('docker network create') && line.includes('abp-net-main'))).toBe(false)
        expect(calls).toContain('docker volume create --label=ai.saycode.abp=stack abp-profile-ops')
        expect(calls).toContain('docker rm -f old1 old2')
        const browserCreate = indexOf(calls, /^docker create --name=abp-browser-main .*sha256:b{64}$/)
        const runtimeCreate = indexOf(calls, /^docker create --name=abp-runtime .*sha256:a{64}$/)
        expect(browserCreate).toBeGreaterThan(indexOf(calls, /^docker rm -f/))
        expect(runtimeCreate).toBeGreaterThan(browserCreate)
        expect(calls).toContain('docker network connect --alias=runtime abp-net-ops abp-runtime')
        expect(indexOf(calls, /^docker start abp-runtime$/)).toBeGreaterThan(indexOf(calls, /^docker network connect/))
        expect(calls.some((line) => /volume rm|--no-sandbox/.test(line))).toBe(false)
    })

    it('refuses to start without installed images', async () => {
        const host = fakeHost({ current: null })
        await expect(createStack(host.deps).start()).rejects.toThrow(/no images/)
    })

    it('restarts an exited container only after its backoff, and logs the exit code', async () => {
        let now = 0
        const host = fakeHost({ handlers: [
            [/^docker inspect -f .* abp-runtime$/, () => ({ stdout: 'false 75' })],
            [/^docker inspect -f .* abp-browser-/, () => ({ stdout: 'true 0' })],
        ] })
        host.deps.now = () => now
        const stack = createStack(host.deps)
        const backoff = new Map()
        stack.superviseOnce(backoff)
        expect(host.calls.filter((line) => line === 'docker start abp-runtime')).toHaveLength(1)
        expect(host.logs.join('\n')).toMatch(/abp-runtime exited status=75/)
        now = 500
        stack.superviseOnce(backoff)
        expect(host.calls.filter((line) => line === 'docker start abp-runtime')).toHaveLength(1)
        now = 5_000
        stack.superviseOnce(backoff)
        expect(host.calls.filter((line) => line === 'docker start abp-runtime')).toHaveLength(2)
        expect(host.calls.some((line) => line.startsWith('docker start abp-browser'))).toBe(false)
    })

    it('stops the Runtime first (tasks recover paused), then the browsers, and keeps every volume', () => {
        const host = fakeHost()
        createStack(host.deps).stop()
        expect(host.calls[0]).toBe('docker stop -t 30 abp-runtime')
        expect(host.calls.slice(1)).toEqual(['docker stop -t 10 abp-browser-main', 'docker stop -t 10 abp-browser-ops'])
    })
})

describe('abp-stack upgrade / rollback', () => {
    const labels = (runtime: string): Array<[RegExp, Handler]> => [[/^docker inspect -f \{\{index .Config.Labels "ai.saycode.abp.image"\}\} abp-runtime$/, () => ({ stdout: runtime })]]

    it('stops the stack, switches to the new digests, waits for /v1/ready and keeps the old digests for rollback', async () => {
        const host = fakeHost({ handlers: [[/^docker image inspect/, (args) => ({ stdout: args.at(-1) })], ...labels(RUNTIME_NEW)] })
        await createStack(host.deps).upgrade({ ids: { runtime: RUNTIME_NEW, browser: BROWSER_NEW }, readyTimeoutMs: 10_000 })
        expect(host.state()).toMatchObject({ current: { runtime: RUNTIME_NEW, browser: BROWSER_NEW }, previous: { runtime: RUNTIME_OLD, browser: BROWSER_OLD } })
        expect(host.state().history.at(-1)).toMatchObject({ action: 'upgrade', result: 'ready' })
        const stop = host.calls.indexOf('systemctl stop abp-stack.service')
        const start = host.calls.indexOf('systemctl start abp-stack.service')
        expect(stop).toBeGreaterThanOrEqual(0)
        expect(start).toBeGreaterThan(stop)
        expect(host.calls.some((line) => /volume rm/.test(line))).toBe(false)
    })

    it('rolls back to the previous digests when the new Runtime never becomes ready', async () => {
        let runtimeLabel = RUNTIME_NEW
        const host = fakeHost({
            ready: Array(50).fill(503),
            handlers: [
                [/^docker image inspect/, (args) => ({ stdout: args.at(-1) })],
                [/^systemctl start abp-stack.service/, () => { runtimeLabel = JSON.parse(host.files.get(PATHS.stackState)!.data).current.runtime; return {} }],
                [/^docker inspect -f \{\{index .Config.Labels "ai.saycode.abp.image"\}\} abp-runtime$/, () => ({ stdout: runtimeLabel })],
            ],
        })
        let attempt = 0
        host.deps.ready = async () => ({ status: runtimeLabel === RUNTIME_OLD ? 200 : 503, body: { attempt: attempt++ } })
        let clock = 0
        host.deps.now = () => (clock += 1_000)
        await expect(createStack(host.deps).upgrade({ ids: { runtime: RUNTIME_NEW, browser: BROWSER_NEW }, readyTimeoutMs: 5_000 })).rejects.toThrow(/rolled back/)
        expect(host.state()).toMatchObject({ current: { runtime: RUNTIME_OLD, browser: BROWSER_OLD } })
        expect(host.state().history.map((entry: { action: string; result: string }) => `${entry.action}:${entry.result}`)).toEqual(['upgrade:not-ready', 'auto-rollback:ready'])
        expect(host.calls.filter((line) => line === 'systemctl start abp-stack.service')).toHaveLength(2)
        expect(host.calls.some((line) => /volume rm/.test(line))).toBe(false)
    })

    it('refuses an upgrade to digests that are not loaded', async () => {
        const host = fakeHost({ handlers: [[/^docker image inspect/, () => ({ status: 1 })]] })
        await expect(createStack(host.deps).upgrade({ ids: { runtime: RUNTIME_NEW, browser: BROWSER_NEW }, readyTimeoutMs: 1 })).rejects.toThrow(/not loaded/)
        expect(host.calls).not.toContain('systemctl stop abp-stack.service')
    })

    it('rollback switches current and previous', async () => {
        const host = fakeHost({ current: { runtime: RUNTIME_NEW, browser: BROWSER_NEW }, previous: { runtime: RUNTIME_OLD, browser: BROWSER_OLD }, handlers: [[/^docker image inspect/, (args) => ({ stdout: args.at(-1) })], ...labels(RUNTIME_OLD)] })
        await createStack(host.deps).rollback({ readyTimeoutMs: 10_000 })
        expect(host.state()).toMatchObject({ current: { runtime: RUNTIME_OLD }, previous: { runtime: RUNTIME_NEW } })
    })
})

describe('abp-stack load', () => {
    it('loads the image archive and accepts it only when every manifest digest is present', () => {
        const manifest = JSON.stringify({ schemaVersion: 1, runtime: { id: RUNTIME_NEW }, browser: { id: BROWSER_NEW } })
        const host = fakeHost({ handlers: [[/^docker image inspect/, (args) => ({ stdout: args.at(-1) === BROWSER_NEW ? 'sha256:' + '0'.repeat(64) : args.at(-1) })]] })
        host.files.set('/imgs/manifest.json', { data: manifest, mode: 0o644, owner: 'root', group: 'root' })
        expect(() => createStack(host.deps).load('/imgs')).toThrow(/browser image digest mismatch/)
        expect(host.calls[0]).toBe('docker load -i /imgs/images.tar')
    })
})

describe('abp-stack rotate-keys', () => {
    it('rotates the daemon token: new 0400 agent file, matching hash in runtime.json, Runtime then daemon restarted, token never logged', async () => {
        const host = fakeHost()
        await createStack(host.deps).rotateKeys({ daemonToken: true, vncPassword: false })
        const token = host.files.get(PATHS.daemonToken)!
        expect(token).toMatchObject({ mode: 0o400, owner: 'agent', group: 'agent' })
        const config = JSON.parse(host.files.get(PATHS.runtimeConfig)!.data)
        expect(config.daemonTokenSha256).toBe(createHash('sha256').update(token.data).digest('hex'))
        expect(config.brokerSocketGid).toBe(990)
        expect(host.files.get(PATHS.runtimeConfig)).toMatchObject({ mode: 0o600, owner: 'root', group: 'root' })
        const restartRuntime = host.calls.indexOf('docker restart -t 30 abp-runtime')
        expect(restartRuntime).toBeGreaterThanOrEqual(0)
        expect(host.calls.indexOf('systemctl restart abp-happy-daemon.service')).toBeGreaterThan(restartRuntime)
        expect([...host.calls, ...host.logs].join('\n')).not.toContain(token.data)
    })

    it('rotates the VNC password for the Runtime and every browser without restarting Chromium', async () => {
        const host = fakeHost()
        await createStack(host.deps).rotateKeys({ daemonToken: false, vncPassword: true })
        const runtimeCopy = host.files.get(`${PATHS.runtimeSecrets}/vnc-password`)!
        const browserCopy = host.files.get(`${PATHS.browserSecrets}/vnc-password`)!
        expect(runtimeCopy.data).toBe(browserCopy.data)
        expect(runtimeCopy).toMatchObject({ mode: 0o440, owner: 'abp-runtime', group: 'root' })
        expect(browserCopy).toMatchObject({ mode: 0o400, owner: 'abp-browser', group: 'abp-browser' })
        expect(host.calls).toContain('docker exec abp-browser-main pkill -x x11vnc')
        expect(host.calls).toContain('docker exec abp-browser-ops pkill -x x11vnc')
        expect(host.calls).toContain('docker restart -t 30 abp-runtime')
        expect(host.calls.some((line) => /restart.*abp-browser|stop.*abp-browser/.test(line))).toBe(false)
        expect([...host.calls, ...host.logs].join('\n')).not.toContain(runtimeCopy.data)
    })
})

describe('abp-stack set-principal', () => {
    it('reassigns a profile owner in both config files and restarts the Runtime', () => {
        const host = fakeHost()
        createStack(host.deps).setPrincipal('ops', 'user-9')
        expect(JSON.parse(host.files.get(PATHS.installConfig)!.data).profiles).toContainEqual({ profileId: 'ops', principalId: 'user-9' })
        const config = JSON.parse(host.files.get(PATHS.runtimeConfig)!.data)
        expect(config.profiles).toContainEqual({ profileId: 'ops', principalId: 'user-9' })
        expect(config.daemonTokenSha256).toBe('e'.repeat(64))
        expect(host.calls).toContain('docker restart -t 30 abp-runtime')
        expect(() => createStack(host.deps).setPrincipal('nope', 'user-9')).toThrow(/unknown profile/)
    })
})

describe('abp-stack status', () => {
    const healthy: Array<[RegExp, Handler]> = [
        [/^systemctl is-active abp-stack.service/, () => ({ stdout: 'active' })],
        [/^docker inspect -f \{\{\.State\.Running\}\} \{\{index \.Config\.Labels "ai\.saycode\.abp\.image"\}\} abp-runtime/, () => ({ stdout: `true ${RUNTIME_OLD}` })],
        [/^docker inspect -f \{\{\.State\.Running\}\} \{\{index \.Config\.Labels "ai\.saycode\.abp\.image"\}\} abp-browser/, () => ({ stdout: `true ${BROWSER_OLD}` })],
        [/^docker ps --filter label=ai.saycode.abp=stack --format/, () => ({ stdout: 'abp-runtime\t127.0.0.1:38700->38700/tcp\nabp-browser-main\t5900/tcp, 9223-9224/tcp\nabp-browser-ops\t' })],
        [/^docker exec abp-browser-\S+ sh -c/, () => ({ stdout: 'pid1 user:[1]\nsandboxed 2\nnosandbox 0' })],
    ]

    it('reports ready when only the Runtime port is published on loopback and Chromium runs sandboxed', async () => {
        const host = fakeHost({ handlers: healthy })
        const report = await createStack(host.deps).status()
        expect(report.ok).toBe(true)
        expect(report.checks.every((check: { ok: boolean }) => check.ok)).toBe(true)
    })

    it('fails on any other published port, a browser without its sandbox, or an image that is not the pinned digest', async () => {
        const host = fakeHost({ handlers: [
            [/^docker ps --filter/, () => ({ stdout: 'abp-runtime\t0.0.0.0:38700->38700/tcp\nabp-browser-main\t127.0.0.1:6080->6080/tcp' })],
            [/^docker exec abp-browser-main sh -c/, () => ({ stdout: 'pid1 user:[1]\nsandboxed 0\nnosandbox 1' })],
            [/^docker inspect -f \{\{\.State\.Running\}\} \{\{index \.Config\.Labels "ai\.saycode\.abp\.image"\}\} abp-browser-ops/, () => ({ stdout: `true ${BROWSER_NEW}` })],
            ...healthy,
        ] })
        const report = await createStack(host.deps).status()
        expect(report.ok).toBe(false)
        const failed = report.checks.filter((check: { ok: boolean }) => !check.ok).map((check: { name: string }) => check.name)
        expect(failed).toEqual(expect.arrayContaining(['published ports', 'chromium sandbox abp-browser-main', 'container abp-browser-ops']))
    })
})
