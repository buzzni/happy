// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { collectSnapshot } from './snapshot.js'

function render(html) {
    document.body.innerHTML = html
    delete window.__happyRefs
}

function markVisibleScrollable(element) {
    Object.defineProperties(element, {
        scrollTop: { configurable: true, writable: true, value: 120 },
        scrollLeft: { configurable: true, writable: true, value: 0 },
        scrollHeight: { configurable: true, value: 1000 },
        scrollWidth: { configurable: true, value: 300 },
        clientHeight: { configurable: true, value: 200 },
        clientWidth: { configurable: true, value: 300 },
    })
    element.getBoundingClientRect = () => ({ top: 10, left: 10, bottom: 210, right: 310, width: 300, height: 200 })
}

describe('collectSnapshot', () => {
    beforeEach(() => {
        render('')
    })

    it('gives each interactive element a stable ref', () => {
        render(`
            <button>Save</button>
            <a href="/next">Next</a>
            <input name="email">
        `)
        const { elements } = collectSnapshot()
        expect(elements.map((e) => e.ref)).toEqual(['@e1', '@e2', '@e3'])
    })

    it('describes an element by tag, role and accessible name', () => {
        render('<button id="save">Save changes</button>')
        const { elements } = collectSnapshot()
        expect(elements[0]).toMatchObject({ ref: '@e1', tag: 'button', role: 'button', name: 'Save changes' })
    })

    it('prefers aria-label over text content for the name', () => {
        render('<button aria-label="닫기">×</button>')
        expect(collectSnapshot().elements[0].name).toBe('닫기')
    })

    it('names an input by its label, placeholder, then name attribute', () => {
        render(`
            <label for="a">이메일</label><input id="a" name="email">
            <input id="b" placeholder="검색어">
            <input id="c" name="raw">
        `)
        const names = collectSnapshot().elements.map((e) => e.name)
        expect(names).toEqual(['이메일', '검색어', 'raw'])
    })

    it('includes the current value of a text input', () => {
        render('<input name="q" value="hello">')
        expect(collectSnapshot().elements[0].value).toBe('hello')
    })

    it('reports a disabled control as disabled', () => {
        render('<button disabled>Save</button>')
        expect(collectSnapshot().elements[0].disabled).toBe(true)
    })

    it('skips elements hidden with display:none', () => {
        render('<button style="display:none">Hidden</button><button>Shown</button>')
        const { elements } = collectSnapshot()
        expect(elements).toHaveLength(1)
        expect(elements[0].name).toBe('Shown')
    })

    it('skips elements hidden from assistive tech', () => {
        render('<button aria-hidden="true">Hidden</button><button hidden>Also hidden</button><button>Shown</button>')
        expect(collectSnapshot().elements.map((e) => e.name)).toEqual(['Shown'])
    })

    it('skips interactive descendants of hidden ancestors', () => {
        render(`
            <div hidden><button>Hidden attribute descendant</button></div>
            <div aria-hidden="true"><button>Aria hidden descendant</button></div>
            <div inert><button>Inert descendant</button></div>
            <div style="display:none"><button>Display none descendant</button></div>
            <button>Shown</button>
        `)

        expect(collectSnapshot().elements.map((e) => e.name)).toEqual(['Shown'])
    })

    it('skips interactive descendants of content-visibility:hidden ancestors', () => {
        render(`
            <div style="content-visibility:hidden"><button>Skipped content</button></div>
            <button>Shown</button>
        `)

        expect(collectSnapshot().elements.map((e) => e.name)).toEqual(['Shown'])
    })

    it('keeps an interactive content-visibility:hidden element while skipping its contents', () => {
        render(`
            <button style="content-visibility:hidden" aria-label="Visible button shell">
                <span role="button">Skipped child action</span>
            </button>
        `)

        expect(collectSnapshot().elements.map((e) => e.name)).toEqual(['Visible button shell'])
    })

    it('picks up elements made interactive by role or contenteditable', () => {
        render(`
            <div role="button">역할 버튼</div>
            <div contenteditable="true">편집 영역</div>
            <div>그냥 텍스트</div>
        `)
        expect(collectSnapshot().elements.map((e) => e.role)).toEqual(['button', 'textbox'])
    })

    it('exposes a closed details summary but not its collapsed controls', () => {
        render(`
            <details>
                <summary>More filters</summary>
                <button>Collapsed filter</button>
            </details>
        `)

        expect(collectSnapshot().elements).toMatchObject([
            { role: 'button', name: 'More filters' },
        ])
    })

    it('exposes controls inside an open details element', () => {
        render(`
            <details open>
                <summary>More filters</summary>
                <button>Visible filter</button>
            </details>
        `)

        expect(collectSnapshot().elements.map((element) => element.name)).toEqual([
            'More filters',
            'Visible filter',
        ])
    })

    it('returns the page url and title alongside the elements', () => {
        document.title = 'Test page'
        render('<button>Save</button>')
        const snapshot = collectSnapshot()
        expect(snapshot.title).toBe('Test page')
        expect(snapshot.url).toBe(document.location.href)
    })

    it('stores the ref → element map on the page so later clicks can resolve it', () => {
        render('<button>Save</button>')
        collectSnapshot()
        expect(window.__happyRefs.get('@e1')).toBe(document.querySelector('button'))
    })

    it('renumbers refs on a fresh snapshot instead of growing forever', () => {
        render('<button>One</button>')
        collectSnapshot()
        render('<button>Two</button><button>Three</button>')
        const { elements } = collectSnapshot()
        expect(elements.map((e) => e.ref)).toEqual(['@e1', '@e2'])
        expect(window.__happyRefs.size).toBe(2)
    })

    it('truncates a very long accessible name', () => {
        render(`<button>${'가'.repeat(500)}</button>`)
        expect(collectSnapshot().elements[0].name.length).toBeLessThanOrEqual(120)
    })

    it('caps how many elements one snapshot returns and says it truncated', () => {
        render(Array.from({ length: 250 }, (_, i) => `<button>b${i}</button>`).join(''))
        const snapshot = collectSnapshot()
        expect(snapshot.elements).toHaveLength(200)
        expect(snapshot.truncated).toBe(true)
    })

    it('keeps visible controls and scrollable regions actionable after the first 200 elements', () => {
        render(`
            ${Array.from({ length: 200 }, (_, i) => `<button>earlier-${i}</button>`).join('')}
            <div id="results" aria-label="Later results" style="overflow-y:auto">
                <button id="current-action">Current viewport action</button>
            </div>
        `)
        const results = document.getElementById('results')
        const currentAction = document.getElementById('current-action')
        markVisibleScrollable(results)
        currentAction.getBoundingClientRect = () => ({ top: 20, left: 20, bottom: 60, right: 180, width: 160, height: 40 })

        const snapshot = collectSnapshot()

        expect(snapshot.truncated).toBe(true)
        expect(snapshot.elements.slice(-2)).toMatchObject([
            { ref: '@e201', role: 'button', name: 'Current viewport action' },
            { ref: '@e202', role: 'scrollable', name: 'Later results' },
        ])
        expect(window.__happyRefs.get('@e201')).toBe(currentAction)
        expect(window.__happyRefs.get('@e202')).toBe(results)
    })

    it('does not let clipped controls displace visible controls after the first 200 elements', () => {
        render(`
            ${Array.from({ length: 200 }, (_, i) => `<button>earlier-${i}</button>`).join('')}
            <div id="clipping-parent" style="overflow-y:hidden">
                ${Array.from({ length: 20 }, (_, i) => `<button class="clipped">clipped-${i}</button>`).join('')}
            </div>
            <button id="visible-action">Visible action</button>
        `)
        const clippingParent = document.getElementById('clipping-parent')
        clippingParent.getBoundingClientRect = () => ({ top: 0, left: 0, bottom: 100, right: 300, width: 300, height: 100 })
        for (const clipped of document.querySelectorAll('.clipped')) {
            clipped.getBoundingClientRect = () => ({ top: 200, left: 10, bottom: 240, right: 160, width: 150, height: 40 })
        }
        document.getElementById('visible-action').getBoundingClientRect = () => ({ top: 300, left: 10, bottom: 340, right: 160, width: 150, height: 40 })

        const snapshot = collectSnapshot()

        expect(snapshot.elements.some((element) => element.name === 'Visible action')).toBe(true)
        expect(snapshot.elements.some((element) => element.name.startsWith('clipped-'))).toBe(false)
    })

    it('keeps a viewport-fixed control visible when its DOM parent clips overflow', () => {
        render(`
            ${Array.from({ length: 200 }, (_, i) => `<button>earlier-${i}</button>`).join('')}
            <div id="clipping-parent" style="overflow-x:hidden;overflow-y:hidden">
                <button id="fixed-action" style="position:fixed">Fixed action</button>
            </div>
        `)
        document.getElementById('clipping-parent').getBoundingClientRect = () => ({ top: 0, left: 0, bottom: 1, right: 1, width: 1, height: 1 })
        document.getElementById('fixed-action').getBoundingClientRect = () => ({ top: 300, left: 20, bottom: 340, right: 180, width: 160, height: 40 })

        expect(collectSnapshot().elements.some((element) => element.name === 'Fixed action')).toBe(true)
    })

    it('keeps a control inside a viewport-fixed wrapper visible outside a clipping ancestor', () => {
        render(`
            ${Array.from({ length: 200 }, (_, i) => `<button>earlier-${i}</button>`).join('')}
            <div id="clipping-parent" style="overflow-x:hidden;overflow-y:hidden">
                <div id="fixed-wrapper" style="position:fixed">
                    <button id="fixed-child">Fixed child action</button>
                </div>
            </div>
        `)
        document.getElementById('clipping-parent').getBoundingClientRect = () => ({ top: 0, left: 0, bottom: 1, right: 1, width: 1, height: 1 })
        document.getElementById('fixed-wrapper').getBoundingClientRect = () => ({ top: 300, left: 20, bottom: 340, right: 180, width: 160, height: 40 })
        document.getElementById('fixed-child').getBoundingClientRect = () => ({ top: 300, left: 20, bottom: 340, right: 180, width: 160, height: 40 })

        expect(collectSnapshot().elements.some((element) => element.name === 'Fixed child action')).toBe(true)
    })

    it('clips a fixed control inside a will-change containing block', () => {
        render(`
            ${Array.from({ length: 200 }, (_, i) => `<button>earlier-${i}</button>`).join('')}
            <div id="clipping-parent" style="will-change:translate;overflow-x:hidden;overflow-y:hidden">
                <button id="fixed-action" style="position:fixed">Contained fixed action</button>
            </div>
        `)
        document.getElementById('clipping-parent').getBoundingClientRect = () => ({ top: 0, left: 0, bottom: 1, right: 1, width: 1, height: 1 })
        document.getElementById('fixed-action').getBoundingClientRect = () => ({ top: 300, left: 20, bottom: 340, right: 180, width: 160, height: 40 })

        expect(collectSnapshot().elements.find((element) => element.name === 'Contained fixed action')).toBeUndefined()
    })

    it('does not clip a viewport-fixed control under a container-type ancestor', () => {
        render(`
            ${Array.from({ length: 200 }, (_, i) => `<button>earlier-${i}</button>`).join('')}
            <div id="clipping-parent" style="container-type:size;overflow-x:hidden;overflow-y:hidden">
                <button id="fixed-action" style="position:fixed">Container query fixed action</button>
            </div>
        `)
        document.getElementById('clipping-parent').getBoundingClientRect = () => ({ top: 0, left: 0, bottom: 1, right: 1, width: 1, height: 1 })
        document.getElementById('fixed-action').getBoundingClientRect = () => ({ top: 300, left: 20, bottom: 340, right: 180, width: 160, height: 40 })

        expect(collectSnapshot().elements.some((element) => element.name === 'Container query fixed action')).toBe(true)
    })

    it('does not treat a slotted control clipped by its shadow container as viewport-visible', () => {
        render(`
            ${Array.from({ length: 200 }, (_, i) => `<button>earlier-${i}</button>`).join('')}
            <div id="host"><button id="slotted-action" slot="items">Slotted clipped action</button></div>
        `)
        const shadow = document.getElementById('host').attachShadow({ mode: 'open' })
        shadow.innerHTML = '<div id="clip" style="overflow-x:hidden;overflow-y:hidden"><slot name="items"></slot></div>'
        shadow.getElementById('clip').getBoundingClientRect = () => ({ top: 0, left: 0, bottom: 100, right: 300, width: 300, height: 100 })
        document.getElementById('slotted-action').getBoundingClientRect = () => ({ top: 200, left: 10, bottom: 240, right: 160, width: 150, height: 40 })

        expect(collectSnapshot().elements.some((element) => element.name === 'Slotted clipped action')).toBe(false)
    })

    it('does not flag truncation for a normal page', () => {
        render('<button>Save</button>')
        expect(collectSnapshot().truncated).toBe(false)
    })

    it('does not measure viewport geometry for ordinary non-interactive elements', () => {
        render(Array.from({ length: 500 }, () => '<div>plain content</div>').join(''))
        let measurements = 0
        for (const element of document.querySelectorAll('*')) {
            element.getBoundingClientRect = () => {
                measurements += 1
                return { top: 0, left: 0, bottom: 10, right: 10, width: 10, height: 10 }
            }
        }

        collectSnapshot()

        expect(measurements).toBe(0)
    })

    it('appends visible scrollable regions without renumbering interactive refs', () => {
        render(`
            <div id="results" aria-label="Search results" style="overflow-y:auto">
                <button>First result</button>
            </div>
            <button>After results</button>
        `)
        markVisibleScrollable(document.getElementById('results'))

        const { elements } = collectSnapshot()

        expect(elements.slice(0, 2).map((element) => [element.ref, element.name])).toEqual([
            ['@e1', 'First result'],
            ['@e2', 'After results'],
        ])
        expect(elements[2]).toMatchObject({
            ref: '@e3',
            role: 'scrollable',
            name: 'Search results',
            scrollable: { x: false, y: true, left: 0, top: 120, maxLeft: 0, maxTop: 800 },
        })
        expect(window.__happyRefs.get('@e3')).toBe(document.getElementById('results'))
    })

    it('exposes an overflow-hidden region that can be scrolled by script', () => {
        render('<div id="carousel" aria-label="Carousel" style="overflow-x:hidden"></div>')
        const carousel = document.getElementById('carousel')
        Object.defineProperties(carousel, {
            scrollTop: { configurable: true, writable: true, value: 0 },
            scrollLeft: { configurable: true, writable: true, value: 0 },
            scrollHeight: { configurable: true, value: 100 },
            scrollWidth: { configurable: true, value: 900 },
            clientHeight: { configurable: true, value: 100 },
            clientWidth: { configurable: true, value: 300 },
        })
        carousel.getBoundingClientRect = () => ({ top: 10, left: 10, bottom: 110, right: 310, width: 300, height: 100 })

        expect(collectSnapshot().elements).toMatchObject([
            { role: 'scrollable', name: 'Carousel', scrollable: { x: true, y: false } },
        ])
    })

    describe('shadow DOM', () => {
        function attachShadow(hostId, html, mode = 'open') {
            const root = document.getElementById(hostId).attachShadow({ mode })
            root.innerHTML = html
            return root
        }

        it('finds interactive elements inside an open shadow root', () => {
            // querySelectorAll does not pierce shadow roots, so a web
            // component's controls are invisible to a naive snapshot.
            render('<div id="host"></div>')
            attachShadow('host', '<button>In shadow</button>')
            const { elements } = collectSnapshot()
            expect(elements.map((e) => e.name)).toEqual(['In shadow'])
        })

        it('finds elements in both the light DOM and a shadow root', () => {
            render('<button>Light</button><div id="host"></div>')
            attachShadow('host', '<button>Shadow</button>')
            expect(collectSnapshot().elements.map((e) => e.name)).toEqual(['Light', 'Shadow'])
        })

        it('descends into nested shadow roots', () => {
            render('<div id="host"></div>')
            const outer = attachShadow('host', '<div id="inner"></div>')
            const innerRoot = outer.getElementById('inner').attachShadow({ mode: 'open' })
            innerRoot.innerHTML = '<button>Deep</button>'
            expect(collectSnapshot().elements.map((e) => e.name)).toEqual(['Deep'])
        })

        it('gives shadow elements refs that resolve like any other', () => {
            render('<div id="host"></div>')
            const root = attachShadow('host', '<button>In shadow</button>')
            const { elements } = collectSnapshot()
            expect(window.__happyRefs.get(elements[0].ref)).toBe(root.querySelector('button'))
        })

        it('honours hidden state on a shadow host', () => {
            render('<div id="host" aria-hidden="true"></div><button>Shown</button>')
            attachShadow('host', '<button>Hidden in shadow</button>')

            expect(collectSnapshot().elements.map((e) => e.name)).toEqual(['Shown'])
        })

        it('cannot see into a closed shadow root, and that is a browser limit not a bug', () => {
            render('<button>Light</button><div id="host"></div>')
            attachShadow('host', '<button>Hidden</button>', 'closed')
            expect(collectSnapshot().elements.map((e) => e.name)).toEqual(['Light'])
        })

        it('still honours the element cap across shadow boundaries', () => {
            render('<div id="host"></div>')
            attachShadow('host', Array.from({ length: 250 }, (_, i) => `<button>b${i}</button>`).join(''))
            const snapshot = collectSnapshot()
            expect(snapshot.elements).toHaveLength(200)
            expect(snapshot.truncated).toBe(true)
        })
    })
})
