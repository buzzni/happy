/**
 * aplus-dev-studio specs/agent-plan-full-capability R4 — the plan's Codex `-c` arguments carry double quotes
 * (`model_provider="saycode-plan"`, a JSON-quoted base URL). Codex is started through cross-spawn; on Windows an
 * npm-installed `codex.cmd` shim goes through cmd.exe, whose escaping is where quotes get lost. This spawns a
 * stand-in the same way and checks every argument arrives byte for byte. Runs on the Windows CI job too.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn as crossSpawn } from 'cross-spawn'
import { afterEach, describe, expect, it } from 'vitest'
import { agentPlanCodexArgs, buildAgentPlanDescriptor } from './agentPlanLaunch'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

/** A stand-in for Codex that prints the argv it received as JSON. On Windows it sits behind a `.cmd` shim like npm's. */
function standIn(): string {
    const dir = mkdtempSync(join(tmpdir(), 'plan-argv-'))
    dirs.push(dir)
    const script = join(dir, 'echo-argv.cjs')
    writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
    if (process.platform !== 'win32') return script
    const shim = join(dir, 'codex.cmd')
    writeFileSync(shim, `@"${process.execPath}" "${script}" %*\r\n`)
    return shim
}

function received(command: string, args: string[]): Promise<string[]> {
    return new Promise((resolve, reject) => {
        const child = process.platform === 'win32'
            ? crossSpawn(command, args, { windowsHide: true })
            : crossSpawn(process.execPath, [command, ...args])
        let out = ''
        child.stdout!.on('data', (chunk) => { out += chunk })
        child.on('error', reject)
        child.on('close', (code) => code === 0 ? resolve(JSON.parse(out) as string[]) : reject(new Error(`exit ${code}`)))
    })
}

describe('agent plan Codex arguments', () => {
    it('reach Codex unchanged through cross-spawn, including the Windows .cmd shim', async () => {
        const descriptor = buildAgentPlanDescriptor({ origin: 'https://saycode.example', grantId: '3f1c2a4e-1b2c-4d5e-8f90-123456789abc', model: 'gpt-6-luna' })!
        const args = ['app-server', ...agentPlanCodexArgs(descriptor, 'http://127.0.0.1:51234/v1')]
        expect(args.some(arg => arg.includes('"'))).toBe(true)
        expect(await received(standIn(), args)).toEqual(args)
    })
})
