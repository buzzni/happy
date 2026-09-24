import { BrowserRuntimeError, type InputOwner, type ProfileId, type TabId, type TaskId } from './contracts'

interface TabLease { owner: InputOwner; epoch: number; profileId: ProfileId }

/** In-memory dispatch fence. Persisted task state remains owned by TaskStore. */
export class InputLeaseManager {
    private readonly tabs = new Map<TabId, TabLease>()
    private readonly taskTabs = new Map<TaskId, Set<TabId>>()

    acquire(tabId: TabId, profileId: ProfileId, owner: Extract<InputOwner, { kind: 'agent' }>): number {
        if (this.isUserFenced(profileId)) throw new BrowserRuntimeError('STALE_LEASE', 'User input fences the whole profile')
        const lease = this.get(tabId, profileId)
        if (lease.owner.kind !== 'none' && (lease.owner.kind !== 'agent' || lease.owner.taskId !== owner.taskId || lease.owner.segmentId !== owner.segmentId)) {
            throw new BrowserRuntimeError('STALE_LEASE', 'Tab input is owned by another segment')
        }
        lease.owner = owner
        this.taskTabs.set(owner.taskId, (this.taskTabs.get(owner.taskId) ?? new Set()).add(tabId))
        return lease.epoch
    }

    takeOver(tabId: TabId, profileId: ProfileId, owner: Extract<InputOwner, { kind: 'user' }>): number {
        const priorUser = [...this.tabs.values()].find((tab) => tab.profileId === profileId && tab.owner.kind === 'user')
        if (priorUser?.owner.kind === 'user' && (priorUser.owner.principalId !== owner.principalId || priorUser.owner.viewerSessionId !== owner.viewerSessionId)) throw new BrowserRuntimeError('STALE_LEASE', 'Another viewer owns profile input')
        const lease = this.get(tabId, profileId)
        lease.epoch += 1
        lease.owner = owner
        return lease.epoch
    }

    release(tabId: TabId, profileId: ProfileId): number {
        const lease = this.get(tabId, profileId)
        lease.epoch += 1
        lease.owner = { kind: 'none' }
        return lease.epoch
    }

    assert(tabId: TabId, profileId: ProfileId, taskId: TaskId, segmentId: string, epoch: number): void {
        const lease = this.get(tabId, profileId)
        if (lease.owner.kind !== 'agent' || lease.owner.taskId !== taskId || lease.owner.segmentId !== segmentId || lease.epoch !== epoch) {
            throw new BrowserRuntimeError('STALE_LEASE', 'Input lease changed before dispatch')
        }
    }

    revokeTask(taskId: TaskId): void {
        for (const tabId of this.taskTabs.get(taskId) ?? []) {
            const lease = this.tabs.get(tabId)
            if (lease?.owner.kind === 'agent' && lease.owner.taskId === taskId) this.release(tabId, lease.profileId)
        }
        this.taskTabs.delete(taskId)
    }

    owner(tabId: TabId, profileId: ProfileId): { owner: InputOwner; leaseEpoch: number } {
        const { owner, epoch } = this.get(tabId, profileId)
        return { owner: structuredClone(owner), leaseEpoch: epoch }
    }

    isUserFenced(profileId: ProfileId): boolean {
        return [...this.tabs.values()].some((tab) => tab.profileId === profileId && tab.owner.kind === 'user')
    }

    private get(tabId: TabId, profileId: ProfileId): TabLease {
        let lease = this.tabs.get(tabId)
        if (!lease) {
            lease = { owner: { kind: 'none' }, epoch: 0, profileId }
            this.tabs.set(tabId, lease)
        }
        if (lease.profileId !== profileId) throw new BrowserRuntimeError('SCOPE_DENIED', 'Tab profile mismatch')
        return lease
    }
}
