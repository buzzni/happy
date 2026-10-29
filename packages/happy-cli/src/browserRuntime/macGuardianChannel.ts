import { randomBytes } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import type { SessionOwner } from './sessionRegistration'

/** Only the signed root guardian's inherited streams enter here. A fresh nonce
 * makes buffered launch data insufficient to prove the current child lifetime. */
export function macGuardianChannel(input: Writable, output: Readable, exited: Promise<unknown>, uid: number, timeoutMs = 3000) {
    let failed = false, buffer = '', launched = false
    let launchResolve!: (pid: number) => void, launchReject!: (error: Error) => void
    let pending: { nonce: string; resolve: (row: { owner: SessionOwner; identity: string }) => void; reject: (error: Error) => void; owner: SessionOwner; timer: ReturnType<typeof setTimeout> } | undefined
    const error = () => new Error('NATIVE_GUARDIAN_UNAVAILABLE')
    const launch = new Promise<number>((resolve, reject) => { launchResolve = resolve; launchReject = reject })
    const launchTimer = setTimeout(() => fail(), timeoutMs)
    function fail() {
        if (failed) return
        failed = true; clearTimeout(launchTimer)
        launchReject(error())
        if (pending) { clearTimeout(pending.timer); pending.reject(error()); pending = undefined }
        input.destroy()
    }
    output.on('data', chunk => {
        if (failed) return
        buffer += chunk.toString('utf8')
        if (Buffer.byteLength(buffer) > 1024) { fail(); return }
        while (buffer.includes('\n')) {
            const index = buffer.indexOf('\n'), line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
            try {
                const row = JSON.parse(line)
                if (!row || row.version !== 1 || row.uid !== uid || !Number.isSafeInteger(row.pid) || row.pid <= 0) throw error()
                if (!launched) {
                    if (Object.keys(row).sort().join(',') !== 'pid,uid,version') throw error()
                    launched = true; clearTimeout(launchTimer); launchResolve(row.pid)
                } else {
                    if (!pending || Object.keys(row).sort().join(',') !== 'nonce,pid,startedAt,uid,version' ||
                        row.nonce !== pending.nonce || row.pid !== pending.owner.pid || typeof row.startedAt !== 'string' || !/^[1-9][0-9]*$/.test(row.startedAt)) throw error()
                    const request = pending; pending = undefined; clearTimeout(request.timer)
                    request.resolve({ owner: { ...request.owner, pidStartTime: row.startedAt }, identity: String(row.uid) })
                }
            } catch { fail(); return }
        }
    })
    input.on('error', fail); output.on('error', fail); output.on('end', fail)
    void exited.then(fail, fail)
    return { launch,
        probe(owner: SessionOwner): Promise<{ owner: SessionOwner; identity: string }> {
            if (failed || !launched || pending) return Promise.reject(error())
            return new Promise((resolve, reject) => {
                const nonce = randomBytes(32).toString('hex'), timer = setTimeout(fail, timeoutMs)
                pending = { nonce, resolve, reject, owner: { ...owner }, timer }
                input.write(`${nonce}\n`, writeError => { if (writeError) fail() })
            })
        },
    }
}
