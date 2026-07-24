/**
 * ref-targeted actions: click and fill, resolved against the map
 * `collectSnapshot` (snapshot.js) leaves on `window.__happyRefs`.
 *
 * Injected via chrome.scripting.executeScript, which serializes each function
 * with `toString()` and re-evaluates it standalone in the page — two
 * consequences confirmed against real Chrome, not just assumed:
 *
 * 1. A shared top-level helper does NOT travel with it. This bit twice:
 *    first with a factored-out `resolveRef`, then again with a factored-out
 *    `refError` — calling either from inside clickRef/fillRef silently
 *    no-ops (no thrown error visible to the caller, no effect) instead of
 *    throwing a ReferenceError. jsdom unit tests never catch this — they
 *    call these functions directly, in the same module scope, where the
 *    closure genuinely works. So EVERY line of logic for each exported
 *    function — including error construction — is written directly inside
 *    it, not shared, exactly like snapshot.js's helpers all living inside
 *    `collectSnapshot`. Do not factor anything out of these two functions.
 * 2. Throwing does NOT reliably reject the whole executeScript() call the
 *    way an earlier version of protocol.js assumed — a thrown error can
 *    resolve with an empty/undefined result instead, which read as silent
 *    success to the caller. So these functions never throw; they always
 *    return `{ok: true, ...}` or `{ok: false, code, message}`, and
 *    protocol.js turns a false `ok` into the command's error response.
 *
 * See specs/chrome-extension-bridge/context.md for how this was found.
 */

export function clickRef(ref) {
    const element = window.__happyRefs && window.__happyRefs.get(ref)
    if (!element || !element.isConnected) {
        return { ok: false, code: 'REF_NOT_FOUND', message: `No element for ${ref} — the page may have changed since the last snapshot. Take a new snapshot and use its refs.` }
    }
    if (element.disabled === true) {
        return { ok: false, code: 'ELEMENT_DISABLED', message: `Element ${ref} is disabled` }
    }

    element.click()
    return { ok: true }
}

export function fillRef(ref, value) {
    const element = window.__happyRefs && window.__happyRefs.get(ref)
    if (!element || !element.isConnected) {
        return { ok: false, code: 'REF_NOT_FOUND', message: `No element for ${ref} — the page may have changed since the last snapshot. Take a new snapshot and use its refs.` }
    }
    if (element.disabled === true) {
        return { ok: false, code: 'ELEMENT_DISABLED', message: `Element ${ref} is disabled` }
    }

    const tag = element.tagName.toLowerCase()

    if (tag === 'input' || tag === 'textarea') {
        const setter = Object.getOwnPropertyDescriptor(element.constructor.prototype, 'value').set
        setter.call(element, value)
        element.dispatchEvent(new Event('input', { bubbles: true }))
        element.dispatchEvent(new Event('change', { bubbles: true }))
        // Read back what actually landed — cheap confirmation for the caller,
        // and it's what let us tell "the setter didn't stick" apart from
        // "something reset it later" while debugging this in real Chrome.
        return { ok: true, value: element.value }
    }

    if (element.isContentEditable || element.getAttribute('contenteditable') === 'true') {
        element.textContent = value
        element.dispatchEvent(new Event('input', { bubbles: true }))
        return { ok: true }
    }

    return { ok: false, code: 'NOT_FILLABLE', message: `Element ${ref} (<${tag}>) is not a text input, textarea or contenteditable element` }
}
