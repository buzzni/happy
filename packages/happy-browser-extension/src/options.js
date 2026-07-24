const portInput = document.getElementById('port')
const tokenInput = document.getElementById('token')
const profileInput = document.getElementById('profile')
const status = document.getElementById('status')

const stored = await chrome.storage.local.get(['port', 'token', 'profile'])
portInput.value = stored.port || 41777
tokenInput.value = stored.token || ''
profileInput.value = stored.profile || 'default'

document.getElementById('save').addEventListener('click', async () => {
    const token = tokenInput.value.trim()
    if (!token) {
        status.textContent = '토큰을 입력해 주세요.'
        return
    }
    // The service worker watches storage and reconnects on change.
    await chrome.storage.local.set({
        port: Number(portInput.value) || 41777,
        token,
        profile: profileInput.value.trim() || 'default',
    })
    status.textContent = '저장했습니다. 데몬에 연결을 시도합니다.'
})
