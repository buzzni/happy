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
    let token = '', expiry = 0, binding = '', task = null;
    let generation = 0, busy = false, lastList = -Infinity;
    const status = (value, error = false) => { $('status').textContent = value; $('status').dataset.error = String(error); };
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
        viewer.halt();
        status(error?.code === 'UNAUTHORIZED' ? text.expired : error?.code === 'SCOPE_DENIED' || error?.code === 'ORIGIN_DENIED' ? text.forbidden
            : error?.code === 'UNSUPPORTED_OPERATION' ? text.unsupported : error?.code === 'OUTCOME_UNKNOWN' ? text.unresolved : text.offline, true);
        render();
    };
    const ended = () => ['succeeded', 'failed', 'cancelled'].includes(task?.status);
    const viewer = createPageViewer({ request, image, input, viewport: $('viewport'), empty: $('empty'), text, status, fail, render: () => render(),
        task: () => task, ended, identity: claims, busy: () => busy, generation: () => generation, token: () => token });
    const own = viewer.own, fresh = viewer.fresh;
    function render() {
        const view = viewer.view(), lost = viewer.lost();
        const tabList = JSON.stringify(task?.tabs || []);
        if (tabs.dataset.list !== tabList) {
            tabs.textContent = '';
            for (const id of task?.tabs || []) {
                const option = document.createElement('option'); option.value = id; option.textContent = id; tabs.appendChild(option);
            }
            tabs.dataset.list = tabList;
        }
        if (view && tabs.value !== view.tabId) tabs.value = view.tabId;
        tabs.disabled = busy || viewer.inputBusy() || !task?.tabs?.length;
        $('take').disabled = busy || lost || !fresh() || ended() || !view || !!own() || !!task?.uncertainActions?.length;
        $('release').disabled = busy || !own() || lost;
        $('resume').disabled = busy || lost || !fresh() || ended() || task?.pauseReason !== 'user-input-complete' || !!task?.uncertainActions?.length;
        $('stop').disabled = busy || ended() || !task;
        const approval = task?.pendingApproval;
        for (const id of ['approve', 'reject']) {
            $(id).hidden = !approval;
            $(id).disabled = busy;
        }
        viewer.paint();
    }
    const close = viewer.close;
    async function openTask(next, selectedTab) {
        const gen = ++generation;
        busy = true;
        render();
        try {
            await close();
            if (gen !== generation)
                return;
            task = next;
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
            await viewer.open({ agentSessionId: sessionId, runtimeBindingId: binding, taskId: next.taskId }, tabId, () => gen === generation);
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
        const view = viewer.view();
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
    function poll() {
        return viewer.poll(() => {
            if (!token)
                return false;
            if (Date.now() >= expiry - 30000)
                askHost();
            if (Date.now() >= expiry) {
                fail({ code: 'UNAUTHORIZED' });
                return false;
            }
            if (!claims().pageViewScope)
                return false;
        }, async () => {
            if (performance.now() - lastList >= 1500)
                await list();
            if (ended()) {
                if (viewer.view()) await close();
                $('empty').textContent = text.ended;
                status(text.ended); render(); return false;
            }
        });
    }
    async function action(op, extra) {
        if (busy || !task)
            return;
        busy = true;
        viewer.clearQueue();
        render();
        const id = task.taskId;
        try {
            if (op === 'releaseControl') {
                viewer.invalidate(); // invalidate in-flight reads before the release request
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
    $('take').onclick = () => { const tabId = viewer.view()?.tabId; const epoch = task?.tabLeases?.find((l) => l.tabId === tabId)?.leaseEpoch; void action('takeOver', { tabId, expectedEpoch: epoch }); };
    $('release').onclick = () => { void action('releaseControl', { tabId: viewer.view()?.tabId, expectedEpoch: own()?.leaseEpoch }); };
    $('resume').onclick = () => { void action('resume', { expectedVersion: task?.stateVersion }); };
    $('stop').onclick = () => { void action('cancel', {}); };
    for (const id of ['approve', 'reject'])
        $(id).onclick = () => { const approval = task?.pendingApproval; if (approval)
            void action('approve', { approvalId: approval.approvalId, bindingHash: approval.bindingHash, decision: id === 'approve' ? 'approve' : 'reject' }); };
    select.onchange = () => { const id = select.value; void request('getTask', { taskId: id }).then(openTask).catch(fail); };
    tabs.onchange = () => { if (!busy && !viewer.inputBusy()) void openTask(task, tabs.value).catch(fail); };
    $('fit').onclick = () => { $('fit').setAttribute('aria-pressed', String(viewer.toggleFit())); };
    $('retry').onclick = () => { if (viewer.inputBusy() || busy)
        return; ++generation; viewer.clearLost(); busy = true; render();
        void close().catch(() => {}).finally(() => {
            token = ''; binding = ''; w.__abpPageViewBinding = null; lastList = -Infinity;
            busy = false; status(text.connecting); render(); askHost();
        }); };
    document.addEventListener('visibilitychange', () => { viewer.clearQueue(); if (document.hidden) {
        ++generation;
        void close().catch(fail);
    }
    else if (task && token)
        void openTask(task).catch(fail); });
    window.addEventListener('pagehide', () => { ++generation; viewer.clearQueue(); void close().catch(() => { }); });
    window.addEventListener('message', event => {
        const d = event.data;
        if (event.source !== window.parent || event.origin !== location.origin || d?.type !== 'abp-capability' || typeof d.token !== 'string' || !Number.isSafeInteger(d.expiresAtMs))
            return;
        void (async () => {
            if (viewer.inputBusy())
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
            if (previous && viewer.view())
                await close();
            await list();
            if (task && !viewer.view())
                await openTask(task);
            void poll();
        })().catch(fail);
    });
    setInterval(() => { viewer.checkStale(); void poll(); }, 220);
    setInterval(() => { if (!token || Date.now() >= expiry - 60000)
        askHost(); }, 10000);
    status(text.connecting);
    render();
    askHost();
}

remotePageClient();`;
