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
    const elements = []
    let truncated = false

    for (const element of document.querySelectorAll(INTERACTIVE_SELECTOR)) {
        if (!isVisible(element)) continue
        if (elements.length >= MAX_ELEMENTS) {
            truncated = true
            break
        }
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
