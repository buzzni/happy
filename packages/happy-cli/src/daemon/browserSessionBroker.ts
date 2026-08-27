import { appendFile, mkdir, open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserSessionBrokerLease } from './browserSessionBrokerContract'

type Runtime = {
    ensure(viewerKey: string, bridgeToken: string): Promise<{ webPort: number; profileVolume: string }>
    lookup(viewerKey: string): Promise<{ webPort: number; profileVolume: string } | null>
    stop(viewerKey: string): Promise<boolean>
    listManaged(): Promise<Array<{ viewerKey: string }>>
    migrateLegacyProfile(viewerKey: string, legacyProfileDir: string): Promise<void>
    profileBytes(viewerKey: string): Promise<number>
}

export class BrowserSessionBroker {
    private readonly leases = new Map<string, BrowserSessionBrokerLease>()
    private readonly starting = new Map<string, Promise<BrowserSessionBrokerLease>>()
    private readonly migrations = new Map<string, Promise<boolean>>()
    private readonly now: () => number
    private readonly idleTtlMs: number
    private readonly stateDir: string | null
    private starts = 0
    private stops = 0
    private capacityRejections = 0
    private quotaStops = 0

    constructor(private readonly options: {
        runtime: Runtime
        maxActive: number
        idleTtlMs?: number
        now?: () => number
        stateDir?: string
        legacyProfileDir?: string
        maxProfileBytes?: number
    }) {
        if (!Number.isInteger(options.maxActive) || options.maxActive <= 0) throw new Error('maxActive must be positive')
        this.now = options.now ?? Date.now
        this.idleTtlMs = options.idleTtlMs ?? 12 * 60 * 60 * 1000
        this.stateDir = options.stateDir ?? null
    }

    async ensure(viewerKey: string, bridgeToken: string): Promise<BrowserSessionBrokerLease> {
        const current = this.leases.get(viewerKey)
        if (current) {
            const runtime = await this.options.runtime.lookup(viewerKey)
            if (runtime) {
                const touched = { ...current, ...runtime, lastUsedAt: this.now() }
                this.leases.set(viewerKey, touched)
                return touched
            }
            this.leases.delete(viewerKey)
        }
        const inFlight = this.starting.get(viewerKey)
        if (inFlight) return inFlight
        if (this.leases.size + this.starting.size >= this.options.maxActive) {
            this.capacityRejections += 1
            await this.audit('capacity-rejected', viewerKey, false)
            throw new Error('viewer-capacity-exhausted')
        }
        const start = this.start(viewerKey, bridgeToken)
        this.starting.set(viewerKey, start)
        try {
            return await start
        } finally {
            if (this.starting.get(viewerKey) === start) this.starting.delete(viewerKey)
        }
    }

    async lookup(viewerKey: string): Promise<BrowserSessionBrokerLease | null> {
        const lease = this.leases.get(viewerKey) ?? null
        if (!lease) return null
        const runtime = await this.options.runtime.lookup(viewerKey)
        if (!runtime) {
            this.leases.delete(viewerKey)
            return null
        }
        const touched = { ...lease, ...runtime, lastUsedAt: this.now() }
        this.leases.set(viewerKey, touched)
        return touched
    }

    async touch(viewerKey: string): Promise<BrowserSessionBrokerLease | null> {
        const lease = this.leases.get(viewerKey)
        if (!lease) return null
        const touched = { ...lease, lastUsedAt: this.now() }
        this.leases.set(viewerKey, touched)
        return touched
    }

    async touchWebPort(webPort: number): Promise<BrowserSessionBrokerLease | null> {
        const lease = [...this.leases.values()].find((candidate) => candidate.webPort === webPort)
        return lease ? this.touch(lease.viewerKey) : null
    }

    async stop(viewerKey: string, reason = 'explicit'): Promise<boolean> {
        await this.starting.get(viewerKey)?.catch(() => undefined)
        const stopped = await this.options.runtime.stop(viewerKey)
        this.leases.delete(viewerKey)
        if (stopped) this.stops += 1
        await this.audit(`stop:${reason}`, viewerKey, stopped)
        return stopped
    }

    async sweepIdle(): Promise<string[]> {
        const deadline = this.now() - this.idleTtlMs
        const idle = [...this.leases.values()]
            .filter((lease) => lease.lastUsedAt <= deadline)
            .map((lease) => lease.viewerKey)
        const stopped = new Set<string>()
        let firstError: unknown = null
        for (const viewerKey of idle) {
            try {
                await this.stop(viewerKey, 'idle')
                stopped.add(viewerKey)
            } catch (error) {
                firstError ??= error
            }
        }
        if (this.options.maxProfileBytes !== undefined) {
            for (const lease of [...this.leases.values()]) {
                try {
                    if (await this.options.runtime.profileBytes(lease.viewerKey) <= this.options.maxProfileBytes) continue
                    await this.stop(lease.viewerKey, 'profile-quota')
                    this.quotaStops += 1
                    stopped.add(lease.viewerKey)
                } catch (error) {
                    firstError ??= error
                }
            }
        }
        if (firstError) throw firstError
        return [...stopped]
    }

    async reconcile(): Promise<void> {
        for (const { viewerKey } of await this.options.runtime.listManaged()) {
            const runtime = await this.options.runtime.lookup(viewerKey)
            if (!runtime) continue
            this.leases.set(viewerKey, {
                viewerKey,
                ...runtime,
                ready: true,
                lastUsedAt: this.now(),
                isolation: 'container',
            })
        }
    }

    migrateLegacy(viewerKey: string): Promise<boolean> {
        const current = this.migrations.get(viewerKey)
        if (current) return current
        const migration = this.migrateLegacyOnce(viewerKey)
        this.migrations.set(viewerKey, migration)
        const clear = () => {
            if (this.migrations.get(viewerKey) === migration) this.migrations.delete(viewerKey)
        }
        migration.then(clear, clear)
        return migration
    }

    private async migrateLegacyOnce(viewerKey: string): Promise<boolean> {
        if (!this.stateDir || !this.options.legacyProfileDir) throw new Error('legacy-migration-not-configured')
        await mkdir(join(this.stateDir, 'migrations'), { recursive: true, mode: 0o700 })
        const marker = join(this.stateDir, 'migrations', `${viewerKey}.done`)
        try {
            await readFile(marker)
            throw new Error('legacy-profile-already-migrated')
        } catch (error) {
            if (error instanceof Error && error.message === 'legacy-profile-already-migrated') throw error
        }
        await this.options.runtime.migrateLegacyProfile(viewerKey, this.options.legacyProfileDir)
        const handle = await open(marker, 'wx', 0o600)
        await handle.writeFile(`${this.now()}\n`)
        await handle.close()
        await this.audit('migrate-legacy', viewerKey, true)
        return true
    }

    metrics(): { active: number; starts: number; stops: number; capacityRejections: number; quotaStops: number } {
        return {
            active: this.leases.size,
            starts: this.starts,
            stops: this.stops,
            capacityRejections: this.capacityRejections,
            quotaStops: this.quotaStops,
        }
    }

    private async audit(action: string, viewerKey: string, ok: boolean): Promise<void> {
        if (!this.stateDir) return
        await mkdir(this.stateDir, { recursive: true, mode: 0o700 })
        await appendFile(join(this.stateDir, 'audit.jsonl'), `${JSON.stringify({
            time: this.now(), action, viewerKey, ok,
        })}\n`, { encoding: 'utf8', mode: 0o600 })
    }

    private async start(viewerKey: string, bridgeToken: string): Promise<BrowserSessionBrokerLease> {
        try {
            const runtime = await this.options.runtime.ensure(viewerKey, bridgeToken)
            const lease: BrowserSessionBrokerLease = {
                viewerKey,
                webPort: runtime.webPort,
                profileVolume: runtime.profileVolume,
                ready: true,
                lastUsedAt: this.now(),
                isolation: 'container',
            }
            this.leases.set(viewerKey, lease)
            this.starts += 1
            await this.audit('ensure', viewerKey, true)
            return lease
        } catch (error) {
            await this.audit('ensure', viewerKey, false)
            throw error
        }
    }
}
