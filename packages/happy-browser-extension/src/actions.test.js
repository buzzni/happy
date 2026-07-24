// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { collectSnapshot } from './snapshot.js'
import { clickRef, fillRef } from './actions.js'

function render(html) {
    document.body.innerHTML = html
    delete window.__happyRefs
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

    it('reports REF_NOT_FOUND when no snapshot has been taken yet', () => {
        expect(() => clickRef('@e1')).toThrow(expect.objectContaining({ code: 'REF_NOT_FOUND' }))
    })

    it('reports REF_NOT_FOUND for a ref from a stale snapshot', () => {
        render('<button>One</button>')
        collectSnapshot()
        render('<button>Two</button>') // page changed; refs map still has the old element
        expect(() => clickRef('@e2')).toThrow(expect.objectContaining({ code: 'REF_NOT_FOUND' }))
    })

    it('reports ELEMENT_DISABLED instead of clicking a disabled control', () => {
        render('<button disabled>Save</button>')
        collectSnapshot()
        expect(() => clickRef('@e1')).toThrow(expect.objectContaining({ code: 'ELEMENT_DISABLED' }))
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
        expect(result).toEqual({ ok: true })
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
        expect(() => fillRef('@e2', 'x')).toThrow(expect.objectContaining({ code: 'REF_NOT_FOUND' }))
    })

    it('reports NOT_FILLABLE for an element that has no text value, like a button', () => {
        render('<button>Save</button>')
        collectSnapshot()
        expect(() => fillRef('@e1', 'x')).toThrow(expect.objectContaining({ code: 'NOT_FILLABLE' }))
    })

    it('reports ELEMENT_DISABLED instead of filling a disabled input', () => {
        render('<input name="email" disabled>')
        collectSnapshot()
        expect(() => fillRef('@e1', 'x')).toThrow(expect.objectContaining({ code: 'ELEMENT_DISABLED' }))
    })
})
