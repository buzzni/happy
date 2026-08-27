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

    it('picks up elements made interactive by role or contenteditable', () => {
        render(`
            <div role="button">역할 버튼</div>
            <div contenteditable="true">편집 영역</div>
            <div>그냥 텍스트</div>
        `)
        expect(collectSnapshot().elements.map((e) => e.role)).toEqual(['button', 'textbox'])
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

    it('does not flag truncation for a normal page', () => {
        render('<button>Save</button>')
        expect(collectSnapshot().truncated).toBe(false)
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
