/**
 * Functions run inside page frames via Runtime.callFunctionOn, always in the
 * driver's ISOLATED world (never the page main world, whose prototypes the
 * page can patch). They are plain JavaScript source strings (not TS functions)
 * so no transpiler helper can leak into them and the DOM lib types are not
 * needed by the Node-side typecheck.
 *
 * The collector is ported from packages/happy-browser-extension/src/snapshot.js
 * (visibility / role / name logic, open shadow root traversal) and returns the
 * element nodes themselves so the driver can bind refs to backendNodeIds.
 */

export interface CollectorLimits {
    maxElements: number
    maxTextChars: number
}

export interface CollectedElement {
    tag: string
    role: string
    name: string
    value?: string
    disabled?: boolean
    visible: boolean
}

export interface CollectedFrame {
    url: string
    title: string
    text: string
    truncated: boolean
    elements: CollectedElement[]
}

export const COLLECT_FRAME = String.raw`function collectFrame(limits, scope) {
    const INTERACTIVE = [
        'a[href]', 'button', 'input', 'select', 'textarea', 'summary',
        '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]', '[role="tab"]',
        '[role="menuitem"]', '[role="textbox"]', '[role="switch"]', '[role="option"]',
        '[contenteditable="true"]', '[contenteditable=""]',
    ].join(',')
    // Containers get refs so a later observe can be scoped to their subtree.
    const CONTAINER = [
        'form', 'dialog', 'fieldset', 'nav', 'main', 'section[aria-label]', 'section[aria-labelledby]',
        '[role="region"]', '[role="group"]', '[role="dialog"]', '[role="list"]', '[role="listbox"]',
        '[role="menu"]', '[role="form"]', '[role="navigation"]', '[role="main"]',
    ].join(',')
    const MAX_NAME = 120
    const clean = (text) => (text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME)

    const parentAcrossShadow = (element) => {
        if (element.assignedSlot) return element.assignedSlot
        if (element.parentElement) return element.parentElement
        const root = element.getRootNode()
        return root && (root).host ? (root).host : null
    }
    const styles = new Map()
    const styleOf = (element) => {
        let style = styles.get(element)
        if (!style) {
            style = element.ownerDocument.defaultView.getComputedStyle(element)
            styles.set(element, style)
        }
        return style
    }
    const hiddenTrees = new Map()
    const isInHiddenTree = (element) => {
        const cached = hiddenTrees.get(element)
        if (cached !== undefined) return cached
        const parent = parentAcrossShadow(element)
        const style = styleOf(element)
        const firstSummary = parent?.tagName === 'DETAILS'
            ? Array.from(parent.children).find((child) => child.tagName === 'SUMMARY')
            : null
        const collapsedByDetails = parent?.tagName === 'DETAILS' && !parent.hasAttribute('open') && element !== firstSummary
        const hidden = element.hasAttribute('hidden')
            || element.hasAttribute('inert')
            || element.getAttribute('aria-hidden') === 'true'
            || style.display === 'none'
            || collapsedByDetails
            || (parent ? styleOf(parent).contentVisibility === 'hidden' : false)
            || (parent ? isInHiddenTree(parent) : false)
        hiddenTrees.set(element, hidden)
        return hidden
    }
    const isVisible = (element) => {
        if (isInHiddenTree(element)) return false
        const visibility = styleOf(element).visibility
        if (visibility === 'hidden' || visibility === 'collapse') return false
        const rect = element.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
    }
    const roleOf = (element) => {
        const explicit = element.getAttribute('role')
        if (explicit) return explicit
        const tag = element.tagName.toLowerCase()
        if (tag === 'a') return 'link'
        if (tag === 'button' || tag === 'summary') return 'button'
        if (tag === 'select') return 'combobox'
        if (tag === 'textarea') return 'textbox'
        if (tag === 'form') return 'form'
        if (tag === 'dialog') return 'dialog'
        if (tag === 'fieldset') return 'group'
        if (tag === 'nav') return 'navigation'
        if (tag === 'main') return 'main'
        if (tag === 'section') return 'region'
        if ((element).isContentEditable) return 'textbox'
        if (tag === 'input') {
            const type = (element.getAttribute('type') || 'text').toLowerCase()
            if (type === 'checkbox' || type === 'radio') return type
            if (type === 'submit' || type === 'button' || type === 'reset') return 'button'
            return 'textbox'
        }
        return 'generic'
    }
    const isContainer = (element) => element.matches(CONTAINER)
    const nameOf = (element) => {
        const label = element.getAttribute('aria-label')
        if (label) return clean(label)
        const labelledBy = element.getAttribute('aria-labelledby')
        if (labelledBy) {
            const target = (element.getRootNode()).getElementById?.(labelledBy)
                ?? element.ownerDocument.getElementById(labelledBy)
            if (target) return clean(target.textContent)
        }
        const labels = (element).labels
        if (labels && labels[0]) return clean(labels[0].textContent)
        const placeholder = element.getAttribute('placeholder')
        if (placeholder) return clean(placeholder)
        if (isContainer(element)) {
            const legend = element.tagName === 'FIELDSET' ? element.querySelector('legend') : null
            return clean(legend?.textContent || element.getAttribute('title') || '')
        }
        const text = clean(element.textContent)
        if (text) return text
        return clean(element.getAttribute('name') || element.getAttribute('title') || '')
    }

    const elements = []
    const nodes = []
    let truncated = false
    const record = (element) => {
        if (elements.length >= limits.maxElements) {
            truncated = true
            return
        }
        const tag = element.tagName.toLowerCase()
        const entry = { tag, role: roleOf(element), name: nameOf(element), visible: isVisible(element) }
        const isPassword = tag === 'input' && ((element).type || '').toLowerCase() === 'password'
        const value = (element).value
        // Password values are never read out, not even redacted-length hints.
        if (!isPassword && !isContainer(element) && typeof value === 'string' && value !== '') entry.value = value.slice(0, 200)
        if ((element).disabled === true || element.getAttribute('aria-disabled') === 'true') entry.disabled = true
        elements.push(entry)
        nodes.push(element)
    }
    const walk = (root) => {
        for (const element of Array.from(root.querySelectorAll('*'))) {
            if (element.matches(INTERACTIVE) || element.matches(CONTAINER)) record(element)
            if (element.shadowRoot) walk(element.shadowRoot)
        }
    }
    if (scope) {
        if (scope.shadowRoot) walk(scope.shadowRoot)
        walk(scope)
    } else {
        walk(document)
    }

    const textRoot = (scope) ?? document.body ?? document.documentElement
    let text = textRoot ? ((textRoot).innerText || '') : ''
    text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
    if (text.length > limits.maxTextChars) {
        text = text.slice(0, limits.maxTextChars)
        truncated = true
    }
    const meta = { url: location.href, title: document.title, text, truncated, elements }
    return { json: JSON.stringify(meta), nodes }
}`

export type ElementState = 'ok' | 'detached' | 'invisible' | 'disabled' | 'not-editable'

/** `this` = the target element. */
export const CHECK_ELEMENT = String.raw`function checkElement(forFill) {
    const element = this
    if (!element.isConnected) return 'detached'
    for (let node = element; node; ) {
        if (node.hasAttribute('hidden') || node.hasAttribute('inert') || node.getAttribute('aria-hidden') === 'true') return 'invisible'
        const root = node.getRootNode()
        node = node.assignedSlot ?? node.parentElement ?? (root && root.host ? root.host : null)
    }
    const visibleByCss = typeof (element).checkVisibility === 'function'
        ? (element).checkVisibility({ checkVisibilityCSS: true })
        : true
    const rect = element.getBoundingClientRect()
    if (!visibleByCss || rect.width <= 0 || rect.height <= 0) return 'invisible'
    if (element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true') return 'disabled'
    if (forFill) {
        const tag = element.tagName.toLowerCase()
        const type = ((element).type || '').toLowerCase()
        const textInput = tag === 'input' && !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image', 'range', 'color', 'hidden'].includes(type)
        const editable = textInput || tag === 'textarea' || (element).isContentEditable
        if (!editable || (element).readOnly) return 'not-editable'
    }
    return 'ok'
}`

/** `this` = the target element. True when its centre point hits it (not an overlay). */
export const HIT_TEST = String.raw`function hitTest() {
    const element = this
    const rect = element.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    const root = element.getRootNode()
    const hit = (typeof (root).elementFromPoint === 'function' ? root : document).elementFromPoint(x, y)
    return !!hit && (hit === element || element.contains(hit))
}`

/** `this` = the target element; selects its current content so insertText replaces it. */
/** Focuses and selects the element; returns whether it (still) holds focus, so text never goes elsewhere. */
export const SELECT_CONTENT = String.raw`function selectContent() {
    const element = this
    element.focus()
    const root = element.getRootNode()
    const focused = () => (root.activeElement ?? element.ownerDocument.activeElement) === element
    if (typeof element.select === 'function') {
        element.select()
        return focused()
    }
    const selection = element.ownerDocument.getSelection()
    if (!selection) return focused()
    const range = element.ownerDocument.createRange()
    range.selectNodeContents(element)
    selection.removeAllRanges()
    selection.addRange(range)
    return focused()
}`

export const FRAME_HAS_TEXT = String.raw`function frameHasText(needle) {
    const body = document.body ?? document.documentElement
    return !!body && ((body).innerText || '').includes(needle)
}`

/** Runs on a resolved element; reads its form context without touching page state. */
export const DESCRIBE_ELEMENT = String.raw`function describeElement() {
    const element = this
    const form = element.form || (element.closest && element.closest('form'))
    const formValues = {}
    if (form) {
        for (const field of Array.from(form.elements)) {
            if (!field.name || field.type === 'password' || field.type === 'file') continue
            if ((field.type === 'checkbox' || field.type === 'radio') && !field.checked) continue
            formValues[field.name] = String(field.value ?? '').slice(0, 200)
        }
    }
    return { pageUrl: String(location.href), formAction: form ? String(form.action || location.href) : undefined, formValues }
}`
