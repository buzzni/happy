import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { VIEWER_SLOTS, validateViewerKey } from './remoteViewer'

export type BrowserViewerLeaseRecord = {
    viewerKey: string
    slot: number
    display: string
    vncPort: number
    webPort: number
    cdpPort: number | null
    profileDir: string
    lastUsedAt: number
    processIds?: {
        xvfb?: number
        x11vnc?: number
        websockify?: number
    }
}

type StateFile = {
    version: 1
    leases: BrowserViewerLeaseRecord[]
}

function readLease(value: unknown, browserViewersDir: string): BrowserViewerLeaseRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const input = value as Partial<BrowserViewerLeaseRecord>
    if (typeof input.viewerKey !== 'string' || !validateViewerKey(input.viewerKey)) return null
    if (!Number.isInteger(input.slot)) return null
    const slot = VIEWER_SLOTS.find((candidate) => candidate.slot === input.slot)
    if (!slot) return null
    if (
        input.display !== slot.display
        || input.vncPort !== slot.vncPort
        || input.webPort !== slot.webPort
    ) return null
    if (input.cdpPort !== null && !Number.isInteger(input.cdpPort)) return null
    if (input.profileDir !== join(browserViewersDir, input.viewerKey, 'chrome-profile')) return null
    if (!Number.isFinite(input.lastUsedAt)) return null
    if (
        input.processIds !== undefined
        && (
            !input.processIds
            || typeof input.processIds !== 'object'
            || Object.values(input.processIds).some((pid) => !Number.isInteger(pid) || pid <= 0)
        )
    ) return null
    return input as BrowserViewerLeaseRecord
}

async function readState(filePath: string): Promise<BrowserViewerLeaseRecord[]> {
    try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8')) as Partial<StateFile>
        if (parsed.version !== 1 || !Array.isArray(parsed.leases)) return []
        return parsed.leases
            .map((lease) => readLease(lease, dirname(filePath)))
            .filter((lease): lease is BrowserViewerLeaseRecord => lease !== null)
            .sort((a, b) => a.slot - b.slot)
    } catch {
        return []
    }
}

async function writeState(filePath: string, leases: BrowserViewerLeaseRecord[]): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
    const tempPath = `${filePath}.${randomUUID()}.tmp`
    try {
        await writeFile(tempPath, `${JSON.stringify({ version: 1, leases }, null, 2)}\n`, {
            encoding: 'utf8',
            mode: 0o600,
        })
        await rename(tempPath, filePath)
    } catch (error) {
        await unlink(tempPath).catch(() => undefined)
        throw error
    }
}

export class BrowserViewerLeaseRegistry {
    private mutation: Promise<void> = Promise.resolve()

    constructor(private readonly filePath: string) {}

    async list(): Promise<BrowserViewerLeaseRecord[]> {
        await this.mutation
        return readState(this.filePath)
    }

    async get(viewerKey: string): Promise<BrowserViewerLeaseRecord | null> {
        return (await this.list()).find((lease) => lease.viewerKey === viewerKey) ?? null
    }

    set(lease: BrowserViewerLeaseRecord): Promise<void> {
        return this.mutate(async (leases) => {
            const next = leases.filter((current) => current.viewerKey !== lease.viewerKey)
            next.push(lease)
            return next.sort((a, b) => a.slot - b.slot)
        })
    }

    async delete(viewerKey: string): Promise<boolean> {
        let deleted = false
        await this.mutate(async (leases) => {
            const next = leases.filter((lease) => lease.viewerKey !== viewerKey)
            deleted = next.length !== leases.length
            return next
        })
        return deleted
    }

    private mutate(
        change: (leases: BrowserViewerLeaseRecord[]) => Promise<BrowserViewerLeaseRecord[]>,
    ): Promise<void> {
        const operation = this.mutation.then(async () => {
            const next = await change(await readState(this.filePath))
            await writeState(this.filePath, next)
        })
        this.mutation = operation.catch(() => undefined)
        return operation
    }
}
