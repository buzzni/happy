/**
 * ref-targeted actions: click and fill, resolved against the map
 * `collectSnapshot` (snapshot.js) leaves on `window.__happyRefs`.
 *
 * Same constraint as snapshot.js: injected via chrome.scripting.executeScript,
 * which serializes with `toString()`, so each function must be self-contained.
 */

function resolveRef(ref) {
    const element = window.__happyRefs && window.__happyRefs.get(ref)
    if (!element || !element.isConnected) {
        const error = new Error(`No element for ${ref} — the page may have changed since the last snapshot. Take a new snapshot and use its refs.`)
        error.code = 'REF_NOT_FOUND'
        throw error
    }
    if (element.disabled === true) {
        const error = new Error(`Element ${ref} is disabled`)
        error.code = 'ELEMENT_DISABLED'
        throw error
    }
    return element
}

export function clickRef(ref) {
    const element = resolveRef(ref)
    element.click()
    return { ok: true }
}

export function fillRef(ref, value) {
    const element = resolveRef(ref)
    const tag = element.tagName.toLowerCase()

    if (tag === 'input' || tag === 'textarea') {
        const setter = Object.getOwnPropertyDescriptor(element.constructor.prototype, 'value').set
        setter.call(element, value)
        element.dispatchEvent(new Event('input', { bubbles: true }))
        element.dispatchEvent(new Event('change', { bubbles: true }))
        return { ok: true }
    }

    if (element.isContentEditable || element.getAttribute('contenteditable') === 'true') {
        element.textContent = value
        element.dispatchEvent(new Event('input', { bubbles: true }))
        return { ok: true }
    }

    const error = new Error(`Element ${ref} (<${tag}>) is not a text input, textarea or contenteditable element`)
    error.code = 'NOT_FILLABLE'
    throw error
}
