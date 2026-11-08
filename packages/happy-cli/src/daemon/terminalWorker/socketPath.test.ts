import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveTerminalWorkerSocketPath, TerminalWorkerSocketPathError } from './socketPath'

const posix = process.platform !== 'win32'
const recordId = '0123abcd-4567-89ef-0123-456789abcdef'

describe.runIf(posix)('terminal worker socket path', () => {
    let root: string
    // /tmp, not os.tmpdir(): macOS's per-user tmpdir alone eats half the 103-byte budget.
    beforeEach(() => { root = mkdtempSync('/tmp/tws-') })
    afterEach(() => { rmSync(root, { recursive: true, force: true }) })

    it('puts the socket under the happy home when it fits', () => {
        const path = resolveTerminalWorkerSocketPath({ happyHome: join(root, 'h'), recordId, platform: 'darwin', tmpDir: root })
        expect(path).toBe(join(root, 'h', 'terminal-workers', 's', 'tw-0123abcd456789ef.sock'))
    })

    it('falls back to an owner-only directory under tmp when the home path is over budget', () => {
        const happyHome = join(root, 'x'.repeat(120))
        const path = resolveTerminalWorkerSocketPath({ happyHome, recordId, platform: 'darwin', tmpDir: root })
        expect(path).toBe(join(root, `happy-${process.getuid!()}`, 'tw-0123abcd456789ef.sock'))
    })

    it('never chmods a shared-root directory with the wrong mode; skips it instead', () => {
        const happyHome = join(root, 'x'.repeat(120))
        const shared = join(root, `happy-${process.getuid!()}`)
        mkdirSync(shared)
        chmodSync(shared, 0o755)
        let result: string | TerminalWorkerSocketPathError
        try {
            result = resolveTerminalWorkerSocketPath({ happyHome, recordId, platform: 'darwin', tmpDir: root })
        } catch (error) {
            result = error as TerminalWorkerSocketPathError
        }
        if (typeof result === 'string') expect(result.startsWith(shared)).toBe(false)
        else expect(result.rejected.map((entry) => entry.reason)).toContain('has mode 755')
        expect(statSync(shared).mode & 0o777).toBe(0o755)
    })
})
