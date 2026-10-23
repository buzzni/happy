/**
 * aplus codexcli-daemon-restart-drain R1·R2 — which doors the restart drain closes. run.ts is one
 * large closure, so the wiring is checked in source (the gate itself is unit-tested in
 * resumeGuards.restartDrain.test.ts and end-to-end in restartDrain.integration.test.ts).
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

describe('restart drain admission wiring', () => {
    it('gates every external launch path: machine RPC spawn/resume/recover, loopback spawn, channel host', async () => {
        const source = await runSource()
        expect(source.match(/rememberSpawn\(spawnSessionAdmitted\)/g)).toHaveLength(2)
        expect(source).toContain('resumeSessionAdmitted,')
        expect(source).toContain("restartRefusal('resume') ?? admittedLaunches.track(() => recoverSession(sessionId, options))")
        // Cross review H4: an admitted launch still preparing counts as activity until it settles.
        expect(source).toContain("restartRefusal('launch') ?? admittedLaunches.track(() => spawnSession(options))")
        expect(source).toContain("restartRefusal('resume') ?? admittedLaunches.track(() => resumeSession(happySessionId, options))")
        expect(body(source, 'const getRestartDrainActivity = ', 'const handOffToInstalledBundle')).toContain(') + admittedLaunches.count(),')
        const channel = body(source, 'spawnSession: (options) => spawnSessionAdmitted(options),', 'channelHost = createChannelHostSupervisor')
        expect(channel).toContain('return await spawnSessionAdmitted(options);')
    })

    it('lets the daemon\'s own automation spawns through: an in-flight tick is what the drain waits for', async () => {
        const source = await runSource()
        const unchecked = body(source, 'const spawnSessionUnchecked = async', 'const spawnSession = async')
        expect(unchecked).not.toContain('restartDeadline')
        const automation = body(source, 'const spawnAutomationSession = async', 'const automationTickRunner = createAutomationTickRunner')
        expect(automation).toContain('await spawnSession({')
        expect(automation).not.toContain('spawnSessionAdmitted')
    })
})
