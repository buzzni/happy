import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runAiCredentialCommand } from './aiCredentialRuntime'
import { CODEX_LOGIN_REFRESH_DRIVER } from './codexLoginRefreshDriver'

// A stand-in `codex app-server`: records what it was asked and answers like Codex does.
const fakeCodex = (answer: 'ok' | 'error' | 'exit') => `#!/usr/bin/env node
const fs = require('fs'), path = require('path')
if (${JSON.stringify(answer)} === 'exit') process.exit(0)
let buffer = ''
process.stdin.on('data', chunk => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const message = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1)
    fs.appendFileSync(path.join(process.env.CODEX_HOME, 'requests.log'), JSON.stringify({ args: process.argv.slice(2), message }) + '\\n')
    if (message.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\\n')
    if (message.id === 2) process.stdout.write(JSON.stringify(${JSON.stringify(answer)} === 'ok'
      ? { id: 2, result: { account: null } } : { id: 2, error: { code: -32000, message: 'refresh failed' } }) + '\\n')
  }
})
`

describe.skipIf(process.platform === 'win32')('Codex login refresh driver', () => {
  const directories: string[] = []
  afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })

  async function run(answer: 'ok' | 'error' | 'exit') {
    const bin = await mkdtemp(join(tmpdir(), 'codex-refresh-bin-'))
    const home = await mkdtemp(join(tmpdir(), 'codex-refresh-home-'))
    directories.push(bin, home)
    await writeFile(join(bin, 'codex'), fakeCodex(answer))
    await chmod(join(bin, 'codex'), 0o755)
    const result = runAiCredentialCommand(process.execPath, ['-e', CODEX_LOGIN_REFRESH_DRIVER], {
      environment: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, CODEX_HOME: home },
      timeoutMs: 20_000,
    })
    return { result, requests: async () => (await readFile(join(home, 'requests.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)) }
  }

  it('asks the app-server of this CODEX_HOME for one proactive refresh and waits for its answer', async () => {
    const { result, requests } = await run('ok')
    await expect(result).resolves.toBeDefined()
    const sent = await requests()
    expect(sent.every(request => request.args.join(' ') === 'app-server')).toBe(true)
    expect(sent.map(request => request.message.method)).toEqual(['initialize', 'initialized', 'account/read'])
    expect(sent[2].message.params).toEqual({ refreshToken: true })
  })

  it('fails when Codex refuses the refresh request', async () => {
    await expect((await run('error')).result).rejects.toThrow()
  })

  it('fails when Codex exits before answering', async () => {
    await expect((await run('exit')).result).rejects.toThrow()
  })
})
