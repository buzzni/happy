/**
 * Who opened a popup of an owned tab, from evidence only — never from timing alone, the
 * active tab or window position. The opener tab comes from CDP (openerId); a popup is the
 * agent's only when it was created during exactly one agent input on that tab (a click or
 * fill, from its first dispatched event until it returned), it was the only popup of that
 * input, the agent held the tab's input lease, and no user could have given input on the
 * profile within the user activation window. A popup created while the user held the tab is
 * the user's; anything else (page timers, a late or second popup, one that existed before a
 * restart) is unknown. Only the agent's popups close with their opener, and only while no
 * user has had input control since they appeared.
 */
import type { InputEvidence, TabId } from '../contracts'

export type PopupOpenedBy = 'agent' | 'user' | 'unknown'

/** One agent input on one owned tab and the popups created meanwhile. */
interface AgentInput {
    tabId: TabId
    popups: string[]
    ambiguous: boolean
}

interface PopupRecord {
    openedBy: PopupOpenedBy
    /** The agent input it is a candidate of, until that input returns */
    pending?: AgentInput
    userControlEpoch?: number
}

export class PopupProvenance {
    private readonly inputs = new Map<TabId, Set<AgentInput>>()
    private readonly records = new Map<string, PopupRecord>()

    /** Call right before an agent input's first page-visible event; call the result once it returned (or failed). */
    beginAgentInput(tabId: TabId): () => void {
        const input: AgentInput = { tabId, popups: [], ambiguous: false }
        const inputs = this.inputs.get(tabId) ?? new Set()
        this.inputs.set(tabId, inputs)
        inputs.add(input)
        if (inputs.size > 1) for (const each of inputs) each.ambiguous = true
        let ended = false
        return () => {
            if (ended) return
            ended = true
            inputs.delete(input)
            if (!inputs.size && this.inputs.get(tabId) === inputs) this.inputs.delete(tabId)
            const decided = !input.ambiguous && input.popups.length === 1
            for (const targetId of input.popups) {
                const record = this.records.get(targetId)
                if (record?.pending !== input) continue
                record.pending = undefined
                if (decided) record.openedBy = 'agent'
            }
        }
    }

    /** A new page target whose opener is (a frame or popup of) owned tab `tabId`. The first sighting decides. */
    popupCreated(targetId: string, tabId: TabId, evidence: InputEvidence | undefined): void {
        if (this.records.has(targetId)) return
        const inputs = [...this.inputs.get(tabId) ?? []]
        for (const input of inputs) input.popups.push(targetId)
        if (evidence?.owner === 'user') {
            this.records.set(targetId, { openedBy: 'user' })
            return
        }
        const [input] = inputs
        const candidate = inputs.length === 1 && evidence?.owner === 'agent' && !evidence.userInputRecent
        this.records.set(targetId, { openedBy: 'unknown', ...(candidate ? { pending: input, userControlEpoch: evidence.userControlEpoch } : {}) })
    }

    openedBy(targetId: string): PopupOpenedBy {
        return this.records.get(targetId)?.openedBy ?? 'unknown'
    }

    /** Whether cleaning up the opener closes this popup, given the Runtime's evidence now. */
    closesWithOpener(targetId: string, evidence: InputEvidence | undefined): boolean {
        const record = this.records.get(targetId)
        return record?.openedBy === 'agent' && !!evidence && !evidence.userInputRecent
            && evidence.userControlEpoch === record.userControlEpoch
    }

    forget(targetId: string): void {
        this.records.delete(targetId)
    }

    clear(): void {
        this.records.clear()
        this.inputs.clear()
    }
}
