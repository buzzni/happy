import { describe, it, expect } from 'vitest'
import { encodeRef, decodeRef, mergeFrameSnapshots } from './frameRefs.js'

describe('encodeRef', () => {
    it('leaves a main-frame ref untouched, so the common case stays readable', () => {
        expect(encodeRef(0, '@e3')).toBe('@e3')
    })

    it('qualifies a ref from a child frame with its frame id', () => {
        expect(encodeRef(7, '@e3')).toBe('@f7:e3')
    })
})

describe('decodeRef', () => {
    it('reads a bare ref as the main frame', () => {
        expect(decodeRef('@e3')).toEqual({ frameId: 0, innerRef: '@e3' })
    })

    it('reads back a frame-qualified ref', () => {
        expect(decodeRef('@f7:e3')).toEqual({ frameId: 7, innerRef: '@e3' })
    })

    it('round-trips any frame id', () => {
        for (const frameId of [0, 1, 42, 999]) {
            expect(decodeRef(encodeRef(frameId, '@e1'))).toEqual({ frameId, innerRef: '@e1' })
        }
    })

    it('treats a malformed ref as a main-frame ref rather than throwing', () => {
        // The agent may echo back something odd; let the page-side lookup
        // produce the usual REF_NOT_FOUND instead of failing differently here.
        expect(decodeRef('nonsense')).toEqual({ frameId: 0, innerRef: 'nonsense' })
    })
})

describe('mergeFrameSnapshots', () => {
    const mainFrame = {
        frameId: 0,
        result: { url: 'https://a.com/', title: 'A', elements: [{ ref: '@e1', name: 'Main button' }], truncated: false },
    }
    const childFrame = {
        frameId: 7,
        result: { url: 'https://embed.example/', title: 'Embed', elements: [{ ref: '@e1', name: 'Frame button' }], truncated: false },
    }

    it('returns the main frame page url and title', () => {
        const merged = mergeFrameSnapshots([mainFrame, childFrame])
        expect(merged.url).toBe('https://a.com/')
        expect(merged.title).toBe('A')
    })

    it('keeps every frame\'s elements, with refs that no longer collide', () => {
        // Both frames number their own elements from @e1 — without
        // qualification the agent cannot say which one it means.
        const merged = mergeFrameSnapshots([mainFrame, childFrame])
        expect(merged.elements.map((e) => e.ref)).toEqual(['@e1', '@f7:e1'])
    })

    it('labels elements that came from a child frame with that frame url', () => {
        const merged = mergeFrameSnapshots([mainFrame, childFrame])
        expect(merged.elements[0].frameUrl).toBeUndefined()
        expect(merged.elements[1].frameUrl).toBe('https://embed.example/')
    })

    it('carries one safe child frame label instead of duplicating full urls on every element', () => {
        const childWithManyElements = {
            ...childFrame,
            result: {
                ...childFrame.result,
                url: 'https://embed.example/?session=secret#fragment',
                elements: [
                    { ref: '@e1', name: 'First frame control' },
                    { ref: '@e2', name: 'Second frame control' },
                ],
            },
        }
        const dataFrame = {
            frameId: 8,
            result: {
                url: 'data:text/html,<button>unbounded embedded document</button>',
                title: 'Data frame',
                elements: [{ ref: '@e1', name: 'Data frame control' }],
                truncated: false,
            },
        }

        const merged = mergeFrameSnapshots([mainFrame, childWithManyElements, dataFrame])

        expect(merged.elements.filter((element) => element.frameUrl).map((element) => element.frameUrl)).toEqual([
            'https://embed.example/',
            'data:',
        ])
        expect(merged.elements.map((element) => element.ref)).toEqual(['@e1', '@f7:e1', '@f7:e2', '@f8:e1'])
    })

    it('reports truncation if any frame truncated', () => {
        const truncatedChild = { ...childFrame, result: { ...childFrame.result, truncated: true } }
        expect(mergeFrameSnapshots([mainFrame, truncatedChild]).truncated).toBe(true)
    })

    it('skips frames that produced no result instead of crashing', () => {
        // about:blank and frames that refused injection come back empty.
        const merged = mergeFrameSnapshots([mainFrame, { frameId: 9, result: null }, { frameId: 10 }])
        expect(merged.elements.map((e) => e.ref)).toEqual(['@e1'])
    })

    it('still works when the main frame is not first in the results', () => {
        // executeScript does not promise frame order.
        const merged = mergeFrameSnapshots([childFrame, mainFrame])
        expect(merged.url).toBe('https://a.com/')
        expect(merged.elements.map((e) => e.ref)).toEqual(['@e1', '@f7:e1'])
    })

    it('falls back to the first frame for page url when there is no main frame', () => {
        const merged = mergeFrameSnapshots([childFrame])
        expect(merged.url).toBe('https://embed.example/')
    })

    it('returns an empty snapshot for no frames at all', () => {
        expect(mergeFrameSnapshots([])).toEqual({ url: undefined, title: undefined, elements: [], truncated: false })
    })

    it('treats a result with no frameId as the main frame', () => {
        // Better than emitting "@fundefined:e1", which is a ref nothing can
        // ever resolve and which the agent would faithfully pass back.
        const merged = mergeFrameSnapshots([
            { result: { url: 'https://a.com/', title: 'A', elements: [{ ref: '@e1' }], truncated: false } },
        ])
        expect(merged.elements.map((e) => e.ref)).toEqual(['@e1'])
        expect(merged.url).toBe('https://a.com/')
    })
})
