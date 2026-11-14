import { mkdtemp, writeFile, chmod, readFile, access, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { launchChrome } from './pocTestKit'

let fixture: string | undefined
afterEach(async () => {
    vi.unstubAllEnvs()
    if (fixture) await rm(fixture, { recursive: true, force: true })
})

it.skipIf(process.platform === 'win32')('reports an early Chrome exit with stderr and removes the temporary profile', async () => {
    fixture = await mkdtemp(join(tmpdir(), 'chrome-launch-failure-'))
    const binary = join(fixture, 'chrome')
    const record = join(fixture, 'profile-path')
    await writeFile(binary, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(record)}, process.argv.find(arg => arg.startsWith('--user-data-dir=')).slice(16));\nconsole.error('synthetic Chrome startup failure');\nprocess.exit(23);\n`)
    await chmod(binary, 0o755)
    vi.stubEnv('CHROME_PATH', binary)

    await expect(launchChrome()).rejects.toThrow(/Chrome.*23[\s\S]*synthetic Chrome startup failure/)
    const profile = await readFile(record, 'utf8')
    await expect(access(profile)).rejects.toMatchObject({ code: 'ENOENT' })
}, 30_000)
