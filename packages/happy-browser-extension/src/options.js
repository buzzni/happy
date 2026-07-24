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
