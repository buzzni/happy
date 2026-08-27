import { lstat, mkdtemp } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { startBrowserSessionBrokerServer } from './browserSessionBrokerServer'

const VIEWER_KEY = 'bv1_abcdefghijklmnopqrstuvwxyz012345'

describe('browser session broker Unix socket', () => {
    it('uses group-only permissions and exposes only the bounded request protocol', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'browser-broker-socket-'))
        const socketPath = join(dir, 'broker.sock')
        const broker = {
            reconcile: vi.fn(async () => undefined),
            sweepIdle: vi.fn(async () => []),
            ensure: vi.fn(async (viewerKey: string) => ({
                viewerKey, webPort: 49100, profileVolume: 'volume-a', ready: true,
                lastUsedAt: 1, isolation: 'container' as const,
            })),
            lookup: vi.fn(async () => null),
            touch: vi.fn(async () => null),
            touchWebPort: vi.fn(async () => null),
            stop: vi.fn(async () => true),
            migrateLegacy: vi.fn(async () => true),
        }
        const server = await startBrowserSessionBrokerServer({
            broker: broker as any,
            socketPath,
            socketGid: process.getgid?.() ?? 0,
            allowNonRootForTests: true,
        })
        try {
            expect((await lstat(socketPath)).mode & 0o777).toBe(0o660)
            const response = await new Promise<any>((resolve, reject) => {
                const socket = createConnection(socketPath)
                let body = ''
                socket.setEncoding('utf8')
                socket.on('connect', () => socket.write(`${JSON.stringify({
                    op: 'ensure', viewerKey: VIEWER_KEY, bridgeToken: 'scoped-token-value',
                })}\n`))
                socket.on('data', (chunk) => { body += chunk })
                socket.on('end', () => resolve(JSON.parse(body)))
                socket.on('error', reject)
            })
            expect(response).toMatchObject({ ok: true, lease: { viewerKey: VIEWER_KEY, webPort: 49100 } })
            await new Promise<void>((resolve, reject) => {
                const socket = createConnection(socketPath)
                socket.setEncoding('utf8')
                socket.on('connect', () => socket.write(`${JSON.stringify({ op: 'touch-port', webPort: 49100 })}\n`))
                socket.on('data', () => undefined)
                socket.on('end', resolve)
                socket.on('error', reject)
            })
            expect(broker.touchWebPort).toHaveBeenCalledWith(49100)
        } finally {
            await server.stop()
        }
    })
})
