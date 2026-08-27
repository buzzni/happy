import { lstat, mkdtemp } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { startBrowserSessionBrokerServer } from './browserSessionBrokerServer'

const { chownMock } = vi.hoisted(() => ({
    chownMock: vi.fn(async () => undefined),
}))

vi.mock('node:fs/promises', async (importOriginal) => ({
    ...await importOriginal<typeof import('node:fs/promises')>(),
    chown: chownMock,
}))

const VIEWER_KEY = 'bv1_abcdefghijklmnopqrstuvwxyz012345'

function broker() {
    return {
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
}

describe('browser session broker Unix socket', () => {
    it('uses group-only permissions and exposes only the bounded request protocol', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'browser-broker-socket-'))
        const socketPath = join(dir, 'broker.sock')
        const brokerInstance = broker()
        const server = await startBrowserSessionBrokerServer({
            broker: brokerInstance as any,
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
            expect(brokerInstance.touchWebPort).toHaveBeenCalledWith(49100)
        } finally {
            await server.stop()
        }
    })

    it('makes a fresh socket directory traversable by the daemon group', async () => {
        // macOS sockaddr_un.sun_path is limited to 104 bytes; keep the
        // nested path short while still exercising fresh-directory setup.
        const dir = await mkdtemp(join(tmpdir(), 'bb-'))
        const socketDir = join(dir, 'run')
        const socketPath = join(socketDir, 'broker.sock')
        const socketGid = 4242
        const getuid = process.getuid
        process.getuid = () => 0
        chownMock.mockClear()

        const server = await startBrowserSessionBrokerServer({
            broker: broker() as any,
            socketPath,
            socketGid,
        })
        try {
            expect(chownMock).toHaveBeenCalledWith(socketDir, 0, socketGid)
            expect(chownMock).toHaveBeenCalledWith(socketPath, 0, socketGid)
        } finally {
            process.getuid = getuid
            await server.stop()
        }
    })
})
