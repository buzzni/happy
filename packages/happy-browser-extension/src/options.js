import { parseAllowlist } from './allowlist.js'

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

document.getElementById('save').addEventListener('click', async () => {
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
})

// The debugger tier. chrome.permissions.request only works from a user
// gesture on an extension page, which is exactly why the agent cannot grant
// itself this — same property the allowlist depends on.
const DEBUGGER_PERMISSION = { permissions: ['debugger'] }
const debuggerButton = document.getElementById('toggle-debugger')
const debuggerStatus = document.getElementById('debugger-status')

async function renderDebuggerState() {
    const granted = await chrome.permissions.contains(DEBUGGER_PERMISSION)
    debuggerButton.textContent = granted ? '정밀 제어 끄기' : '정밀 제어 켜기'
    debuggerStatus.textContent = granted
        ? '켜짐 — trusted 입력과 전체 페이지 스크린샷을 쓸 수 있습니다.'
        : '꺼짐 — 나머지 기능은 그대로 동작합니다.'
    return granted
}

debuggerButton.addEventListener('click', async () => {
    const granted = await chrome.permissions.contains(DEBUGGER_PERMISSION)
    if (granted) {
        await chrome.permissions.remove(DEBUGGER_PERMISSION)
    } else {
        await chrome.permissions.request(DEBUGGER_PERMISSION)
    }
    await renderDebuggerState()
})

await renderDebuggerState()
