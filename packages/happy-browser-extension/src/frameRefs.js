/**
 * Frame-qualified refs.
 *
 * A snapshot covers every frame in the tab, but each frame runs its own copy
 * of `collectSnapshot` and numbers its elements from `@e1` — so the same ref
 * means different things in different frames. These helpers wrap the
 * frame-local ref on the way out and unwrap it on the way back in, which
 * keeps `collectSnapshot` and `actions.js` untouched: those are injected via
 * executeScript and must stay self-contained, so the less they know about
 * frames the better.
 *
 * Main-frame refs keep their plain `@eN` form. Most pages have no meaningful
 * child frames, and unqualified refs are what the agent has been told to
 * expect.
 */

const MAIN_FRAME_ID = 0
const FRAME_REF_PATTERN = /^@f(\d+):(e.+)$/

function describeFrameUrl(value) {
    if (typeof value !== 'string' || value.length === 0) return ''

    let label = value
    try {
        const url = new URL(value)
        label = url.protocol === 'http:' || url.protocol === 'https:'
            ? `${url.origin}${url.pathname}`
            : url.protocol
    } catch {
        // Keep malformed frame data useful without letting it dominate the payload.
    }
    return label.length > 240 ? `${label.slice(0, 239)}…` : label
}

export function encodeRef(frameId, innerRef) {
    if (frameId === MAIN_FRAME_ID) return innerRef
    return `@f${frameId}:${innerRef.slice(1)}`
}

export function decodeRef(ref) {
    const match = FRAME_REF_PATTERN.exec(ref ?? '')
    if (!match) {
        // Not our shape — hand it through unchanged so the page-side lookup
        // answers with its usual REF_NOT_FOUND guidance.
        return { frameId: MAIN_FRAME_ID, innerRef: ref }
    }
    return { frameId: Number(match[1]), innerRef: `@${match[2]}` }
}

/** Fold per-frame snapshots into the single snapshot the agent sees. */
export function mergeFrameSnapshots(injectionResults) {
    // executeScript promises nothing about frame order. Sort so the main
    // frame leads (it is the page the agent is actually looking at) and the
    // rest follow by id — otherwise the listing, and every ref in it, would
    // reshuffle between two snapshots of an unchanged page.
    const frames = injectionResults
        .filter((entry) => entry && entry.result)
        // A result without a frameId is the main frame. Defaulting keeps a
        // missing id from becoming "@fundefined:e1" — a ref nothing can
        // resolve, which the agent would then pass back in good faith.
        .map((entry) => ({ ...entry, frameId: entry.frameId ?? MAIN_FRAME_ID }))
        .sort((a, b) => {
            if (a.frameId === MAIN_FRAME_ID) return -1
            if (b.frameId === MAIN_FRAME_ID) return 1
            return a.frameId - b.frameId
        })
    const main = frames.find((entry) => entry.frameId === MAIN_FRAME_ID) ?? frames[0]

    const elements = []
    let truncated = false

    for (const frame of frames) {
        if (frame.result.truncated) truncated = true
        const frameUrl = frame.frameId === MAIN_FRAME_ID ? '' : describeFrameUrl(frame.result.url)
        for (const [index, element] of (frame.result.elements ?? []).entries()) {
            const entry = { ...element, ref: encodeRef(frame.frameId, element.ref) }
            // One label per child frame is enough to identify its qualified
            // refs; repeating a long URL on every element bloats the payload.
            if (frameUrl && index === 0) entry.frameUrl = frameUrl
            elements.push(entry)
        }
    }

    return {
        url: main?.result?.url,
        title: main?.result?.title,
        elements,
        truncated,
    }
}
