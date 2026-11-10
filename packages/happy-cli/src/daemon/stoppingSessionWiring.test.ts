/**
 * 2026-11-10 incident — a session the daemon is stopping must not be adopted back. run.ts is one
 * large closure, so the wiring is checked in source (the adoption rule itself is unit-tested in
 * orphanAdoption.test.ts).
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

function runSource(): Promise<string> {
    return readFile(fileURLToPath(new URL('./run.ts', import.meta.url)), 'utf8')
}

function body(source: string, start: string, end: string): string {
    const from = source.indexOf(start)
    expect(from).toBeGreaterThan(-1)
    return source.slice(from, source.indexOf(end, from + start.length))
}

describe('stopping session wiring', () => {
    it('lets orphan adoption see the sessions this daemon is stopping', async () => {
        const adopt = body(await runSource(), 'const adoptOrphanSession = ', 'const onHappySessionRuntime = ')
        expect(adopt).toContain('stoppedPidOwner: (pid) => pidToStoppedSessionId.get(pid),')
    })

    it('marks a session as stopping only when its SIGTERM actually went out', async () => {
        const stop = body(await runSource(), 'let signalSent = false;', 'pidToTrackedSession.delete(pid);')
        expect(stop).toContain("signalSent = session.childProcess.kill('SIGTERM');")
        expect(body(stop, "process.kill(pid, 'SIGTERM');", '} catch')).toContain('signalSent = true;')
        expect(stop).toContain('if (signalSent && session.happySessionId) pidToStoppedSessionId.set(pid, session.happySessionId);')
    })

    it('forgets the marker once the process is gone', async () => {
        const source = await runSource()
        expect(body(source, 'const onChildExited = ', 'persistTrackedSessions();')).toContain('pidToStoppedSessionId.delete(pid);')
        expect(source).toContain('if (!isPidAlive(pid)) pidToStoppedSessionId.delete(pid);')
    })
})
