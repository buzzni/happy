/**
 * A failed tmux launch must not write the session environment to the log (happy PR #1185 review).
 *
 * `tmux new-window -e NAME=value` carries the whole environment as argv, and a Node spawn error
 * carries its argv as `spawnargs`. This drives a real spawn failure through `spawnInTmux` and the
 * real file logger, then reads the log file.
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { logger } from '@/ui/logger'
import { TmuxUtilities } from './tmux'

const SECRET = 'sentinel-tmux-argv-5be0c4'

describe('tmux spawn failure logging', () => {
    it('keeps the -e environment out of the log', async () => {
        const tmux = new TmuxUtilities('happy')
        // Every tmux call answers as a live server would, except new-window, which fails the way a
        // vanished binary does: a real ENOENT from child_process, `spawnargs` included.
        Object.assign(tmux, {
            runCommand: (args: string[]) => args.includes('new-window')
                ? new Promise((_resolve, reject) => {
                    const child = spawn('/nonexistent/happy-test-tmux', args.slice(1), { stdio: 'ignore' })
                    child.on('error', reject)
                })
                : Promise.resolve({ exitCode: 0, stdout: args.includes('list-sessions') ? 'happy\n' : '', stderr: '' }),
        })
        const before = (() => { try { return readFileSync(logger.getLogPath(), 'utf8').length } catch { return 0 } })()

        const result = await tmux.spawnInTmux(['happy', 'claude'], { sessionName: 'happy', windowName: 'w' }, { TOKEN_LIKE_VALUE: SECRET, HAPPY_INITIAL_X: `{"k":"${SECRET}"}` })

        expect(result.success).toBe(false)
        const written = readFileSync(logger.getLogPath(), 'utf8').slice(before)
        expect(written).toContain('[TMUX] Command execution failed')
        expect(written).toContain('ENOENT')
        expect(written).not.toContain(SECRET)
    })
})
