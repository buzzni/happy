/**
 * Popup provenance rules (no browser): a popup counts as the agent's only with every piece
 * of evidence, and only such a popup closes with its opener. Everything else is preserved.
 */
import { describe, expect, it } from 'vitest'
import type { InputEvidence, TabId } from '../contracts'
import { PopupProvenance } from './popupProvenance'

const tab = 'tab-1' as TabId
const other = 'tab-2' as TabId
const agent: InputEvidence = { owner: 'agent', userInputRecent: false, userControlEpoch: 3 }
const quiet: InputEvidence = { owner: 'none', userInputRecent: false, userControlEpoch: 3 }

describe('popup provenance', () => {
    it('attributes the one popup created during an agent input under the agent lease to the agent, and closes it with its opener', () => {
        const p = new PopupProvenance()
        const end = p.beginAgentInput(tab)
        p.popupCreated('t1', tab, agent)
        // Undecided until the input has returned: another popup could still make it ambiguous.
        expect(p.openedBy('t1')).toBe('unknown')
        end()
        expect(p.openedBy('t1')).toBe('agent')
        expect(p.closesWithOpener('t1', quiet)).toBe(true)
    })

    it('keeps a popup created outside any agent input unknown, even under the agent lease', () => {
        const p = new PopupProvenance()
        p.popupCreated('late', tab, agent)
        expect(p.openedBy('late')).toBe('unknown')
        expect(p.closesWithOpener('late', quiet)).toBe(false)
    })

    it('makes every popup of one agent input unknown when more than one appeared', () => {
        const p = new PopupProvenance()
        const end = p.beginAgentInput(tab)
        p.popupCreated('first', tab, agent)
        p.popupCreated('second', tab, agent)
        end()
        expect([p.openedBy('first'), p.openedBy('second')]).toEqual(['unknown', 'unknown'])
    })

    it('makes popups unknown when two agent inputs overlap on one tab', () => {
        const p = new PopupProvenance()
        const endA = p.beginAgentInput(tab)
        const endB = p.beginAgentInput(tab)
        p.popupCreated('t1', tab, agent)
        endA()
        endB()
        expect(p.openedBy('t1')).toBe('unknown')
    })

    it('attributes simultaneous popups of two tabs to their own openers, not to each other', () => {
        const p = new PopupProvenance()
        const end = p.beginAgentInput(tab)
        // The other tab has no agent input: a page of its own opened this one.
        p.popupCreated('theirs', other, { ...quiet })
        p.popupCreated('mine', tab, agent)
        end()
        expect(p.openedBy('mine')).toBe('agent')
        expect(p.openedBy('theirs')).toBe('unknown')
        expect(p.closesWithOpener('theirs', quiet)).toBe(false)
    })

    it('attributes a popup created while the user holds the opener to the user, and never closes it', () => {
        const p = new PopupProvenance()
        p.popupCreated('u1', tab, { owner: 'user', userInputRecent: true, userControlEpoch: 4 })
        expect(p.openedBy('u1')).toBe('user')
        expect(p.closesWithOpener('u1', quiet)).toBe(false)
    })

    it('keeps a popup unknown when user input was recent, even during an agent input under the agent lease', () => {
        const p = new PopupProvenance()
        const end = p.beginAgentInput(tab)
        p.popupCreated('t1', tab, { ...agent, userInputRecent: true })
        end()
        expect(p.openedBy('t1')).toBe('unknown')
    })

    it('keeps a popup unknown without input evidence or without the agent lease', () => {
        const p = new PopupProvenance()
        const end = p.beginAgentInput(tab)
        p.popupCreated('none', tab, undefined)
        end()
        const end2 = p.beginAgentInput(other)
        p.popupCreated('unleased', other, quiet)
        end2()
        expect([p.openedBy('none'), p.openedBy('unleased')]).toEqual(['unknown', 'unknown'])
    })

    it('keeps the first verdict when the same popup is seen again', () => {
        const p = new PopupProvenance()
        const end = p.beginAgentInput(tab)
        p.popupCreated('t1', tab, agent)
        end()
        p.popupCreated('t1', tab, { owner: 'user', userInputRecent: true, userControlEpoch: 4 })
        expect(p.openedBy('t1')).toBe('agent')
    })

    it('preserves an agent popup once a user may have used it (control since, or now)', () => {
        const p = new PopupProvenance()
        const end = p.beginAgentInput(tab)
        p.popupCreated('t1', tab, agent)
        end()
        expect(p.closesWithOpener('t1', { ...quiet, userControlEpoch: 4 })).toBe(false)
        expect(p.closesWithOpener('t1', { ...quiet, userInputRecent: true })).toBe(false)
        expect(p.closesWithOpener('t1', undefined)).toBe(false)
        expect(p.openedBy('t1')).toBe('agent')
    })

    it('forgets everything on clear (a connection gap) without disturbing an input that starts afterwards', () => {
        const p = new PopupProvenance()
        const endOld = p.beginAgentInput(tab)
        p.popupCreated('old', tab, agent)
        p.clear()
        const endNew = p.beginAgentInput(tab)
        endOld()
        p.popupCreated('new', tab, agent)
        endNew()
        expect([p.openedBy('old'), p.openedBy('new')]).toEqual(['unknown', 'agent'])
    })

    it('knows nothing about a popup it did not see created (after a restart) and forgets one that is gone', () => {
        const p = new PopupProvenance()
        expect(p.openedBy('before-restart')).toBe('unknown')
        expect(p.closesWithOpener('before-restart', quiet)).toBe(false)
        const end = p.beginAgentInput(tab)
        p.popupCreated('t1', tab, agent)
        end()
        p.forget('t1')
        expect(p.openedBy('t1')).toBe('unknown')
    })
})
