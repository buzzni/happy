/**
 * Browser-only page view engine shared by the console documents: one view's lifetime, frame reads, pointer/wheel/key/IME
 * input, its serialized queue and receipts. The host page keeps the capability, the task and its controls, and hands
 * them in through `o`; every authority is enforced again by Runtime.
 */
export const pageViewerScript = String.raw`/** o: request, image, input, viewport, empty, text, status, fail, render, task, ended, identity, busy, generation. */
function createPageViewer(o) {
    const { image, input, text, status } = o;
    let view = null, frame = null;
    let sequence = 0, polling = false, inputBusy = false, lost = false, composing = false, fitted = true;
    let confirmedAt = -Infinity, captureAge = 0, keyModifiers = 0;
    // Runtime serves a view one frame per 500 ms, or per 200 ms while this viewer holds the tab; a read inside that
    // interval (or over the profile's byte budget, reset each second) is refused, so the next one waits that long.
    let lastRead = -Infinity, retryAt = -Infinity;
    let wheelRefresh = false;
    const queue = [];
    const keys = new Set();
    const clearImage = () => { frame = null; image.hidden = true; image.removeAttribute('src'); o.empty.hidden = false; confirmedAt = -Infinity; };
    const own = () => {
        const c = o.identity(), task = o.task();
        return task?.tabLeases?.find((l) => l.tabId === view?.tabId && l.owner.kind === 'user' && l.owner.viewerSessionId === c.viewerSessionId && l.owner.principalId === c.principalId);
    };
    const fresh = () => !!frame && performance.now() - confirmedAt + captureAge < 3000;
    const canInput = () => !!own() && fresh() && !o.busy() && !lost && !o.ended() && !document.hidden && !view?.closed;
    function paint() {
        o.viewport.classList.toggle('stale', !!frame && !fresh());
        image.setAttribute('aria-disabled', String(!canInput()));
    }
    async function close() {
        const old = view;
        view = null;
        wheelRefresh = false;
        queue.length = 0;
        keys.clear();
        keyModifiers = 0;
        clearImage();
        if (old && o.token())
            await o.request('closePageView', { schemaVersion: 1, viewId: old.viewId });
    }
    async function open(scope, tabId, stillCurrent) {
        sequence = 0;
        const opened = await o.request('openPageView', { schemaVersion: 1, ...scope, tabId });
        if (!stillCurrent()) {
            await o.request('closePageView', { schemaVersion: 1, viewId: opened.viewId });
            return;
        }
        view = { ...opened, tabId };
        status(text.connecting);
    }
    async function receipt() {
        if (!view)
            return;
        const owner = view;
        const result = await o.request('getPageFrame', { schemaVersion: 1, viewId: owner.viewId, statusOnly: true });
        if (view !== owner)
            return;
        if (result.status.unknown) {
            status(text.unresolved, true);
            return;
        }
        if (!result.status.draining && result.status.lastSettled >= sequence)
            status(text.confirmed);
    }
    /** gate: the host's own checks before a read (false skips it); beforeFrame: its task refresh (false stops). */
    async function poll(gate, beforeFrame) {
        if (polling || inputBusy || o.busy() || document.hidden)
            return;
        if (gate() === false)
            return;
        polling = true;
        let owner = view, gen = o.generation();
        try {
            if (lost) {
                await receipt();
                return;
            }
            if (await beforeFrame() === false)
                return;
            if (!view || o.busy())
                return;
            owner = view; gen = o.generation();
            const started = performance.now();
            if (started - lastRead < (own() ? 200 : 500) || started < retryAt)
                return;
            lastRead = started;
            const result = await o.request('getPageFrame', { schemaVersion: 1, viewId: owner.viewId });
            if (view !== owner || owner.closed || gen !== o.generation() || document.hidden)
                return;
            if (result.status.unknown) {
                lost = true;
                status(text.unresolved, true);
                o.render();
                return;
            }
            if (result.status.closed) {
                owner.closed = true;
                queue.length = 0;
                confirmedAt = -Infinity;
                status(text.confirmed);
                o.render();
                return;
            }
            if (result.frame) {
                const next = result.frame;
                const decoded = new Image();
                decoded.src = 'data:image/jpeg;base64,' + next.data;
                await decoded.decode();
                if (view !== owner || owner.closed || gen !== o.generation() || document.hidden)
                    return;
                // Only unsent wheel gestures may follow our scroll across page offsets. Other
                // input still belongs to the old image; navigation/resize/zoom never rebase it.
                const scrollOnly = wheelRefresh && frame?.documentGeneration === next.documentGeneration
                    && ['width', 'height', 'scale'].every(k => frame.viewport[k] === next.viewport[k])
                    && queue.every(e => e.kind === 'wheel' || e.kind === 'pointer' && e.type === 'mouseMoved');
                if (scrollOnly) {
                    for (let i = queue.length - 1; i >= 0; --i) if (queue[i].kind === 'pointer') queue.splice(i, 1);
                }
                if (queue.length && frame && !scrollOnly && (frame.documentGeneration !== next.documentGeneration || JSON.stringify(frame.viewport) !== JSON.stringify(next.viewport))) {
                    lost = true; queue.length = 0; status(text.confirmed, true); await close(); o.render(); return;
                }
                wheelRefresh = false;
                frame = next;
                confirmedAt = performance.now();
                captureAge = next.ageMs + performance.now() - started;
                image.src = decoded.src;
                image.hidden = false;
                o.empty.hidden = true;
                image.style.width = fitted ? '' : next.viewport.width + 'px';
                image.style.height = fitted ? '' : next.viewport.height + 'px';
                status(fresh() ? own() ? text.control : text.observe : text.stale);
                o.render();
            }
        }
        catch (e) {
            if (e?.code === 'QUOTA_EXCEEDED')
                retryAt = performance.now() + 1000;
            if (view === owner && !owner?.closed && gen === o.generation()
                && e?.code !== 'QUOTA_EXCEEDED' && e?.code !== 'CONFLICT' && e?.code !== 'STALE_REF')
                o.fail(e);
        }
        finally {
            polling = false;
            void flush();
        }
    }
    async function flush() {
        if (wheelRefresh || polling || inputBusy || !queue.length || !canInput())
            return;
        const event = queue.shift(), owner = view, lease = own(), gen = o.generation();
        const current = frame;
        inputBusy = true;
        const n = ++sequence;
        try {
            const result = await o.request('dispatchPageInput', { schemaVersion: 1, viewId: owner.viewId, frameId: current.frameId, leaseEpoch: lease.leaseEpoch, sequence: n, event });
            if (view !== owner || gen !== o.generation())
                return;
            if (result.state !== 'applied') {
                lost = true;
                queue.length = 0;
                status(result.state === 'unknown' ? text.unresolved : text.confirmed, true);
                o.render();
            }
            else if (event.kind === 'wheel') wheelRefresh = true;
        }
        catch (e) {
            queue.length = 0;
            if (!e?.known) {
                lost = true;
                status(text.unknown, true);
                o.render();
                void receipt().catch(o.fail);
            }
            else {
                lost = true;
                o.fail(e);
                if (e.code === 'STALE_REF' || e.code === 'STALE_LEASE' || e.code === 'CONFLICT')
                    status(text.confirmed, true);
            }
        }
        finally {
            inputBusy = false;
            if (view === owner)
                void flush();
        }
    }
    function enqueue(event) {
        if (!canInput())
            return;
        const last = queue[queue.length - 1];
        if (event.kind === 'pointer' && event.type === 'mouseMoved' && last?.kind === 'pointer' && last.type === 'mouseMoved')
            queue[queue.length - 1] = event;
        else if (event.kind === 'wheel' && last?.kind === 'wheel') {
            last.deltaX = Math.max(-4096, Math.min(4096, last.deltaX + event.deltaX));
            last.deltaY = Math.max(-4096, Math.min(4096, last.deltaY + event.deltaY));
        }
        else if (queue.length < 32)
            queue.push(event);
        else {
            lost = true;
            queue.length = 0;
            status(text.confirmed, true);
            void close().catch(o.fail);
            o.render();
            return;
        }
        void flush();
    }
    const mods = (e) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
    function point(e) {
        if (!frame)
            return null;
        const r = image.getBoundingClientRect(), ratio = Math.min(r.width / frame.pixelWidth, r.height / frame.pixelHeight);
        const width = frame.pixelWidth * ratio, height = frame.pixelHeight * ratio;
        const x = (e.clientX - r.left - (r.width - width) / 2) / width * frame.viewport.width;
        const y = (e.clientY - r.top - (r.height - height) / 2) / height * frame.viewport.height;
        return x >= 0 && y >= 0 && x < frame.viewport.width && y < frame.viewport.height ? { x, y } : null;
    }
    for (const [dom, type] of [['pointerdown', 'mousePressed'], ['pointerup', 'mouseReleased'], ['pointermove', 'mouseMoved']])
        image.addEventListener(dom, e => {
            if (!canInput())
                return;
            const p = point(e);
            if (!p)
                return;
            e.preventDefault();
            if (dom === 'pointerdown') {
                input.focus({ preventScroll: true });
                image.setPointerCapture(e.pointerId);
            }
            enqueue({ kind: 'pointer', type, ...p, button: dom === 'pointermove' ? 'none' : ['left', 'middle', 'right'][e.button] || 'none', buttons: e.buttons & 7, clickCount: dom === 'pointermove' ? 0 : Math.min(2, e.detail || 1), modifiers: mods(e) });
        });
    image.addEventListener('contextmenu', e => { if (canInput())
        e.preventDefault(); });
    image.addEventListener('wheel', e => {
        if (!canInput())
            return;
        const p = point(e);
        if (!p)
            return;
        e.preventDefault();
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? frame.viewport.height : 1;
        enqueue({ kind: 'wheel', ...p, deltaX: Math.max(-4096, Math.min(4096, e.deltaX * unit)), deltaY: Math.max(-4096, Math.min(4096, e.deltaY * unit)), modifiers: mods(e) });
    }, { passive: false });
    image.addEventListener('focus', () => { if (canInput())
        input.focus({ preventScroll: true }); });
    input.addEventListener('compositionstart', () => { composing = true; });
    input.addEventListener('compositionend', e => { composing = false; if (e.data)
        enqueue({ kind: 'text', text: e.data.slice(0, 1024) }); input.value = ''; });
    input.addEventListener('beforeinput', raw => {
        const e = raw;
        if (composing || e.isComposing || e.inputType === 'insertFromComposition')
            return;
        if (e.inputType === 'insertText' && e.data) {
            e.preventDefault();
            enqueue({ kind: 'text', text: e.data.slice(0, 1024) });
        }
    });
    input.addEventListener('paste', e => { if (!canInput())
        return; e.preventDefault(); const value = e.clipboardData?.getData('text/plain'); if (value)
        enqueue({ kind: 'text', text: value.slice(0, 1024) }); });
    input.addEventListener('input', () => { if (!composing)
        input.value = ''; });
    for (const type of ['keydown', 'keyup'])
        input.addEventListener(type, e => {
            if (composing || e.isComposing || e.key === 'Process' || e.key === 'Dead')
                return;
            if (!canInput()) {
                e.preventDefault();
                return;
            }
            const shortcut = e.ctrlKey || e.metaKey || e.altKey;
            if (e.code === 'KeyV' && (e.ctrlKey || e.metaKey))
                return; // let the native paste event deliver plain text exactly once
            if (e.key.length === 1 && !shortcut)
                return; // beforeinput/composition is the only printable text path
            e.preventDefault();
            keyModifiers = mods(e);
            if (type === 'keydown')
                keys.add(e.code);
            else
                keys.delete(e.code);
            enqueue({ kind: 'key', type: type === 'keydown' ? 'keyDown' : 'keyUp', key: e.key, code: e.code, modifiers: keyModifiers });
        });
    input.addEventListener('blur', () => {
        const owner = view;
        if (!owner || !own())
            return;
        owner.closed = true;
        queue.length = 0;
        keys.clear();
        o.render();
        void o.request('closePageView', { schemaVersion: 1, viewId: owner.viewId }).catch(o.fail);
    });
    return {
        own, fresh, paint, close, open, receipt, poll,
        view: () => view,
        lost: () => lost,
        inputBusy: () => inputBusy,
        clearLost: () => { lost = false; },
        clearQueue: () => { queue.length = 0; },
        /** A refused or failed request: nothing queued survives and the shown frame no longer counts as current. */
        halt: () => { queue.length = 0; confirmedAt = -Infinity; },
        /** Invalidates in-flight reads before a control change. */
        invalidate: () => { if (view) view.closed = true; },
        /** The stale check the host runs on its timer. */
        checkStale: () => { if (frame && !fresh()) {
            queue.length = 0;
            status(text.stale, true);
            o.render();
        } },
        toggleFit: () => { fitted = !fitted; o.viewport.classList.toggle('actual', !fitted); image.style.width = fitted || !frame ? '' : frame.viewport.width + 'px'; image.style.height = fitted || !frame ? '' : frame.viewport.height + 'px'; return fitted; },
    };
}
`
