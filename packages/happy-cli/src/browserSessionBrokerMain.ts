import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { BrowserContainerRuntime } from './daemon/browserContainerRuntime'
import { BrowserSessionBroker } from './daemon/browserSessionBroker'
import { startBrowserSessionBrokerServer } from './daemon/browserSessionBrokerServer'
import { drainLegacyBrowserViewer } from './daemon/legacyBrowserViewerDrain'

async function main(): Promise<void> {
    const socketPath = process.env.HAPPY_BROWSER_BROKER_SOCKET ?? '/run/happy-browser/broker.sock'
    const stateDir = process.env.HAPPY_BROWSER_BROKER_STATE_DIR ?? '/var/lib/happy-browser'
    const image = process.env.HAPPY_BROWSER_CONTAINER_IMAGE ?? ''
    const socketGid = Number(process.env.HAPPY_BROWSER_BROKER_GID)
    const maxActive = Number(process.env.HAPPY_BROWSER_MAX_ACTIVE ?? '3')
    const idleTtlMs = Number(process.env.HAPPY_BROWSER_IDLE_TTL_MS ?? String(12 * 60 * 60 * 1000))
    const maxProfileBytes = Number(process.env.HAPPY_BROWSER_MAX_PROFILE_BYTES ?? String(5 * 1024 * 1024 * 1024))

    if (!Number.isInteger(socketGid) || socketGid < 0) throw new Error('HAPPY_BROWSER_BROKER_GID is required')

    const broker = new BrowserSessionBroker({
        runtime: new BrowserContainerRuntime({ image }),
        maxActive,
        idleTtlMs,
        stateDir,
        legacyProfileDir: process.env.HAPPY_BROWSER_LEGACY_PROFILE_DIR,
        maxProfileBytes,
    })

    const server = await startBrowserSessionBrokerServer({ broker, socketPath, socketGid })
    await mkdir(stateDir, { recursive: true, mode: 0o700 })
    if (process.env.HAPPY_BROWSER_DRAIN_LEGACY_ON_START === '1') {
        const legacyProfileDir = process.env.HAPPY_BROWSER_LEGACY_PROFILE_DIR
        if (!legacyProfileDir) throw new Error('HAPPY_BROWSER_LEGACY_PROFILE_DIR is required to drain legacy viewer')
        const pids = await drainLegacyBrowserViewer(legacyProfileDir)
        await appendFile(join(stateDir, 'audit.jsonl'), `${JSON.stringify({
            time: Date.now(), action: 'drain-legacy', pids, ok: pids.length > 0,
        })}\n`, { encoding: 'utf8', mode: 0o600 })
    }
    await appendFile(join(stateDir, 'audit.jsonl'), `${JSON.stringify({
        time: Date.now(), action: 'broker-start', ok: true,
    })}\n`, { encoding: 'utf8', mode: 0o600 })

    const shutdown = async () => {
        await server.stop()
        process.exit(0)
    }
    process.once('SIGTERM', () => void shutdown())
    process.once('SIGINT', () => void shutdown())
}

void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
})
