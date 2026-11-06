/** Browser-only script; exercised in real Chrome without adding DOM globals to the Node CLI. */
export const remotePageClientScript = String.raw`/** Serialized into the isolated console document. All authority is enforced again by Runtime. */
function remotePageClient() {
    const w = window;
    w.__abpTaskAutoControls = 1;
    w.__abpPageView = 1;
    const query = new URLSearchParams(location.search);
    const sessionId = query.get('agentSessionId') || '';
    const lang = (query.get('lang') || navigator.language).slice(0, 2);
    const ko = lang === 'ko';
    document.documentElement.lang = ['ko', 'ja', 'zh'].includes(lang) ? lang : 'en';
    if (['light', 'dark'].includes(query.get('theme') || ''))
        document.documentElement.dataset.theme = query.get('theme');
    const text = lang === 'ja' ? {
        task: 'この会話のタスク', tab: 'ページ', take: '操作権を取得', release: '操作権を返す', resume: '続行', approve: '許可', reject: '拒否', fit: '画面に合わせる', retry: '再接続', stop: 'タスクを停止',
        waiting: 'この会話のブラウザページを待っています。', connecting: 'リモートMacに接続中…', observe: '閲覧中', control: '操作中', returning: '入力を終了しています…',
        stale: '画面の更新が遅れています。入力は停止中です。', expired: 'アクセス権が期限切れです。再接続してください。', forbidden: 'この会話のページにアクセスできません。',
        offline: '接続が切れました。以前の画面には入力できません。', unsupported: 'このMacはアプリ内の画面表示にまだ対応していません。', unknown: '入力結果を確認中です。同じ入力を繰り返さないでください。',
        unresolved: '入力結果を確認できないため、AIの続行を停止しました。', confirmed: '入力の処理状況を確認しました。再接続してください。', ended: 'タスクは終了しました。',
        hint: '操作権を取得してページをクリックすると入力できます。操作権を返して続行を押すとAIが再開します。', machine: 'リモートMac', image: 'この会話のリモートブラウザページ', input: 'ページへのテキスト入力',
    } : lang === 'zh' ? {
        task: '当前对话的任务', tab: '页面', take: '接管控制', release: '交还控制', resume: '继续', approve: '允许', reject: '拒绝', fit: '适应屏幕', retry: '重新连接', stop: '停止任务',
        waiting: '正在等待当前对话的浏览器页面。', connecting: '正在连接远程 Mac…', observe: '正在查看', control: '正在手动操作', returning: '正在结束输入…',
        stale: '画面更新延迟，已停止输入。', expired: '访问权限已过期，请重新连接。', forbidden: '无法访问当前对话的页面。',
        offline: '连接已断开，无法在旧画面上输入。', unsupported: '此 Mac 尚不支持在应用中显示页面。', unknown: '正在确认输入结果，请勿重复输入。',
        unresolved: '无法确认输入结果，已阻止 AI 继续。', confirmed: '已确认输入处理状态，请重新连接。', ended: '任务已结束。',
        hint: '接管控制后点击页面即可输入。交还控制并点击继续后，AI 将恢复工作。', machine: '远程 Mac', image: '当前对话的远程浏览器页面', input: '页面文本输入',
    } : ko ? {
        task: '현재 대화의 작업', tab: '페이지', take: '제어권 가져오기', release: '제어권 반납', resume: '계속 진행', approve: '허용', reject: '거절', fit: '화면 맞춤', retry: '다시 연결', stop: '작업 중단',
        waiting: '현재 대화의 브라우저 페이지를 기다리고 있어요.', connecting: '원격 Mac 화면에 연결 중…', observe: '관찰 중', control: '직접 조작 중', returning: '입력을 정리하는 중…',
        stale: '화면 갱신이 지연되고 있어요. 입력이 중지됐어요.', expired: '접근 권한이 만료됐어요. 다시 연결해 주세요.', forbidden: '이 대화의 페이지에 접근할 수 없어요.',
        offline: '연결이 끊겼어요. 이전 화면에서는 입력할 수 없어요.', unsupported: '이 원격 Mac은 앱 안 화면을 아직 지원하지 않아요.', unknown: '입력 결과를 확인 중이에요. 같은 입력을 다시 보내지 마세요.',
        unresolved: '입력 결과를 확인할 수 없어 AI 재개가 중지됐어요.', confirmed: '입력 처리 상태를 확인했어요. 다시 연결해 주세요.', ended: '작업이 종료됐어요.',
        hint: '제어권을 가져온 뒤 페이지를 클릭해 입력하세요. 반납 후 계속 진행을 누르면 AI가 이어서 작업해요.', machine: '원격 Mac', image: '현재 대화의 원격 브라우저 페이지', input: '페이지 텍스트 입력',
    } : {
        task: 'Current conversation task', tab: 'Page', take: 'Take control', release: 'Release control', resume: 'Continue', approve: 'Allow', reject: 'Reject', fit: 'Fit screen', retry: 'Reconnect', stop: 'Stop task',
        waiting: 'Waiting for a browser page in this conversation.', connecting: 'Connecting to remote Mac…', observe: 'Observing', control: 'You have control', returning: 'Draining page input…',
        stale: 'Page updates are delayed. Input is stopped.', expired: 'Access expired. Reconnect to continue.', forbidden: 'This conversation cannot access the page.',
        offline: 'Disconnected. Input on the previous image is stopped.', unsupported: 'This remote Mac does not support the in-app page view yet.', unknown: 'Checking input receipt. Do not repeat the input.',
        unresolved: 'Input outcome is unknown. AI continuation is blocked.', confirmed: 'Input receipt checked. Reconnect to continue.', ended: 'Task ended.',
        hint: 'Take control, then click the page to type. Release control and press Continue for AI to resume.', machine: 'Remote Mac', image: 'Remote browser page for this conversation', input: 'Page text input',
    };
    const $ = (id) => document.getElementById(id);
    const image = $('page');
    const input = $('input');
    const select = $('tasks');
    const tabs = $('tabs');
    for (const id of ['take', 'release', 'resume', 'approve', 'reject', 'fit', 'retry', 'stop'])
        $(id).textContent = text[id];
    $('taskLabel').textContent = text.task;
    $('tabLabel').textContent = text.tab;
    input.setAttribute('aria-label', text.input);
    $('hint').textContent = text.hint;
    $('empty').textContent = text.waiting;
    $('machine').textContent = query.get('machineName') || text.machine;
    image.alt = text.image;
    let token = '', expiry = 0, binding = '', task = null, view = null, frame = null;
    let generation = 0, sequence = 0, busy = false, polling = false, inputBusy = false, lost = false, composing = false, fitted = true;
    let confirmedAt = -Infinity, captureAge = 0, lastList = -Infinity, keyModifiers = 0;
    let wheelRefresh = false;
    const queue = [];
    const keys = new Set();
    const status = (value, error = false) => { $('status').textContent = value; $('status').dataset.error = String(error); };
    const clearImage = () => { frame = null; image.hidden = true; image.removeAttribute('src'); $('empty').hidden = false; confirmedAt = -Infinity; };
    const askHost = () => window.parent.postMessage({ type: 'abp-capability-request' }, location.origin);
    const claims = () => { try {
        return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(token.split('.')[2].replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))));
    }
    catch {
        return {};
    } };
    const request = async (op, body) => {
        const auth = token;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6000);
        try {
            const response = await fetch('/v1/ops/' + op, { method: 'POST', cache: 'no-store', signal: controller.signal,
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + auth }, body: JSON.stringify(body) });
            const result = await response.json();
            if (!response.ok || result.ok !== true)
                throw Object.assign(new Error('Page request refused'), { code: result.error?.code, known: true });
            return result.result;
        }
        finally {
            clearTimeout(timeout);
        }
    };
    const fail = (error) => {
        queue.length = 0;
        confirmedAt = -Infinity;
        status(error?.code === 'UNAUTHORIZED' ? text.expired : error?.code === 'SCOPE_DENIED' || error?.code === 'ORIGIN_DENIED' ? text.forbidden
            : error?.code === 'UNSUPPORTED_OPERATION' ? text.unsupported : error?.code === 'OUTCOME_UNKNOWN' ? text.unresolved : text.offline, true);
        render();
    };
    const own = () => {
        const c = claims();
        return task?.tabLeases?.find((l) => l.tabId === view?.tabId && l.owner.kind === 'user' && l.owner.viewerSessionId === c.viewerSessionId && l.owner.principalId === c.principalId);
    };
    const fresh = () => !!frame && performance.now() - confirmedAt + captureAge < 3000;
    const ended = () => ['succeeded', 'failed', 'cancelled'].includes(task?.status);
    const canInput = () => !!own() && fresh() && !busy && !lost && !ended() && !document.hidden && !view?.closed;
    function render() {
        const tabList = JSON.stringify(task?.tabs || []);
        if (tabs.dataset.list !== tabList) {
            tabs.textContent = '';
            for (const id of task?.tabs || []) {
                const option = document.createElement('option'); option.value = id; option.textContent = id; tabs.appendChild(option);
            }
            tabs.dataset.list = tabList;
        }
        if (view && tabs.value !== view.tabId) tabs.value = view.tabId;
        tabs.disabled = busy || inputBusy || !task?.tabs?.length;
        $('take').disabled = busy || lost || !fresh() || ended() || !view || !!own() || !!task?.uncertainActions?.length;
        $('release').disabled = busy || !own() || lost;
        $('resume').disabled = busy || lost || !fresh() || ended() || task?.pauseReason !== 'user-input-complete' || !!task?.uncertainActions?.length;
        $('stop').disabled = busy || ended() || !task;
        const approval = task?.pendingApproval;
        for (const id of ['approve', 'reject']) {
            $(id).hidden = !approval;
            $(id).disabled = busy;
        }
        $('viewport').classList.toggle('stale', !!frame && !fresh());
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
        if (old && token)
            await request('closePageView', { schemaVersion: 1, viewId: old.viewId });
    }
    async function openTask(next, selectedTab) {
        const gen = ++generation;
        busy = true;
        render();
        try {
            await close();
            if (gen !== generation)
                return;
            task = next;
            sequence = 0;
            if (ended()) {
                $('empty').textContent = text.ended;
                status(text.ended);
                return;
            }
            $('empty').textContent = text.waiting;
            if (!next?.tabs?.length) {
                status(text.waiting);
                return;
            }
            const tabId = next.tabs.includes(selectedTab) ? selectedTab : next.tabs[0];
            const opened = await request('openPageView', { schemaVersion: 1, agentSessionId: sessionId, runtimeBindingId: binding, taskId: next.taskId, tabId });
            if (gen !== generation) {
                await request('closePageView', { schemaVersion: 1, viewId: opened.viewId });
                return;
            }
            view = { ...opened, tabId };
            status(text.connecting);
        }
        catch (e) {
            if (gen === generation)
                fail(e);
        }
        finally {
            if (gen === generation) {
                busy = false;
                render();
            }
        }
    }
    async function list() {
        const gen = generation;
        const result = await request('listTasks', { profileId: claims().profileId });
        if (gen !== generation)
            return;
        const tasks = result.tasks.filter((t) => t.agentSessionId === sessionId);
        const previous = select.value;
        select.textContent = '';
        for (const t of tasks) {
            const option = document.createElement('option');
            option.value = t.taskId;
            option.textContent = t.taskId;
            select.appendChild(option);
        }
        if (tasks.some((t) => t.taskId === previous))
            select.value = previous;
        const next = tasks.find((t) => t.taskId === select.value);
        if (next?.taskId !== task?.taskId || !next?.tabs?.includes(view?.tabId) || view?.closed)
            await openTask(next);
        else if (next) {
            task = next;
            render();
        }
        else if (task || view)
            await openTask(null);
        lastList = performance.now();
    }
    async function refreshTask() {
        if (!task)
            return;
        const gen = generation, id = task.taskId;
        const next = await request('getTask', { taskId: id });
        if (gen === generation && task?.taskId === id) {
            task = next;
            render();
        }
    }
    async function receipt() {
        if (!view)
            return;
        const owner = view;
        const result = await request('getPageFrame', { schemaVersion: 1, viewId: owner.viewId, statusOnly: true });
        if (view !== owner)
            return;
        if (result.status.unknown) {
            status(text.unresolved, true);
            return;
        }
        if (!result.status.draining && result.status.lastSettled >= sequence)
            status(text.confirmed);
    }
    async function poll() {
        if (polling || inputBusy || busy || !token || document.hidden)
            return;
        if (Date.now() >= expiry - 30000)
            askHost();
        if (Date.now() >= expiry) {
            fail({ code: 'UNAUTHORIZED' });
            return;
        }
        if (!claims().pageViewScope)
            return;
        polling = true;
        let owner = view, gen = generation;
        try {
            if (lost) {
                await receipt();
                return;
            }
            if (performance.now() - lastList >= 1500)
                await list();
            if (ended()) {
                if (view) await close();
                $('empty').textContent = text.ended;
                status(text.ended); render(); return;
            }
            if (!view || busy)
                return;
            owner = view; gen = generation;
            const started = performance.now();
            const result = await request('getPageFrame', { schemaVersion: 1, viewId: owner.viewId });
            if (view !== owner || owner.closed || gen !== generation || document.hidden)
                return;
            if (result.status.unknown) {
                lost = true;
                status(text.unresolved, true);
                render();
                return;
            }
            if (result.status.closed) {
                owner.closed = true;
                queue.length = 0;
                confirmedAt = -Infinity;
                status(text.confirmed);
                render();
                return;
            }
            if (result.frame) {
                const next = result.frame;
                const decoded = new Image();
                decoded.src = 'data:image/jpeg;base64,' + next.data;
                await decoded.decode();
                if (view !== owner || owner.closed || gen !== generation || document.hidden)
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
                    lost = true; queue.length = 0; status(text.confirmed, true); await close(); render(); return;
                }
                wheelRefresh = false;
                frame = next;
                confirmedAt = performance.now();
                captureAge = next.ageMs + performance.now() - started;
                image.src = decoded.src;
                image.hidden = false;
                $('empty').hidden = true;
                image.style.width = fitted ? '' : next.viewport.width + 'px';
                image.style.height = fitted ? '' : next.viewport.height + 'px';
                status(fresh() ? own() ? text.control : text.observe : text.stale);
                render();
            }
        }
        catch (e) {
            if (view === owner && !owner?.closed && gen === generation
                && e?.code !== 'QUOTA_EXCEEDED' && e?.code !== 'CONFLICT' && e?.code !== 'STALE_REF')
                fail(e);
        }
        finally {
            polling = false;
            void flush();
        }
    }
    async function flush() {
        if (wheelRefresh || polling || inputBusy || !queue.length || !canInput())
            return;
        const event = queue.shift(), owner = view, lease = own(), gen = generation;
        const current = frame;
        inputBusy = true;
        const n = ++sequence;
        try {
            const result = await request('dispatchPageInput', { schemaVersion: 1, viewId: owner.viewId, frameId: current.frameId, leaseEpoch: lease.leaseEpoch, sequence: n, event });
            if (view !== owner || gen !== generation)
                return;
            if (result.state !== 'applied') {
                lost = true;
                queue.length = 0;
                status(result.state === 'unknown' ? text.unresolved : text.confirmed, true);
                render();
            }
            else if (event.kind === 'wheel') wheelRefresh = true;
        }
        catch (e) {
            queue.length = 0;
            if (!e?.known) {
                lost = true;
                status(text.unknown, true);
                render();
                void receipt().catch(fail);
            }
            else {
                lost = true;
                fail(e);
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
            void close().catch(fail);
            render();
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
    async function action(op, extra) {
        if (busy || !task)
            return;
        busy = true;
        queue.length = 0;
        render();
        const id = task.taskId;
        try {
            if (op === 'releaseControl') {
                if (view) view.closed = true; // invalidate in-flight reads before the release request
                status(text.returning);
            }
            const result = await request(op, { taskId: id, requestId: crypto.randomUUID(), ...extra });
            if (task?.taskId !== id)
                return;
            task = result.task || result;
            if (op === 'releaseControl') {
                await close();
                await openTask(task);
            }
            else
                await refreshTask();
        }
        catch (e) {
            fail(e);
        }
        finally {
            busy = false;
            render();
        }
    }
    $('take').onclick = () => { const tabId = view?.tabId; const epoch = task?.tabLeases?.find((l) => l.tabId === tabId)?.leaseEpoch; void action('takeOver', { tabId, expectedEpoch: epoch }); };
    $('release').onclick = () => { void action('releaseControl', { tabId: view?.tabId, expectedEpoch: own()?.leaseEpoch }); };
    $('resume').onclick = () => { void action('resume', { expectedVersion: task?.stateVersion }); };
    $('stop').onclick = () => { void action('cancel', {}); };
    for (const id of ['approve', 'reject'])
        $(id).onclick = () => { const approval = task?.pendingApproval; if (approval)
            void action('approve', { approvalId: approval.approvalId, bindingHash: approval.bindingHash, decision: id === 'approve' ? 'approve' : 'reject' }); };
    select.onchange = () => { const id = select.value; void request('getTask', { taskId: id }).then(openTask).catch(fail); };
    tabs.onchange = () => { if (!busy && !inputBusy) void openTask(task, tabs.value).catch(fail); };
    $('fit').onclick = () => { fitted = !fitted; $('viewport').classList.toggle('actual', !fitted); $('fit').setAttribute('aria-pressed', String(fitted)); image.style.width = fitted || !frame ? '' : frame.viewport.width + 'px'; image.style.height = fitted || !frame ? '' : frame.viewport.height + 'px'; };
    $('retry').onclick = () => { if (inputBusy || busy)
        return; ++generation; lost = false; busy = true; render();
        void close().catch(() => {}).finally(() => {
            token = ''; binding = ''; w.__abpPageViewBinding = null; lastList = -Infinity;
            busy = false; status(text.connecting); render(); askHost();
        }); };
    input.addEventListener('blur', () => {
        const owner = view;
        if (!owner || !own())
            return;
        owner.closed = true;
        queue.length = 0;
        keys.clear();
        render();
        void request('closePageView', { schemaVersion: 1, viewId: owner.viewId }).catch(fail);
    });
    document.addEventListener('visibilitychange', () => { queue.length = 0; if (document.hidden) {
        ++generation;
        void close().catch(fail);
    }
    else if (task && token)
        void openTask(task).catch(fail); });
    window.addEventListener('pagehide', () => { ++generation; queue.length = 0; void close().catch(() => { }); });
    window.addEventListener('message', event => {
        const d = event.data;
        if (event.source !== window.parent || event.origin !== location.origin || d?.type !== 'abp-capability' || typeof d.token !== 'string' || !Number.isSafeInteger(d.expiresAtMs))
            return;
        void (async () => {
            if (inputBusy)
                return; // renewal will be requested again; never replace a pending mutation's token
            const previous = token;
            token = d.token;
            expiry = d.expiresAtMs;
            const c = claims();
            if (!sessionId) {
                token = '';
                fail({ code: 'SCOPE_DENIED' });
                return;
            }
            if (!c.pageViewScope) {
                if (c.operations?.length !== 1 || c.operations[0] !== 'pageViewInfo') {
                    token = '';
                    fail({ code: 'SCOPE_DENIED' });
                    return;
                }
                const info = await request('pageViewInfo', { schemaVersion: 1, profileId: c.profileId });
                token = ''; // bootstrap never becomes the console's broad authority
                if (!info.supported || info.schemaVersion !== 1) {
                    fail({ code: 'UNSUPPORTED_OPERATION' });
                    return;
                }
                binding = info.runtimeBindingId;
                w.__abpPageViewBinding = binding;
                askHost();
                return;
            }
            if (c.pageViewScope.schemaVersion !== 1 || c.pageViewScope.agentSessionId !== sessionId || c.pageViewScope.runtimeBindingId !== binding) {
                token = '';
                fail({ code: 'SCOPE_DENIED' });
                return;
            }
            if (previous && view)
                await close();
            await list();
            if (task && !view)
                await openTask(task);
            void poll();
        })().catch(fail);
    });
    setInterval(() => { if (frame && !fresh()) {
        queue.length = 0;
        status(text.stale, true);
        render();
    } void poll(); }, 220);
    setInterval(() => { if (!token || Date.now() >= expiry - 60000)
        askHost(); }, 10000);
    status(text.connecting);
    render();
    askHost();
}

remotePageClient();`;
