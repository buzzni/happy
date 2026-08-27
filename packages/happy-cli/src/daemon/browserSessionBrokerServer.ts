import { chmod, chown, lstat, mkdir, unlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname } from 'node:path'
import { parseBrowserSessionBrokerRequest, type BrowserSessionBrokerResponse } from './browserSessionBrokerContract'
import type { BrowserSessionBroker } from './browserSessionBroker'

function failure(error: unknown): BrowserSessionBrokerResponse {
    const message = error instanceof Error ? error.message : String(error)
    return {
        ok: false,
        code: message === 'viewer-capacity-exhausted' ? message : 'browser-broker-request-failed',
        error: message,
    }
}

async function dispatch(
    broker: BrowserSessionBroker,
    raw: unknown,
): Promise<BrowserSessionBrokerResponse> {
    const request = parseBrowserSessionBrokerRequest(raw)
    switch (request.op) {
        case 'ensure':
            return { ok: true, lease: await broker.ensure(request.viewerKey, request.bridgeToken) }
        case 'lookup':
            return { ok: true, lease: await broker.lookup(request.viewerKey) }
        case 'touch':
            return { ok: true, lease: await broker.touch(request.viewerKey) }
        case 'touch-port':
            return { ok: true, lease: await broker.touchWebPort(request.webPort) }
        case 'stop':
            return { ok: true, lease: null, stopped: await broker.stop(request.viewerKey) }
        case 'migrate-legacy':
            return { ok: true, lease: null, migrated: await broker.migrateLegacy(request.viewerKey) }
    }
}

export async function startBrowserSessionBrokerServer(input: {
    broker: BrowserSessionBroker
    socketPath: string
    socketGid: number
    allowNonRootForTests?: boolean
}): Promise<{ stop: () => Promise<void> }> {
    if (!input.allowNonRootForTests && process.getuid?.() !== 0) {
        throw new Error('browser session broker must run as root')
    }
    const socketDir = dirname(input.socketPath)
    const createdDir = await mkdir(socketDir, { recursive: true, mode: 0o750 })
    if (!input.allowNonRootForTests && createdDir !== undefined) {
        await chown(socketDir, 0, input.socketGid)
        await chmod(socketDir, 0o750)
    }
    try {
        const current = await lstat(input.socketPath)
        if (!current.isSocket()) throw new Error('refusing to replace non-socket broker path')
        await unlink(input.socketPath)
    } catch (error) {
        if (error instanceof Error && error.message === 'refusing to replace non-socket broker path') throw error
    }

    await input.broker.reconcile()
    const server = createServer((socket) => {
        socket.setEncoding('utf8')
        let buffer = ''
        socket.on('data', async (chunk) => {
            buffer += chunk
            if (buffer.length > 64 * 1024) {
                socket.end(`${JSON.stringify(failure(new Error('request too large')))}\n`)
                return
            }
            const newline = buffer.indexOf('\n')
            if (newline < 0) return
            const line = buffer.slice(0, newline)
            buffer = ''
            try {
                socket.end(`${JSON.stringify(await dispatch(input.broker, JSON.parse(line)))}\n`)
            } catch (error) {
                socket.end(`${JSON.stringify(failure(error))}\n`)
            }
        })
    })
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(input.socketPath, resolve)
    })
    await chmod(input.socketPath, 0o660)
    if (!input.allowNonRootForTests) await chown(input.socketPath, 0, input.socketGid)
    const sweep = setInterval(() => {
        void input.broker.sweepIdle().catch((error) => {
            const message = error instanceof Error ? error.message : String(error)
            process.stderr.write(`[browser-session-broker] idle sweep failed: ${message}\n`)
        })
    }, 30 * 60 * 1000)
    sweep.unref()

    return {
        stop: async () => {
            clearInterval(sweep)
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
            await unlink(input.socketPath).catch(() => undefined)
        },
    }
}
