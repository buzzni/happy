/**
 * Production start with the installed permissions (D11).
 *
 * The installer keeps /etc/abp/runtime.json root 0600 and /run/abp
 * root:abp-session 0750, so the Runtime container starts as root holding only
 * CAP_SETUID and CAP_SETGID:
 *
 *   docker run --user 0:0 --cap-drop ALL --cap-add SETUID --cap-add SETGID
 *              --security-opt no-new-privileges ...
 *
 * As root it only reads the config (root owns it, so no DAC override is
 * needed) and binds the broker and admin sockets in /run/abp (root owns the
 * directory). The broker socket gets its group by membership, not CAP_CHOWN.
 * It then drops to the image's runtime uid/gid before it opens the state
 * volume or any browser; the kernel clears every capability on that setuid,
 * and the Runtime refuses to continue if any is left.
 */
import { readFile } from 'node:fs/promises'

export interface RuntimeIdentity { uid: number; gid: number }

function positiveId(value: string | undefined): number | undefined {
    return value && /^[1-9]\d*$/.test(value) ? Number(value) : undefined
}

/** The unprivileged identity the image declares (ABP_RUNTIME_UID/GID); never root. */
export function runtimeIdentity(env: NodeJS.ProcessEnv): RuntimeIdentity {
    const uid = positiveId(env.ABP_RUNTIME_UID)
    const gid = positiveId(env.ABP_RUNTIME_GID)
    if (uid === undefined || gid === undefined) throw new Error('ABP_RUNTIME_UID and ABP_RUNTIME_GID must name a non-root runtime user')
    return { uid, gid }
}

/** True when /proc/<pid>/status shows no permitted, effective or ambient capability. */
export function capabilitiesCleared(procStatus: string): boolean {
    const sets = ['CapPrm', 'CapEff', 'CapAmb'].map((name) => new RegExp(`^${name}:\\s*([0-9a-f]+)$`, 'm').exec(procStatus)?.[1])
    return sets.every((value) => value !== undefined && /^0+$/.test(value))
}

/** Join `gid` so a root-owned socket can be given that group without CAP_CHOWN. */
export function joinGroup(gid: number): void {
    process.setgroups!([gid])
}

export async function dropRoot(target: RuntimeIdentity, readStatus = () => readFile('/proc/self/status', 'utf8')): Promise<void> {
    process.setgroups!([])
    process.setgid!(target.gid)
    process.setuid!(target.uid)
    if (process.getuid!() !== target.uid || process.geteuid!() !== target.uid || process.getgid!() !== target.gid || process.getegid!() !== target.gid)
        throw new Error('ABP runtime could not drop root')
    if (!capabilitiesCleared(await readStatus())) throw new Error('ABP runtime still holds capabilities after dropping root')
}
