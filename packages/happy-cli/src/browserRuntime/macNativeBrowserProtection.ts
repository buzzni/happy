import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import { verifyMacServiceExecutable } from './nativeHostPrimitives'
import type { NativeBrowserSessionOptions } from './nativeBrowserSession'

const HELPER = '/Library/Application Support/SaycodeNative/bin/network-guard-status'
const REQUIREMENT = '=anchor apple generic and certificate leaf[subject.OU] = "36C77K9BJ2" and identifier "com.saycode.nativeh.networkguard.status-check"'
const integer = z.number().int().nonnegative().safe()
const replySchema = z.object({
    protects: z.literal(true),
    status: z.object({ version: z.literal(1), filterRunning: z.literal(true), browserUid: integer,
        policyEpoch: integer, policyError: z.null().optional(), startedAt: integer, browserDrops: integer,
        lastBrowserDropAt: integer.nullable().optional() }).strict(),
}).strict()
const exec = promisify(execFile)
interface GuardIO {
    platform: NodeJS.Platform
    verifyExecutable(path: string): Promise<void>
    run(path: string, args: string[]): Promise<{ stdout: string }>
}

/** Fixed, root-protected, signed helper; its XPC client verifies the filter's
 * signer and the filter authenticates the helper. The installed policy must name
 * this helper's exact signing identifier. No shell, PATH lookup or env override. */
export function createMacNativeBrowserProtection(expected: { browserUid: number; epoch: number }, io: GuardIO = {
    platform: process.platform, verifyExecutable: verifyMacServiceExecutable,
    run: (path, args) => exec(path, args, { timeout: 4000, maxBuffer: 8192, encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin', LANG: 'C' } }),
}): Exclude<NativeBrowserSessionOptions['protection'], { mode: 'basic' }> {
    const { browserUid, epoch } = expected
    if (io.platform !== 'darwin' || !Number.isSafeInteger(browserUid) || browserUid < 200 || browserUid > 0xffffffff ||
        !Number.isSafeInteger(epoch) || epoch < 1) throw new Error('NATIVE_PROTECTION_UNSUPPORTED')
    return {
        identity: String(browserUid), epoch: String(epoch),
        snapshot: async () => {
            await io.verifyExecutable(HELPER)
            await io.run('/usr/bin/codesign', ['--verify', '--strict', '-R', REQUIREMENT, HELPER])
            const { stdout } = await io.run(HELPER, [String(browserUid), String(epoch)])
            const { status } = replySchema.parse(JSON.parse(stdout))
            if (status.browserUid !== browserUid || status.policyEpoch !== epoch) throw new Error('NATIVE_PROTECTION_MISMATCH')
            return { version: 1, identity: String(browserUid), epoch: String(epoch), generation: String(status.startedAt),
                violations: String(status.browserDrops), enforcing: true }
        },
    }
}
