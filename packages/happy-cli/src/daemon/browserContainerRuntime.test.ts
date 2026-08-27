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
            if (args[0] === 'inspect' && args.some((arg) => arg.includes('.Config.Env'))) {
                return '["HAPPY_BROWSER_BRIDGE_TOKEN=scoped-token-value"]\n'
            }
            if (args[0] === 'port') return '127.0.0.1:49123\n'
            return ''
        })
        const runtime = new BrowserContainerRuntime({ image: IMAGE, exec })

        await expect(runtime.ensure(VIEWER_KEY, 'scoped-token-value'))
            .resolves.toMatchObject({ webPort: 49123, reused: true })
        expect(exec.mock.calls.some(([, args]) => args[0] === 'run')).toBe(false)
    })

    it('recreates a healthy container when its scoped bridge token changed', async () => {
        const exec = vi.fn(async (_command: string, args: string[]) => {
            if (args[0] === 'inspect' && args.some((arg) => arg.includes('.State.Running'))) return 'true\n'
            if (args[0] === 'inspect' && args.some((arg) => arg.includes('.State.Health.Status'))) return 'healthy\n'
            if (args[0] === 'inspect' && args.some((arg) => arg.includes('.Config.Env'))) {
                return '["HAPPY_BROWSER_BRIDGE_TOKEN=previous-scoped-token"]\n'
            }
            if (args[0] === 'network' && args[1] === 'inspect') throw new Error('missing network')
            if (args[0] === 'port') return '127.0.0.1:49123\n'
            return ''
        })
        const runtime = new BrowserContainerRuntime({ image: IMAGE, exec })

        await runtime.ensure(VIEWER_KEY, 'current-scoped-token')

        expect(exec.mock.calls.some(([, args]) => args[0] === 'rm' && args.includes('--force'))).toBe(true)
        expect(exec.mock.calls.some(([, args]) => (
            args[0] === 'run' && args.includes('HAPPY_BROWSER_BRIDGE_TOKEN=current-scoped-token')
        ))).toBe(true)
    })

    it('waits for a running container whose healthcheck is still starting', async () => {
        let healthChecks = 0
        const exec = vi.fn(async (_command: string, args: string[]) => {
            if (args[0] === 'inspect' && args.some((arg) => arg.includes('.State.Running'))) return 'true\n'
            if (args[0] === 'inspect' && args.some((arg) => arg.includes('.State.Health.Status'))) {
                healthChecks += 1
                return healthChecks < 2 ? 'starting\n' : 'healthy\n'
            }
            if (args[0] === 'inspect' && args.some((arg) => arg.includes('.Config.Env'))) {
                return '["HAPPY_BROWSER_BRIDGE_TOKEN=scoped-token-value"]\n'
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
