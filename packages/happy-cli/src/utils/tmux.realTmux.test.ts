/**
 * spawnInTmux against a real tmux server.
 *
 * The parsing tests in tmux.test.ts mock tmux and so cannot see how tmux itself
 * reads the arguments: options after a command's positional argument are not
 * options at all, `-e NAME=value` takes the value verbatim (no shell), and
 * `new-session -t` means "join that session's group". Each test runs its own
 * server in a temporary TMUX_TMPDIR, never the user's.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { TmuxUtilities } from './tmux'

const tmuxAvailable = spawnSync('tmux', ['-V']).status === 0

async function readWhenWritten(path: string): Promise<string> {
    for (let attempt = 0; attempt < 100 && !existsSync(path); attempt++) await sleep(50)
    return readFileSync(path, 'utf8')
}

describe.skipIf(!tmuxAvailable)('spawnInTmux against a real tmux server', () => {
    let dir: string
    let saved: { TMUX_TMPDIR?: string; TMUX?: string }

    beforeEach(() => {
        // The socket lives at <dir>/tmux-<uid>/default; keep it under the ~104-byte
        // socket path limit even below macOS /private/var/folders.
        dir = realpathSync(mkdtempSync(join(tmpdir(), 'ht-')))
        saved = { TMUX_TMPDIR: process.env.TMUX_TMPDIR, TMUX: process.env.TMUX }
        process.env.TMUX_TMPDIR = dir
        // Inside a tmux client $TMUX would point every command at the user's server.
        delete process.env.TMUX
    })

    afterEach(() => {
        spawnSync('tmux', ['kill-server'], { env: process.env })
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
        rmSync(dir, { recursive: true, force: true })
    })

    function startServer(session: string): void {
        expect(spawnSync('tmux', ['new-session', '-d', '-s', session], { env: process.env }).status).toBe(0)
    }

    async function spawnReporting(tmux: TmuxUtilities, session: string, env: Record<string, string>) {
        const cwd = join(dir, 'work')
        mkdirSync(cwd)
        const report = join(dir, 'report')
        const result = await tmux.spawnInTmux(
            // The window closes when the command exits, so it reports its own name.
            [`sh -c 'pwd > ${report}.tmp; tmux display-message -p "#{window_name}" >> ${report}.tmp; env >> ${report}.tmp; mv ${report}.tmp ${report}'`],
            { sessionName: session, windowName: 'happy-window', cwd },
            { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
        )
        return { result, cwd, report: result.success ? await readWhenWritten(report) : '' }
    }

    it('runs the command in a new window of an existing session, in its cwd, and reports its pid', async () => {
        startServer('happy-existing')
        const tmux = new TmuxUtilities('happy-existing')

        const { result, cwd, report } = await spawnReporting(tmux, 'happy-existing', {})

        expect(result).toMatchObject({ success: true, sessionId: 'happy-existing:happy-window' })
        expect(result.pid).toBeGreaterThan(0)
        expect(report.split('\n').slice(0, 2)).toEqual([cwd, 'happy-window'])
    })

    it('passes environment values to the window exactly as given', async () => {
        startServer('happy-existing')
        const tmux = new TmuxUtilities('happy-existing')
        const value = 'a "quoted" $value with `ticks` and \\ backslash'

        const { result, report } = await spawnReporting(tmux, 'happy-existing', { HAPPY_TMUX_TEST_VALUE: value })

        expect(result.success).toBe(true)
        expect(report.split('\n')).toContain(`HAPPY_TMUX_TEST_VALUE=${value}`)
        expect(report.split('\n')).toContain(`PATH=${process.env.PATH ?? '/usr/bin:/bin'}`)
    })

    it('creates the named session when the server has none yet', async () => {
        startServer('someone-else')
        const tmux = new TmuxUtilities('happy-new')

        const { result } = await spawnReporting(tmux, 'happy-new', {})

        expect(result).toMatchObject({ success: true, sessionId: 'happy-new:happy-window' })
        // A session of its own, not one grouped with another.
        const sessions = spawnSync('tmux', ['list-sessions', '-F', '#{session_name} #{session_grouped}'], { env: process.env })
        expect(String(sessions.stdout).trim().split('\n').sort()).toEqual(['happy-new 0', 'someone-else 0'])
    })
})
