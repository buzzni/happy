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
    const MAX_VIEWPORT_INTERACTIVES = 20
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
        'summary',
        '[contenteditable="true"]',
    ].join(',')

    const clean = (text) => (text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH)

    const parentAcrossShadow = (element) => {
        if (element.assignedSlot) return element.assignedSlot
        if (element.parentElement) return element.parentElement
        const root = typeof element.getRootNode === 'function' ? element.getRootNode() : null
        return root && root.host ? root.host : null
    }

    const styles = new Map()
    const styleOf = (element) => {
        if (!styles.has(element)) {
            styles.set(element, element.ownerDocument.defaultView.getComputedStyle(element))
        }
        return styles.get(element)
    }

    const hiddenTrees = new Map()
    const isInHiddenTree = (element) => {
        if (hiddenTrees.has(element)) return hiddenTrees.get(element)
        const parent = parentAcrossShadow(element)
        const style = styleOf(element)
        const firstSummary = parent?.tagName === 'DETAILS'
            ? Array.from(parent.children).find((child) => child.tagName === 'SUMMARY')
            : null
        const collapsedByDetails = parent?.tagName === 'DETAILS'
            && !parent.hasAttribute('open')
            && element !== firstSummary
        const hidden = element.hasAttribute('hidden')
            || element.hasAttribute('inert')
            || element.getAttribute('aria-hidden') === 'true'
            || style.display === 'none'
            || collapsedByDetails
            || (parent && styleOf(parent).contentVisibility === 'hidden')
            || (parent ? isInHiddenTree(parent) : false)
        hiddenTrees.set(element, hidden)
        return hidden
    }

    const isVisible = (element) => {
        if (isInHiddenTree(element)) return false
        const visibility = styleOf(element).visibility
        return visibility !== 'hidden' && visibility !== 'collapse'
    }

    const roleOf = (element) => {
        const explicit = element.getAttribute('role')
        if (explicit) return explicit
        const tag = element.tagName.toLowerCase()
        if (tag === 'a') return 'link'
        if (tag === 'button') return 'button'
        if (tag === 'summary') return 'button'
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
    const viewportInteractiveCandidates = []
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
        const style = styleOf(element)
        const overflowX = style.overflowX || style.overflow
        const overflowY = style.overflowY || style.overflow
        const permitsScroll = (overflow) => overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay' || overflow === 'hidden'
        const permitsX = permitsScroll(overflowX)
        const permitsY = permitsScroll(overflowY)
        if (!permitsX && !permitsY) return null
        const maxLeft = permitsX ? Math.max(0, element.scrollWidth - element.clientWidth) : 0
        const maxTop = permitsY ? Math.max(0, element.scrollHeight - element.clientHeight) : 0
        const x = maxLeft > 0
        const y = maxTop > 0
        if (!x && !y) return null
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
        const view = element.ownerDocument.defaultView
        let top = Math.max(0, box.top)
        let right = Math.min(view.innerWidth, box.right)
        let bottom = Math.min(view.innerHeight, box.bottom)
        let left = Math.max(0, box.left)
        const clips = (overflow) => overflow === 'auto'
            || overflow === 'scroll'
            || overflow === 'overlay'
            || overflow === 'hidden'
            || overflow === 'clip'

        const establishesFixedContainingBlock = (style) => {
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
                || style.contentVisibility === 'auto'
                || willChange.some((value) => ['transform', 'translate', 'rotate', 'scale', 'perspective', 'filter', 'backdrop-filter'].includes(value))
        }

        let escapesAncestors = styleOf(element).position === 'fixed'
        for (let parent = parentAcrossShadow(element); parent;) {
            const style = styleOf(parent)
            if (escapesAncestors && !establishesFixedContainingBlock(style)) {
                parent = parentAcrossShadow(parent)
                continue
            }
            escapesAncestors = false
            const clipsX = clips(style.overflowX || style.overflow)
            const clipsY = clips(style.overflowY || style.overflow)
            if (clipsX || clipsY) {
                const parentBox = parent.getBoundingClientRect()
                if (clipsX) {
                    left = Math.max(left, parentBox.left)
                    right = Math.min(right, parentBox.right)
                }
                if (clipsY) {
                    top = Math.max(top, parentBox.top)
                    bottom = Math.min(bottom, parentBox.bottom)
                }
            }
            if (style.position === 'fixed') escapesAncestors = true
            parent = parentAcrossShadow(parent)
        }

        return right > left && bottom > top
    }

    // Walks every element under `root`, stepping into open shadow roots as it
    // meets them. querySelectorAll does not pierce shadow boundaries, so a
    // web component's controls are invisible without this. Recursing at the
    // host keeps a component's internals next to it in the listing.
    // Closed shadow roots expose no `shadowRoot` at all — that content is
    // unreachable by design, not an oversight here.
    const walk = (root) => {
        for (const element of root.querySelectorAll('*')) {
            const visible = isVisible(element)
            let inViewport
            const getInViewport = () => {
                if (inViewport === undefined) inViewport = isInViewport(element)
                return inViewport
            }
            if (element.matches(INTERACTIVE_SELECTOR) && visible) {
                if (elements.length < MAX_ELEMENTS) {
                    record(element)
                } else {
                    truncated = true
                    if (viewportInteractiveCandidates.length < MAX_VIEWPORT_INTERACTIVES && getInViewport()) {
                        viewportInteractiveCandidates.push(element)
                    }
                }
            }
            if (visible && scrollableCandidates.length < MAX_SCROLLABLES) {
                const metrics = scrollableMetrics(element)
                if (metrics && getInViewport()) scrollableCandidates.push({ element, metrics })
            }
            if (element.shadowRoot) walk(element.shadowRoot)
        }
    }

    walk(document)

    // Keep the long-page prefix stable for compatibility, but do not let it
    // hide the controls the user just scrolled into view. This bounded tail is
    // what makes snapshot → scroll → snapshot useful on pages with more than
    // MAX_ELEMENTS controls without turning the snapshot into an unbounded
    // DOM dump.
    for (const element of viewportInteractiveCandidates) record(element)

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
