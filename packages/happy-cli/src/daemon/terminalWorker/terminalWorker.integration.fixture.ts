/**
 * A stand-in daemon for `terminalWorker.integration.test.ts` (spec HR9): the real direct terminal
 * route and terminal worker host in their own process, against a temporary HAPPY_HOME_DIR and a
 * fixed machine key. Workers are the built `happy terminal-worker`.
 *
 * Env: HAPPY_HOME_DIR, FIXTURE_KEY (base64 machine key), FIXTURE_WORKERS ('0' = off).
 * Writes `fixture-<pid>.port` once listening.
 * Signals: SIGTERM = stop (terminals close), SIGUSR2 = restart keeping terminals, SIGKILL = crash.
 */
import { appendFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { decodeBase64 } from '@/api/encryption'
import { attachTerminalWsRoute } from '../controlServerTerminalWs'
import { TerminalWorkerHost } from './workerHost'

const home = process.env.HAPPY_HOME_DIR!
const encryptionKey = decodeBase64(process.env.FIXTURE_KEY!)
const log = (message: string) => appendFileSync(join(home, 'fixture.log'), `[${process.pid}] ${message}\n`)

async function main() {
    const server = createServer()
    const host = new TerminalWorkerHost({
        happyHome: home,
        enabled: process.env.FIXTURE_WORKERS !== '0',
        log,
    })
    const route = attachTerminalWsRoute(server, {
        path: '/terminal',
        controlSecret: 'fixture-secret',
        allowedRoot: homedir(),
        getMachineEncryption: () => ({ encryptionKey, encryptionVariant: 'legacy' }),
        detachGraceMs: 30_000,
        terminalWorkers: host,
    })
    route.adopt(await host.start())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port

    const leave = async (keep: boolean) => {
        log(keep ? 'restart (keep)' : 'stop')
        host.setKeeping(keep)
        await route.close()
        await host.stop()
        server.close()
        process.exit(0)
    }
    process.on('SIGTERM', () => { void leave(false) })
    process.on('SIGUSR2', () => { void leave(true) })

    const file = join(home, `fixture-${process.pid}.port`)
    writeFileSync(`${file}.tmp`, String(port))
    renameSync(`${file}.tmp`, file)
    log(`listening ${port}`)
}

main().catch((error) => {
    log(`failed: ${error instanceof Error ? error.stack : String(error)}`)
    process.exit(1)
})
