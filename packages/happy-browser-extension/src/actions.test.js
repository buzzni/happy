// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { collectSnapshot } from './snapshot.js'
import { clickRef, fillRef, scrollRef } from './actions.js'

function render(html) {
    document.body.innerHTML = html
    delete window.__happyRefs
}

function markScrollable(element, { scrollTop = 0, scrollLeft = 0, scrollHeight = 1000, scrollWidth = 200, clientHeight = 200, clientWidth = 200 } = {}) {
    Object.defineProperties(element, {
        scrollTop: { configurable: true, writable: true, value: scrollTop },
        scrollLeft: { configurable: true, writable: true, value: scrollLeft },
        scrollHeight: { configurable: true, value: scrollHeight },
        scrollWidth: { configurable: true, value: scrollWidth },
        clientHeight: { configurable: true, value: clientHeight },
        clientWidth: { configurable: true, value: clientWidth },
        scrollTo: {
            configurable: true,
            value: ({ left, top, behavior }) => {
                element.scrollLeft = left
                element.scrollTop = top
                element.dataset.scrollBehavior = behavior
            },
        },
    })
}

/**
 * Chrome re-evaluates `func.toString()` standalone in the page — it does
 * NOT carry along this module's other bindings. `new Function` reproduces
 * that: the result shares globals (window/document) but has no access to
 * this file's local consts/functions, same as chrome.scripting.executeScript.
 * This caught two real regressions (a factored-out `resolveRef`, then a
 * factored-out `refError`) that every other test here missed, because a
 * plain `import` + direct call keeps the closure intact and hides the bug.
 */
function detachFromModuleScope(fn) {
    return new Function(`return (${fn.toString()})`)()
}

describe('clickRef', () => {
    beforeEach(() => render(''))

    it('clicks the element behind a ref', () => {
        render('<button>Save</button>')
        collectSnapshot()
        let clicked = false
        document.querySelector('button').addEventListener('click', () => { clicked = true })
        const result = clickRef('@e1')
        expect(clicked).toBe(true)
        expect(result).toEqual({ ok: true })
    })

    // These report failure via the return value, not a thrown error — a
    // thrown error crossing chrome.scripting.executeScript's page↔extension
    // boundary was observed in real Chrome to resolve as silent success
    // instead of rejecting, so the contract here is "always returns".
    it('reports REF_NOT_FOUND when no snapshot has been taken yet', () => {
        expect(clickRef('@e1')).toMatchObject({ ok: false, code: 'REF_NOT_FOUND' })
    })

    it('reports REF_NOT_FOUND for a ref from a stale snapshot', () => {
        render('<button>One</button>')
        collectSnapshot()
        render('<button>Two</button>') // page changed; refs map still has the old element
        expect(clickRef('@e2')).toMatchObject({ ok: false, code: 'REF_NOT_FOUND' })
    })

    it('reports ELEMENT_DISABLED instead of clicking a disabled control', () => {
        render('<button disabled>Save</button>')
        collectSnapshot()
        expect(clickRef('@e1')).toMatchObject({ ok: false, code: 'ELEMENT_DISABLED' })
    })
})

describe('fillRef', () => {
    beforeEach(() => render(''))

    it('sets the value of an input and fires input/change events', () => {
        render('<input name="email">')
        collectSnapshot()
        const events = []
        const input = document.querySelector('input')
        input.addEventListener('input', () => events.push('input'))
        input.addEventListener('change', () => events.push('change'))

        const result = fillRef('@e1', 'a@b.com')

        expect(input.value).toBe('a@b.com')
        expect(events).toEqual(['input', 'change'])
        expect(result).toEqual({ ok: true, value: 'a@b.com' })
    })

    it('sets contenteditable text content', () => {
        render('<div contenteditable="true"></div>')
        collectSnapshot()
        fillRef('@e1', 'hello')
        expect(document.querySelector('div').textContent).toBe('hello')
    })

    it('reports REF_NOT_FOUND for an unknown ref', () => {
        render('<input name="email">')
        collectSnapshot()
        expect(fillRef('@e2', 'x')).toMatchObject({ ok: false, code: 'REF_NOT_FOUND' })
    })

    it('reports NOT_FILLABLE for an element that has no text value, like a button', () => {
        render('<button>Save</button>')
        collectSnapshot()
        expect(fillRef('@e1', 'x')).toMatchObject({ ok: false, code: 'NOT_FILLABLE' })
    })

    it('reports ELEMENT_DISABLED instead of filling a disabled input', () => {
        render('<input name="email" disabled>')
        collectSnapshot()
        expect(fillRef('@e1', 'x')).toMatchObject({ ok: false, code: 'ELEMENT_DISABLED' })
    })
})

describe('scrollRef', () => {
    beforeEach(() => render(''))

    it('scrolls the document when no ref is supplied', () => {
        markScrollable(document.documentElement, { scrollHeight: 1400, clientHeight: 400 })

        const result = scrollRef(null, 0, 600)

        expect(document.documentElement.scrollTop).toBe(600)
        expect(result).toMatchObject({
            ok: true,
            target: 'document',
            moved: true,
            before: { x: 0, y: 0 },
            after: { x: 0, y: 600 },
            max: { x: 0, y: 1000 },
            atBoundary: { top: false, bottom: false, left: false, right: false },
        })
    })

    it('scrolls the nearest scrollable ancestor of an interactive ref', () => {
        render('<div id="results" style="overflow-y:auto"><button>First item</button></div>')
        const results = document.getElementById('results')
        markScrollable(results)
        collectSnapshot()

        const result = scrollRef('@e1', 0, 250)

        expect(results.scrollTop).toBe(250)
        expect(result).toMatchObject({ ok: true, target: '@e1', moved: true, after: { y: 250 } })
    })

    it('supports horizontal scrolling', () => {
        render('<div id="rail" style="overflow-x:auto"><button>First card</button></div>')
        const rail = document.getElementById('rail')
        markScrollable(rail, { scrollWidth: 1000, clientWidth: 200, scrollHeight: 200, clientHeight: 200 })
        collectSnapshot()

        const result = scrollRef('@e1', 300, 0)

        expect(rail.scrollLeft).toBe(300)
        expect(result).toMatchObject({ ok: true, moved: true, after: { x: 300, y: 0 } })
    })

    it('forces instant movement when the page requests smooth scrolling', () => {
        render('<div id="results" style="overflow-y:auto;scroll-behavior:smooth"><button>First item</button></div>')
        const results = document.getElementById('results')
        markScrollable(results)
        collectSnapshot()

        const result = scrollRef('@e1', 0, 250)

        expect(results.dataset.scrollBehavior).toBe('instant')
        expect(result).toMatchObject({ ok: true, moved: true, after: { y: 250 } })
    })

    it('scrolls a script-scrollable overflow-hidden ancestor', () => {
        render('<div id="results" style="overflow-y:hidden"><button>First item</button></div>')
        const results = document.getElementById('results')
        markScrollable(results)
        collectSnapshot()

        const result = scrollRef('@e1', 0, 250)

        expect(results.scrollTop).toBe(250)
        expect(result).toMatchObject({ ok: true, moved: true, after: { y: 250 } })
    })

    it('scrolls a shadow container reached through an assigned slot', () => {
        render('<div id="host"><button slot="items">Slotted item</button></div>')
        const shadow = document.getElementById('host').attachShadow({ mode: 'open' })
        shadow.innerHTML = '<div id="results" style="overflow-y:auto"><slot name="items"></slot></div>'
        const results = shadow.getElementById('results')
        markScrollable(results)
        collectSnapshot()

        const result = scrollRef('@e1', 0, 250)

        expect(results.scrollTop).toBe(250)
        expect(result).toMatchObject({ ok: true, moved: true, after: { y: 250 } })
    })

    it('does not scroll the document for a ref inside a viewport-fixed region', () => {
        render('<div style="position:fixed"><button>Fixed action</button></div>')
        markScrollable(document.documentElement, { scrollHeight: 1200, clientHeight: 200 })
        collectSnapshot()

        const result = scrollRef('@e1', 0, 250)

        expect(document.documentElement.scrollTop).toBe(0)
        expect(result).toMatchObject({ ok: false, code: 'NOT_SCROLLABLE' })
    })

    it('scrolls the containing block of a fixed ref when one exists', () => {
        render(`
            <div id="results" style="will-change:translate;overflow-y:auto">
                <div style="position:fixed"><button>Fixed result</button></div>
            </div>
        `)
        const results = document.getElementById('results')
        markScrollable(results)
        collectSnapshot()

        const result = scrollRef('@e1', 0, 250)

        expect(results.scrollTop).toBe(250)
        expect(result).toMatchObject({ ok: true, moved: true, after: { y: 250 } })
    })

    it('supports Chrome RTL horizontal coordinates and reports the left boundary', () => {
        render('<div id="rail" dir="rtl" style="overflow-x:auto"><button>First card</button></div>')
        const rail = document.getElementById('rail')
        markScrollable(rail, { scrollWidth: 1000, clientWidth: 200, scrollHeight: 200, clientHeight: 200 })
        collectSnapshot()

        const moved = scrollRef('@e1', -300, 0)

        expect(rail.scrollLeft).toBe(-300)
        expect(moved).toMatchObject({
            ok: true,
            moved: true,
            after: { x: -300, y: 0 },
            atBoundary: { left: false, right: false },
        })

        const boundary = scrollRef('@e1', -600, 0)
        expect(boundary).toMatchObject({
            ok: true,
            moved: true,
            after: { x: -800, y: 0 },
            atBoundary: { left: true, right: false },
        })
    })

    it('reports a boundary instead of claiming movement', () => {
        render('<div id="results" style="overflow-y:auto"><button>Last item</button></div>')
        const results = document.getElementById('results')
        markScrollable(results, { scrollTop: 800 })
        collectSnapshot()

        expect(scrollRef('@e1', 0, 300)).toMatchObject({
            ok: true,
            moved: false,
            after: { y: 800 },
            atBoundary: { top: false, bottom: true, left: false, right: false },
        })
    })

    it('reports REF_NOT_FOUND for a stale scroll target', () => {
        render('<div id="results" style="overflow-y:auto"><button>Item</button></div>')
        markScrollable(document.getElementById('results'))
        collectSnapshot()
        render('<button>Replacement</button>')

        expect(scrollRef('@e1', 0, 200)).toMatchObject({ ok: false, code: 'REF_NOT_FOUND' })
    })

    it('reports NOT_SCROLLABLE when neither the ref nor its document can move', () => {
        render('<button>Only item</button>')
        markScrollable(document.documentElement, { scrollHeight: 300, clientHeight: 300, scrollWidth: 300, clientWidth: 300 })
        collectSnapshot()

        expect(scrollRef('@e1', 0, 200)).toMatchObject({ ok: false, code: 'NOT_SCROLLABLE' })
    })
})

describe('self-containment (chrome.scripting.executeScript reconstitutes each function alone)', () => {
    it('clickRef succeeds detached from this module — success path', () => {
        render('<button>Save</button>')
        collectSnapshot()
        expect(detachFromModuleScope(clickRef)('@e1')).toEqual({ ok: true })
    })

    it('clickRef succeeds detached from this module — error path', () => {
        render('')
        expect(detachFromModuleScope(clickRef)('@e1')).toMatchObject({ ok: false, code: 'REF_NOT_FOUND' })
    })

    it('fillRef succeeds detached from this module — success path', () => {
        render('<input name="email">')
        collectSnapshot()
        expect(detachFromModuleScope(fillRef)('@e1', 'x')).toEqual({ ok: true, value: 'x' })
    })

    it('fillRef succeeds detached from this module — error path', () => {
        render('')
        expect(detachFromModuleScope(fillRef)('@e1', 'x')).toMatchObject({ ok: false, code: 'REF_NOT_FOUND' })
    })

    it('scrollRef succeeds detached from this module', () => {
        markScrollable(document.documentElement, { scrollHeight: 900, clientHeight: 300 })
        expect(detachFromModuleScope(scrollRef)(null, 0, 200)).toMatchObject({ ok: true, moved: true })
    })
})
