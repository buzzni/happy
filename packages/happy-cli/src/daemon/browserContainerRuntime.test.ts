import { describe, expect, it, vi } from 'vitest'
import { BrowserContainerRuntime, buildBrowserContainerRunArgs } from './browserContainerRuntime'

const VIEWER_KEY = 'bv1_abcdefghijklmnopqrstuvwxyz012345'
const IMAGE = 'registry.test/browser@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

describe('browser container runtime', () => {
    it('publishes only loopback noVNC and enforces non-root resource limits', () => {
        const args = buildBrowserContainerRunArgs({ viewerKey: VIEWER_KEY, bridgeToken: 'scoped', image: IMAGE })
        expect(args).toContain('1000:1000')
        expect(args).toContain('127.0.0.1::6080/tcp')
        expect(args).toContain('--read-only')
        expect(args).toContain('no-new-privileges')
        expect(args).toContain('ALL')
        expect(args).toContain('HOME=/tmp')
        expect(args).toContain(`happy-browser-net-${VIEWER_KEY}`)
        expect(args).not.toContain('bridge')
        expect(args.join(' ')).not.toContain('9222')
        expect(args.join(' ')).not.toContain('5900')
        expect(args).not.toContain('/var/run/docker.sock')
    })

    it('requires an immutable digest-pinned image', () => {
        expect(() => buildBrowserContainerRunArgs({ viewerKey: VIEWER_KEY, bridgeToken: 'scoped', image: 'browser:latest' }))
            .toThrow('digest-pinned')
    })

    it('reuses a running container and resolves its loopback port', async () => {
        const exec = vi.fn(async (_command: string, args: string[]) => {
            if (args[0] === 'inspect' && args.some((arg) => arg.includes('.State.Running'))) return 'true\n'
            if (args[0] === 'inspect' && args.some((arg) => arg.includes('.State.Health.Status'))) return 'healthy\n'
            if (args[0] === 'port') return '127.0.0.1:49123\n'
            return ''
        })
        const runtime = new BrowserContainerRuntime({ image: IMAGE, exec })

        await expect(runtime.ensure(VIEWER_KEY, 'scoped-token-value'))
            .resolves.toMatchObject({ webPort: 49123, reused: true })
        expect(exec.mock.calls.some(([, args]) => args[0] === 'run')).toBe(false)
    })

    it('waits for a running container whose healthcheck is still starting', async () => {
        let healthChecks = 0
        const exec = vi.fn(async (_command: string, args: string[]) => {
            if (args[0] === 'inspect' && args.some((arg) => arg.includes('.State.Running'))) return 'true\n'
            if (args[0] === 'inspect' && args.some((arg) => arg.includes('.State.Health.Status'))) {
                healthChecks += 1
                return healthChecks < 2 ? 'starting\n' : 'healthy\n'
            }
            if (args[0] === 'port') return '127.0.0.1:49123\n'
            return ''
        })
        const runtime = new BrowserContainerRuntime({ image: IMAGE, exec })

        await expect(runtime.ensure(VIEWER_KEY, 'scoped-token-value'))
            .resolves.toMatchObject({ webPort: 49123, reused: true })
        expect(exec.mock.calls.some(([, args]) => args[0] === 'rm')).toBe(false)
    })

    it('replaces a stopped container without deleting its profile volume', async () => {
        const exec = vi.fn(async (_command: string, args: string[]) => {
            if (args[0] === 'inspect' && args.some((arg) => arg.includes('.State.Running'))) return 'false\n'
            if (args[0] === 'network' && args[1] === 'inspect') throw new Error('missing network')
            if (args[0] === 'inspect' && args.some((arg) => arg.includes('.State.Health.Status'))) return 'healthy\n'
            if (args[0] === 'port') return '127.0.0.1:49123\n'
            return ''
        })
        const runtime = new BrowserContainerRuntime({ image: IMAGE, exec })

        await expect(runtime.ensure(VIEWER_KEY, 'scoped-token-value'))
            .resolves.toMatchObject({ webPort: 49123, reused: false })
        expect(exec.mock.calls.some(([, args]) => args[0] === 'rm' && args.includes('--force'))).toBe(true)
        expect(exec.mock.calls.some(([, args]) => args[0] === 'network' && args[1] === 'create')).toBe(true)
        expect(exec.mock.calls.some(([, args]) => args[0] === 'volume' && args[1] === 'rm')).toBe(false)
    })

    it('does not adopt an unhealthy container as a ready lease', async () => {
        const exec = vi.fn(async (_command: string, args: string[]) => {
            if (args[0] === 'inspect' && args.some((arg) => arg.includes('.State.Running'))) return 'true\n'
            if (args[0] === 'inspect' && args.some((arg) => arg.includes('.State.Health.Status'))) return 'unhealthy\n'
            if (args[0] === 'port') return '127.0.0.1:49123\n'
            return ''
        })
        const runtime = new BrowserContainerRuntime({ image: IMAGE, exec })

        await expect(runtime.lookup(VIEWER_KEY)).resolves.toBeNull()
    })

    it('removes a failed partial container so the next ensure can recover', async () => {
        const exec = vi.fn(async (_command: string, args: string[]) => {
            if (args[0] === 'inspect' && args.some((arg) => arg.includes('.State.Running'))) throw new Error('missing')
            if (args[0] === 'network' && args[1] === 'inspect') throw new Error('missing network')
            if (args[0] === 'inspect' && args.some((arg) => arg.includes('.State.Health.Status'))) return 'unhealthy\n'
            return ''
        })
        const runtime = new BrowserContainerRuntime({ image: IMAGE, exec })

        await expect(runtime.ensure(VIEWER_KEY, 'scoped-token-value')).rejects.toThrow('unhealthy')
        expect(exec.mock.calls.some(([, args]) => args[0] === 'rm' && args.includes('--force'))).toBe(true)
        expect(exec.mock.calls.some(([, args]) => args[0] === 'network' && args[1] === 'rm')).toBe(true)
    })
})

/**
 * specs/runtime-isolation-hardening (H3, P3) — the broker is the only
 * component with Docker access, so it is the only one that can prove *which*
 * container is behind a viewer port. A container name or a profile volume
 * cannot: both survive a restart and a replacement unchanged. The fingerprint
 * is therefore taken only after the real container id, `State.StartedAt`, the
 * exact viewer label and the loopback `->6080` publish mapping all check out.
 *
 * When any of that cannot be read the fingerprint is simply absent — the
 * viewer still opens, but a bound request has nothing to verify against and
 * is refused daemon-side. It must never be replaced by weaker evidence.
 */
describe('browser container runtime — verified runtime fingerprint', () => {
    const CONTAINER_ID = 'c'.repeat(64)
    const inspectFormat = (args: string[]) => args.find((arg) => arg.includes('{{')) ?? ''

    function execFor(overrides: {
        id?: string
        startedAt?: string
        viewerLabel?: string
        sessionLabel?: string
        ports?: unknown
        hostPort?: string
        fingerprintInspectFails?: boolean
    } = {}) {
        const hostPort = overrides.hostPort ?? '49123'
        const ports = overrides.ports ?? { '6080/tcp': [{ HostIp: '127.0.0.1', HostPort: hostPort }] }
        return vi.fn(async (_command: string, args: string[]) => {
            if (args[0] === 'inspect' && inspectFormat(args).includes('.State.Running')) return 'true\n'
            if (args[0] === 'inspect' && inspectFormat(args).includes('.State.Health.Status')) return 'healthy\n'
            if (args[0] === 'inspect' && inspectFormat(args).includes('.State.StartedAt')) {
                if (overrides.fingerprintInspectFails) throw new Error('inspect denied')
                return [
                    overrides.id ?? CONTAINER_ID,
                    overrides.startedAt ?? '2026-09-11T04:05:06.700000000Z',
                    overrides.viewerLabel ?? VIEWER_KEY,
                    overrides.sessionLabel ?? '1',
                    JSON.stringify(ports),
                ].join('\t') + '\n'
            }
            if (args[0] === 'port') return `127.0.0.1:${hostPort}\n`
            return ''
        })
    }

    it('returns a fingerprint once id, start time, label and loopback mapping all verify', async () => {
        const runtime = new BrowserContainerRuntime({ image: IMAGE, exec: execFor() })
        const lease = await runtime.lookup(VIEWER_KEY)
        expect(lease).toMatchObject({ webPort: 49123 })
        expect(lease?.runtimeFingerprint).toMatch(/^[0-9a-f]{64}$/)
    })

    it('changes the fingerprint when the container restarts under the same id', async () => {
        // docker restart keeps Id and name; only State.StartedAt moves. A
        // fingerprint that misses this lets a token outlive the run it names.
        const before = await new BrowserContainerRuntime({ image: IMAGE, exec: execFor() }).lookup(VIEWER_KEY)
        const after = await new BrowserContainerRuntime({
            image: IMAGE,
            exec: execFor({ startedAt: '2026-09-11T09:09:09.000000000Z' }),
        }).lookup(VIEWER_KEY)
        expect(before?.runtimeFingerprint).toBeDefined()
        expect(after?.runtimeFingerprint).toBeDefined()
        expect(after?.runtimeFingerprint).not.toBe(before?.runtimeFingerprint)
    })

    it('changes the fingerprint when the container is replaced on the same port', async () => {
        const before = await new BrowserContainerRuntime({ image: IMAGE, exec: execFor() }).lookup(VIEWER_KEY)
        const after = await new BrowserContainerRuntime({
            image: IMAGE,
            exec: execFor({ id: 'd'.repeat(64) }),
        }).lookup(VIEWER_KEY)
        expect(after?.runtimeFingerprint).not.toBe(before?.runtimeFingerprint)
    })

    it('changes the fingerprint when the same container is republished on another host port', async () => {
        const before = await new BrowserContainerRuntime({ image: IMAGE, exec: execFor() }).lookup(VIEWER_KEY)
        const after = await new BrowserContainerRuntime({
            image: IMAGE,
            exec: execFor({ hostPort: '49999' }),
        }).lookup(VIEWER_KEY)
        expect(after?.runtimeFingerprint).not.toBe(before?.runtimeFingerprint)
    })

    it.each([
        ['the viewer label names another key', { viewerLabel: 'bv1_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' }],
        ['the viewer label is missing', { viewerLabel: '<no value>' }],
        ['the managed-session label is absent', { sessionLabel: '<no value>' }],
        ['the container id is not a real id', { id: 'not-an-id' }],
        ['the start time is docker\'s zero value', { startedAt: '0001-01-01T00:00:00Z' }],
        ['the start time is empty', { startedAt: '<no value>' }],
        ['inspect itself fails', { fingerprintInspectFails: true }],
        ['6080 is not published at all', { ports: { '5900/tcp': [{ HostIp: '127.0.0.1', HostPort: '49123' }] } }],
        ['6080 is published on all interfaces', { ports: { '6080/tcp': [{ HostIp: '0.0.0.0', HostPort: '49123' }] } }],
        ['6080 is published beyond loopback as well', {
            ports: {
                '6080/tcp': [
                    { HostIp: '127.0.0.1', HostPort: '49123' },
                    { HostIp: '0.0.0.0', HostPort: '49123' },
                ],
            },
        }],
        ['the published host port disagrees with docker port', {
            ports: { '6080/tcp': [{ HostIp: '127.0.0.1', HostPort: '49124' }] },
        }],
        ['the ports payload is not parseable', { ports: undefined, hostPort: '49123' }],
    ])('withholds the fingerprint when %s', async (_label, overrides) => {
        const exec = (overrides as { ports?: unknown }).ports === undefined
            && !('fingerprintInspectFails' in overrides)
            && Object.keys(overrides).length === 2
            ? vi.fn(async (_command: string, args: string[]) => {
                if (args[0] === 'inspect' && inspectFormat(args).includes('.State.Running')) return 'true\n'
                if (args[0] === 'inspect' && inspectFormat(args).includes('.State.Health.Status')) return 'healthy\n'
                if (args[0] === 'inspect' && inspectFormat(args).includes('.State.StartedAt')) {
                    return `${CONTAINER_ID}\t2026-09-11T04:05:06.700000000Z\t${VIEWER_KEY}\t1\tnot-json\n`
                }
                if (args[0] === 'port') return '127.0.0.1:49123\n'
                return ''
            })
            : execFor(overrides as never)
        const runtime = new BrowserContainerRuntime({ image: IMAGE, exec })

        const lease = await runtime.lookup(VIEWER_KEY)
        // The viewer still works; only the bound path loses its evidence.
        expect(lease).toMatchObject({ webPort: 49123 })
        expect(lease?.runtimeFingerprint).toBeUndefined()
    })

    it('returns nothing at all when the container is not running', async () => {
        const exec = vi.fn(async (_command: string, args: string[]) => {
            if (args[0] === 'inspect' && inspectFormat(args).includes('.State.Running')) return 'false\n'
            return ''
        })
        await expect(new BrowserContainerRuntime({ image: IMAGE, exec }).lookup(VIEWER_KEY)).resolves.toBeNull()
    })
})
