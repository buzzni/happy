/**
 * HTML fallback served by the preview relay when the URL's ptoken is missing
 * or expired AND the request looks like a top-level browser navigation
 * (Accept: text/html). Lets the user recover without re-opening the iframe
 * from the web-ui by client-side calling /api/preview-mint-remote (Phase 10b
 * helper) and redirecting.
 *
 * Pure renderer. The inline JS:
 *   1. Spend one attempt from a small burst budget kept in sessionStorage,
 *      and bail with a manual recovery message when it is exhausted —
 *      prevents an infinite loop when mint keeps succeeding but the relay
 *      keeps 401-ing. The budget ages out (see MINT_WINDOW_MS) so an ordinary
 *      second or third dev-server restart later in the same tab still
 *      recovers by itself; a once-per-tab guard would leave that tab dead.
 *   2. Read aplus-token + aplus-active-company from localStorage (web-ui SPA
 *      conventions, see packages/web-ui/src/lib/store/index.ts:480,491).
 *   3. POST /api/preview-mint-remote (relative URL — routes through whatever
 *      origin served this HTML, which when delivered via the vite proxy is
 *      the web-ui where the mint endpoint lives).
 *   4. On success, replace ptoken in current URL and reload.
 *   5. On failure or no aplus-token, show a manual recovery message.
 *
 * See specs/remote-preview-relay/ Phase 10c.
 */

export interface ExpiredPtokenHtmlParams {
    machineId: string;
    port: number;
    /**
     * Why the relay rejected the token. Affects the user-facing copy but the
     * recovery flow is identical.
     *   - 'missing'           — no ptoken (URL/cookie/Authorization) at all.
     *   - 'expired-or-invalid' — verifyPreviewToken returned null (either TTL
     *                            elapsed or signature mismatch).
     */
    reason: 'missing' | 'expired-or-invalid';
}

/**
 * The page re-mints and then *reloads the URL it was served for*, so it may
 * only be given to something that can act on it and for which a reload is
 * harmless: a GET navigation.
 *
 * - A subresource (script/style/image/XHR) would either render as garbage or,
 *   worse, run the re-mint inside the previewed app's own origin. `Accept`
 *   alone does not separate those — an XHR can ask for text/html — so
 *   `Sec-Fetch-Dest` decides whenever the browser sends it.
 * - A mutation must never get it: reloading after a POST re-issues the POST.
 */
export interface ExpiredHtmlRequest {
    method: string;
    accept?: string;
    secFetchDest?: string;
    secFetchMode?: string;
}

const NAVIGATION_DESTINATIONS = new Set(['document', 'iframe', 'frame', 'nested-document']);

export function shouldServeExpiredHtml(request: ExpiredHtmlRequest): boolean {
    if (request.method.toUpperCase() !== 'GET') return false;
    const dest = request.secFetchDest?.trim().toLowerCase();
    if (dest) return NAVIGATION_DESTINATIONS.has(dest);
    // No Sec-Fetch-Dest (older browser, non-browser client): fall back to the
    // Accept header, which is what this gate used before.
    if (request.secFetchMode && request.secFetchMode.trim().toLowerCase() !== 'navigate') return false;
    return (request.accept ?? '').toLowerCase().includes('text/html');
}

/**
 * JSON-encode a string for safe embedding inside a `<script>` block. Escapes
 * `</` so an attacker-controlled string cannot close the script tag, and
 * relies on JSON's normal escaping for quotes/newlines/etc.
 */
function jsString(value: string): string {
    return JSON.stringify(value).replace(/<\/(?=script)/gi, '<\\/');
}

export function renderExpiredPtokenHtml(params: ExpiredPtokenHtmlParams): string {
    const heading =
        params.reason === 'missing'
            ? '프리뷰 세션이 필요합니다'
            : '프리뷰 세션이 만료되었습니다';
    const subtitle =
        params.reason === 'missing'
            ? 'ptoken 없이 접근되었습니다. 자동으로 새 토큰을 발급하는 중입니다…'
            : '토큰 유효 기간이 지났습니다. 자동으로 새 토큰을 발급하는 중입니다…';

    const machineIdLiteral = jsString(params.machineId);
    const portLiteral = String(Number.isInteger(params.port) ? params.port : 0);

    // Inline script — no external deps. Uses sessionStorage to gate against
    // an infinite redirect loop (1 attempt per tab/page-load) and falls back
    // to a manual recovery message when mint cannot succeed.
    const script = `
(function () {
  var statusEl = document.getElementById('status');
  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }
  var MINT_KEY = 'aplus-preview-mint-attempted-' + ${machineIdLiteral} + '-' + ${portLiteral};
  // Burst budget, not a one-shot latch: a dev server that restarts twice in a
  // session is ordinary, and each restart must be able to recover on its own.
  // What must not happen is a tight loop where mint keeps succeeding and the
  // relay keeps refusing, so the budget is small and only resets once the
  // window has passed without another attempt.
  var MINT_MAX_ATTEMPTS = 3;
  var MINT_WINDOW_MS = 60000;
  var now = Date.now();
  var spent = 0;
  try {
    var raw = sessionStorage.getItem(MINT_KEY);
    if (raw) {
      var record = JSON.parse(raw);
      if (record && typeof record.n === 'number' && typeof record.t === 'number'
        && now - record.t < MINT_WINDOW_MS) {
        spent = record.n;
      }
    }
    if (spent >= MINT_MAX_ATTEMPTS) {
      setStatus('자동 재발급이 반복적으로 실패했습니다. aplus-dev-studio 웹에서 프로젝트를 다시 열어 주세요.');
      return;
    }
    sessionStorage.setItem(MINT_KEY, JSON.stringify({ n: spent + 1, t: now }));
  } catch (e) {
    // sessionStorage unavailable (e.g., privacy mode) — continue without loop guard.
  }
  var aplusToken;
  try {
    aplusToken = localStorage.getItem('aplus-token');
  } catch (e) {
    aplusToken = null;
  }
  if (!aplusToken) {
    setStatus('aplus-dev-studio 웹 로그인이 필요합니다. 새 탭에서 웹을 연 뒤 다시 시도해 주세요.');
    return;
  }
  var activeCompanyId = null;
  try {
    activeCompanyId = localStorage.getItem('aplus-active-company') || null;
  } catch (e) {
    activeCompanyId = null;
  }
  fetch('/api/preview-mint-remote', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + aplusToken,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      machineId: ${machineIdLiteral},
      port: ${portLiteral},
      activeCompanyId: activeCompanyId
    })
  }).then(function (res) {
    return res.json().then(function (data) { return { status: res.status, data: data }; });
  }).then(function (r) {
    if (r.status !== 200 || !r.data || typeof r.data.token !== 'string') {
      var msg = (r.data && r.data.error) ? r.data.error : ('status ' + r.status);
      setStatus('재발급 실패: ' + msg);
      return;
    }
    var u = new URL(location.href);
    u.searchParams.set('ptoken', r.data.token);
    location.replace(u.toString());
  }).catch(function (e) {
    setStatus('네트워크 오류: ' + (e && e.message ? e.message : String(e)));
  });
})();`.trim();

    return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>프리뷰 토큰 재발급</title>
<style>
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; padding: 2rem; color: #333; line-height: 1.6; }
  h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
  p { margin: 0.25rem 0; color: #555; }
  #status { margin-top: 1rem; padding: 0.75rem 1rem; background: #f6f6f6; border-radius: 0.25rem; color: #444; }
</style>
</head>
<body>
<h1>${heading}</h1>
<p>${subtitle}</p>
<div id="status">자동 재발급 중…</div>
<script>${script}</script>
</body>
</html>`;
}
