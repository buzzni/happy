/**
 * One-shot Node script that asks Codex itself to rotate the ChatGPT login in `CODEX_HOME`
 * (app-server `account/read { refreshToken: true }`) and exits once Codex answered
 * (specs/codex-oauth-refresh-owner T6).
 *
 * app-server stops answering as soon as its stdin closes, so the request cannot ride on a one-shot
 * command's input; the credential command runner runs this script instead and keeps its timeout and
 * process-tree cleanup. Codex answers successfully even when the refresh failed, so the caller proves
 * the rotation by comparing the login file, never by this exit code alone.
 */
export const CODEX_LOGIN_REFRESH_DRIVER = `
const { spawn } = require('child_process')
const child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'], shell: process.platform === 'win32', windowsHide: true })
let buffer = '', done = false
const finish = (code, kind) => {
  if (done) return
  done = true
  if (kind) process.stderr.write(kind + '\\n')
  try { child.kill() } catch {}
  process.exit(code)
}
const send = message => child.stdin.write(JSON.stringify(message) + '\\n')
child.on('error', () => finish(3, 'CODEX_APP_SERVER_SPAWN_FAILED'))
child.on('exit', () => finish(4, 'CODEX_APP_SERVER_EXITED'))
child.stdin.on('error', () => finish(4, 'CODEX_APP_SERVER_EXITED'))
child.stdout.on('data', chunk => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\\n')) >= 0) {
    let message
    try { message = JSON.parse(buffer.slice(0, index)) } catch { message = null }
    buffer = buffer.slice(index + 1)
    if (!message) continue
    if (message.id === 1) {
      if (message.error) return finish(2, 'CODEX_APP_SERVER_INITIALIZE_FAILED')
      send({ method: 'initialized' })
      send({ id: 2, method: 'account/read', params: { refreshToken: true } })
    }
    if (message.id === 2) return finish(message.error ? 2 : 0, message.error ? 'CODEX_LOGIN_REFRESH_REFUSED' : '')
  }
})
send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'saycode-owner-refresh', version: '1' } } })
`
