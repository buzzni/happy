import { readdir, readFile } from 'node:fs/promises'
import { viewerProcessMatchesLease } from './remoteViewer'

type ProcessDescription = { pid: number; cmdline: string }

function args(cmdline: string): string[] {
    return cmdline.split('\0').filter(Boolean)
}

export function selectLegacyBrowserViewerPids(
    processes: ProcessDescription[],
    legacyProfileDir: string,
): number[] {
    const lease = { display: ':99', vncPort: 5900, webPort: 6080 }
    const xvfb = processes.find((process) => viewerProcessMatchesLease('xvfb', process.cmdline, lease))
    const x11vnc = processes.find((process) => viewerProcessMatchesLease('x11vnc', process.cmdline, lease))
    const websockify = processes.find((process) => viewerProcessMatchesLease('websockify', process.cmdline, lease))
    const chrome = processes.find((process) => {
        const value = args(process.cmdline)
        return value.some((arg) => arg === `--user-data-dir=${legacyProfileDir}`)
            && value.some((arg) => arg === '--display=:99')
    })
    return xvfb && x11vnc && websockify && chrome
        ? [xvfb.pid, x11vnc.pid, websockify.pid, chrome.pid]
        : []
}

export async function drainLegacyBrowserViewer(legacyProfileDir: string): Promise<number[]> {
    const processes: ProcessDescription[] = []
    for (const name of await readdir('/proc')) {
        if (!/^\d+$/.test(name)) continue
        try {
            processes.push({ pid: Number(name), cmdline: await readFile(`/proc/${name}/cmdline`, 'utf8') })
        } catch {
            // Process exited during the scan.
        }
    }
    const pids = selectLegacyBrowserViewerPids(processes, legacyProfileDir)
    for (const pid of pids) {
        try { process.kill(pid, 'SIGTERM') } catch { /* already exited */ }
    }
    return pids
}
