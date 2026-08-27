/**
 * DOM snapshot for the agent: the interactive elements of a page, each with a
 * `@eN` ref that later click/fill commands resolve back to the element.
 *
 * IMPORTANT: `collectSnapshot` is injected into the page via
 * chrome.scripting.executeScript, which serializes it with `toString()`. It
 * therefore must be entirely self-contained — no imports, no closure over
 * anything in this module. That is why the helpers live inside it.
 */

export function collectSnapshot() {
    const MAX_ELEMENTS = 200
    const MAX_SCROLLABLES = 20
    const MAX_NAME_LENGTH = 120

    const INTERACTIVE_SELECTOR = [
        'a[href]',
        'button',
        'input',
        'select',
        'textarea',
        '[role="button"]',
        '[role="link"]',
        '[role="checkbox"]',
        '[role="radio"]',
        '[role="tab"]',
        '[role="menuitem"]',
        '[role="textbox"]',
        '[contenteditable="true"]',
    ].join(',')

    const clean = (text) => (text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH)

    const isVisible = (element) => {
        if (element.hasAttribute('hidden')) return false
        if (element.getAttribute('aria-hidden') === 'true') return false
        const style = element.ownerDocument.defaultView.getComputedStyle(element)
        if (style.display === 'none' || style.visibility === 'hidden') return false
        return true
    }

    const roleOf = (element) => {
        const explicit = element.getAttribute('role')
        if (explicit) return explicit
        const tag = element.tagName.toLowerCase()
        if (tag === 'a') return 'link'
        if (tag === 'button') return 'button'
        if (tag === 'select') return 'combobox'
        if (tag === 'textarea') return 'textbox'
        if (element.isContentEditable || element.getAttribute('contenteditable') === 'true') return 'textbox'
        if (tag === 'input') {
            const type = (element.getAttribute('type') || 'text').toLowerCase()
            if (type === 'checkbox' || type === 'radio') return type
            if (type === 'submit' || type === 'button' || type === 'reset') return 'button'
            return 'textbox'
        }
        return 'generic'
    }

    const nameOf = (element) => {
        const label = element.getAttribute('aria-label')
        if (label) return clean(label)

        const labelledBy = element.getAttribute('aria-labelledby')
        if (labelledBy) {
            const target = element.ownerDocument.getElementById(labelledBy)
            if (target) return clean(target.textContent)
        }
        // `labels` covers both `<label for=...>` and a wrapping `<label>`.
        const nativeLabel = element.labels && element.labels[0]
        if (nativeLabel) return clean(nativeLabel.textContent)
        const placeholder = element.getAttribute('placeholder')
        if (placeholder) return clean(placeholder)

        const text = clean(element.textContent)
        if (text) return text

        return clean(element.getAttribute('name') || element.getAttribute('title') || '')
    }

    const refs = new Map()
    const entriesByElement = new Map()
    const elements = []
    const scrollableCandidates = []
    let truncated = false

    const record = (element) => {
        const ref = `@e${elements.length + 1}`
        refs.set(ref, element)
        const entry = {
            ref,
            tag: element.tagName.toLowerCase(),
            role: roleOf(element),
            name: nameOf(element),
        }
        if (typeof element.value === 'string' && element.value !== '') entry.value = element.value
        if (element.disabled === true) entry.disabled = true
        elements.push(entry)
        entriesByElement.set(element, entry)
    }

    const scrollableMetrics = (element) => {
        const style = element.ownerDocument.defaultView.getComputedStyle(element)
        const overflowX = style.overflowX || style.overflow
        const overflowY = style.overflowY || style.overflow
        const permitsScroll = (overflow) => overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay'
        const maxLeft = Math.max(0, element.scrollWidth - element.clientWidth)
        const maxTop = Math.max(0, element.scrollHeight - element.clientHeight)
        const x = maxLeft > 0 && permitsScroll(overflowX)
        const y = maxTop > 0 && permitsScroll(overflowY)
        return {
            x,
            y,
            left: element.scrollLeft,
            top: element.scrollTop,
            maxLeft,
            maxTop,
        }
    }

    const isInViewport = (element) => {
        const box = element.getBoundingClientRect()
        return box.width > 0
            && box.height > 0
            && box.bottom > 0
            && box.right > 0
            && box.top < element.ownerDocument.defaultView.innerHeight
            && box.left < element.ownerDocument.defaultView.innerWidth
    }

    // Walks every element under `root`, stepping into open shadow roots as it
    // meets them. querySelectorAll does not pierce shadow boundaries, so a
    // web component's controls are invisible without this. Recursing at the
    // host keeps a component's internals next to it in the listing.
    // Closed shadow roots expose no `shadowRoot` at all — that content is
    // unreachable by design, not an oversight here.
    const walk = (root) => {
        for (const element of root.querySelectorAll('*')) {
            if (elements.length >= MAX_ELEMENTS) {
                truncated = true
                return
            }
            if (element.matches(INTERACTIVE_SELECTOR) && isVisible(element)) record(element)
            if (isVisible(element) && isInViewport(element)) {
                const metrics = scrollableMetrics(element)
                if (metrics.x || metrics.y) scrollableCandidates.push({ element, metrics })
            }
            if (element.shadowRoot) {
                walk(element.shadowRoot)
                if (truncated) return
            }
        }
    }

    walk(document)

    for (const { element, metrics } of scrollableCandidates.slice(0, MAX_SCROLLABLES)) {
        const existing = entriesByElement.get(element)
        if (existing) {
            existing.scrollable = metrics
            continue
        }
        const ref = `@e${elements.length + 1}`
        refs.set(ref, element)
        const entry = {
            ref,
            tag: element.tagName.toLowerCase(),
            role: 'scrollable',
            name: nameOf(element),
            scrollable: metrics,
        }
        elements.push(entry)
        entriesByElement.set(element, entry)
    }

    // Replaced wholesale so refs always match the snapshot just handed out.
    window.__happyRefs = refs

    return {
        url: document.location.href,
        title: document.title,
        elements,
        truncated,
    }
}
