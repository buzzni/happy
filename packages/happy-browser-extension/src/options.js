import { parseAllowlist } from './allowlist.js'
import { parseAutoConnectParams } from './autoConnect.js'

const portInput = document.getElementById('port')
const tokenInput = document.getElementById('token')
const profileInput = document.getElementById('profile')
const allowlistInput = document.getElementById('allowlist')
const status = document.getElementById('status')

const stored = await chrome.storage.local.get(['port', 'token', 'profile', 'allowlist'])
portInput.value = stored.port || 41777
tokenInput.value = stored.token || ''
profileInput.value = stored.profile || 'default'
allowlistInput.value = stored.allowlist || ''

async function save() {
    const token = tokenInput.value.trim()
    if (!token) {
        status.textContent = '토큰을 입력해 주세요.'
        return
    }
    const allowlist = allowlistInput.value
    // The service worker watches storage and reconnects on change.
    await chrome.storage.local.set({
        port: Number(portInput.value) || 41777,
        token,
        profile: profileInput.value.trim() || 'default',
        allowlist,
    })

    // Say plainly which of the two very different modes is now in force —
    // "unrestricted" is the riskier one and should never be a silent default
    // the user didn't realise they were in.
    const patterns = parseAllowlist(allowlist)
    status.textContent = patterns.length === 0
        ? '저장했습니다. allowlist가 비어 있어 모든 사이트를 제어할 수 있습니다.'
        : `저장했습니다. ${patterns.length}개 패턴만 허용됩니다: ${patterns.join(', ')}`
}

document.getElementById('save').addEventListener('click', save)

// `happy browser` prints a chrome-extension://<id>/src/options.html?token=...
// link so first-time setup is "open link" instead of "copy token, switch to
// this tab, paste, save". The token still came from a link the user chose to
// open, so auto-saving it is no riskier than them pasting it themselves.
const autoConnect = parseAutoConnectParams(location.search)
if (autoConnect) {
    tokenInput.value = autoConnect.token
    portInput.value = autoConnect.port
    // Scrub the token from the visible URL / this navigation's history entry
    // right away — nothing downstream needs it to stay there.
    history.replaceState(null, '', location.pathname)
    await save()
    status.textContent = `링크로 자동 연결되었습니다. ${status.textContent}`
}

// The debugger tier is gated by a stored setting, not an optional Chrome
// permission: Chrome does not allow `debugger` in optional_permissions (it is
// on the documented exclusion list), so requesting it at runtime fails with
// "Only permissions specified in the manifest may be requested". See cdp.js
// for the full reasoning. The agent has no command that writes extension
// storage, so it still cannot switch this on for itself.
const debuggerButton = document.getElementById('toggle-debugger')
const debuggerStatus = document.getElementById('debugger-status')
let debuggerEnabled = false

function renderDebuggerState(enabled) {
    debuggerEnabled = enabled
    debuggerButton.textContent = enabled ? '정밀 제어 끄기' : '정밀 제어 켜기'
    debuggerStatus.textContent = enabled
        ? '켜짐 — trusted 입력과 전체 페이지 스크린샷을 쓸 수 있습니다.'
        : '꺼짐 — 나머지 기능은 그대로 동작합니다.'
}

debuggerButton.addEventListener('click', async () => {
    try {
        const next = !debuggerEnabled
        await chrome.storage.local.set({ debuggerTier: next })
        renderDebuggerState(next)
    } catch (e) {
        debuggerStatus.textContent = `오류: ${e.message}`
    }
})

renderDebuggerState((await chrome.storage.local.get(['debuggerTier'])).debuggerTier === true)
