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

/**
 * Viewport centre of a ref, for CDP input which addresses points, not
 * elements. Also focuses it, so a following Input.insertText lands in it.
 *
 * Self-contained for the same reason as the others — see the file docblock.
 */
export function locateRef(ref) {
    const element = window.__happyRefs && window.__happyRefs.get(ref)
    if (!element || !element.isConnected) {
        return { ok: false, code: 'REF_NOT_FOUND', message: `No element for ${ref} — the page may have changed since the last snapshot. Take a new snapshot and use its refs.` }
    }
    if (element.disabled === true) {
        return { ok: false, code: 'ELEMENT_DISABLED', message: `Element ${ref} is disabled` }
    }

    element.scrollIntoView({ block: 'center', inline: 'center' })
    const box = element.getBoundingClientRect()
    if (box.width === 0 && box.height === 0) {
        return { ok: false, code: 'ELEMENT_NOT_VISIBLE', message: `Element ${ref} has no on-screen box to click` }
    }
    if (typeof element.focus === 'function') element.focus()

    return { ok: true, x: box.left + box.width / 2, y: box.top + box.height / 2 }
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

/**
 * Scroll the document, or the nearest scrollable container of a snapshot ref.
 *
 * This function is injected with chrome.scripting.executeScript, so it must be
 * self-contained just like clickRef/fillRef above. Basic scripted scrolling is
 * intentionally permission-free; a trusted CDP wheel is a separate tier and
 * must not be required for ordinary pages and virtual lists.
 */
export function scrollRef(ref, deltaX, deltaY) {
    const x = Number(deltaX ?? 0)
    const y = Number(deltaY ?? 0)
    if (!Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) {
        return { ok: false, code: 'INVALID_SCROLL_DELTA', message: 'deltaX and deltaY must be finite numbers and at least one must be non-zero' }
    }

    let source = null
    if (ref) {
        source = window.__happyRefs && window.__happyRefs.get(ref)
        if (!source || !source.isConnected) {
            return { ok: false, code: 'REF_NOT_FOUND', message: `No element for ${ref} — the page may have changed since the last snapshot. Take a new snapshot and use its refs.` }
        }
    }

    const documentScroller = document.scrollingElement || document.documentElement || document.body
    const maxFor = (element) => ({
        x: Math.max(0, element.scrollWidth - element.clientWidth),
        y: Math.max(0, element.scrollHeight - element.clientHeight),
    })
    const supportsRequestedAxes = (element) => {
        const max = maxFor(element)
        if (element === documentScroller) {
            return (x === 0 || max.x > 0) && (y === 0 || max.y > 0)
        }
        const style = element.ownerDocument.defaultView.getComputedStyle(element)
        const overflowX = style.overflowX || style.overflow
        const overflowY = style.overflowY || style.overflow
        const permitsScroll = (overflow) => overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay' || overflow === 'hidden'
        return (x === 0 || (max.x > 0 && permitsScroll(overflowX)))
            && (y === 0 || (max.y > 0 && permitsScroll(overflowY)))
    }
    const parentAcrossShadow = (element) => {
        if (element.assignedSlot) return element.assignedSlot
        if (element.parentElement) return element.parentElement
        const root = typeof element.getRootNode === 'function' ? element.getRootNode() : null
        return root && root.host ? root.host : null
    }
    const establishesFixedContainingBlock = (element) => {
        const style = element.ownerDocument.defaultView.getComputedStyle(element)
        const nonNone = (value) => Boolean(value) && value !== 'none'
        const contain = style.contain || ''
        const willChange = (style.willChange || '').split(',').map((value) => value.trim())
        return nonNone(style.transform)
            || nonNone(style.translate)
            || nonNone(style.rotate)
            || nonNone(style.scale)
            || nonNone(style.perspective)
            || nonNone(style.filter)
            || nonNone(style.backdropFilter)
            || nonNone(style.webkitBackdropFilter)
            || /(?:^|\s)(?:layout|paint|strict|content)(?:\s|$)/.test(contain)
            || (style.containerType && style.containerType !== 'normal')
            || style.contentVisibility === 'auto'
            || willChange.some((value) => ['transform', 'translate', 'rotate', 'scale', 'perspective', 'filter', 'backdrop-filter'].includes(value))
    }
    const fixedContainingBlock = (element) => {
        for (let parent = parentAcrossShadow(element); parent; parent = parentAcrossShadow(parent)) {
            if (establishesFixedContainingBlock(parent)) return parent
        }
        return null
    }

    let target = source || documentScroller
    if (source) {
        while (target && !supportsRequestedAxes(target)) {
            const style = target.ownerDocument.defaultView.getComputedStyle(target)
            target = style.position === 'fixed'
                ? fixedContainingBlock(target)
                : parentAcrossShadow(target)
        }
        if (!target) {
            return { ok: false, code: 'NOT_SCROLLABLE', message: `No scrollable container for ${ref} in the requested direction` }
        }
    }

    const before = { x: target.scrollLeft, y: target.scrollTop }
    const max = maxFor(target)
    // Chrome represents an RTL scroller as 0 at its right edge and negative
    // values toward its left edge. Clamping every element to 0..max makes an
    // RTL rail impossible to move left at all.
    const rtl = target.ownerDocument.defaultView.getComputedStyle(target).direction === 'rtl'
    const minLeft = rtl ? -max.x : 0
    const maxLeft = rtl ? 0 : max.x
    target.scrollTo({
        left: Math.max(minLeft, Math.min(maxLeft, before.x + x)),
        top: Math.max(0, Math.min(max.y, before.y + y)),
        behavior: 'instant',
    })
    const after = { x: target.scrollLeft, y: target.scrollTop }

    return {
        ok: true,
        target: ref || 'document',
        moved: after.x !== before.x || after.y !== before.y,
        before,
        after,
        max,
        atBoundary: {
            top: y !== 0 && after.y <= 0,
            bottom: y !== 0 && after.y >= max.y,
            left: x !== 0 && after.x <= minLeft,
            right: x !== 0 && after.x >= maxLeft,
        },
    }
}
