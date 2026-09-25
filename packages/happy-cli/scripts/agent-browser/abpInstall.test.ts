import { spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { main as planMain, parseOptionFlags } from './abp-plan.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const SECRET_SENTINEL = 'SENTINEL-not-a-real-secret-0123456789'
let dir: string
let pemFile: string
let sitesFile: string

beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'abp-install-test-'))
    pemFile = join(dir, 'issuer.pem')
    sitesFile = join(dir, 'sites.json')
    writeFileSync(pemFile, generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString())
    writeFileSync(sitesFile, JSON.stringify([{ origin: 'https://shop.example' }]))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const bash = (script: string, args: string[]) => spawnSync('bash', [join(here, script), ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir, ABP_NODE: process.execPath, ABP_DRY_RUN_SECRET: SECRET_SENTINEL },
})

describe('abp-plan CLI', () => {
    it('parses install flags, reading issuer keys and the site policy from files', () => {
        const flags = parseOptionFlags(['--profile', 'main=user-1', '--profile', 'ops=user-2', '--issuer', `k1=${pemFile}`, '--sites', sitesFile, '--runtime-port', '38701', '--happy-prefix', '/opt/happy'])
        expect(flags.profiles).toEqual([{ profileId: 'main', principalId: 'user-1' }, { profileId: 'ops', principalId: 'user-2' }])
        expect(flags.issuers[0].publicKeyPem).toContain('BEGIN PUBLIC KEY')
        expect(flags).toMatchObject({ runtimePort: 38701, happyPrefix: '/opt/happy', sites: [{ origin: 'https://shop.example' }] })
        expect(() => parseOptionFlags(['--profile', 'main'])).toThrow(/<name>=<value>/)
        expect(() => parseOptionFlags(['--issuer', 'k1=/nonexistent/key.pem'])).toThrow(/unreadable/)
        expect(() => parseOptionFlags(['--bogus', 'x'])).toThrow(/unknown option/)
    })

    it('keeps the machine id "auto" until the agent has logged in to Happy', () => {
        let out = ''
        planMain(['install-options', '--saved', join(dir, 'missing.json'), '--workspace-id', 'w', '--profile', 'main=u', '--issuer', `k=${pemFile}`], (text: string) => { out += text })
        expect(JSON.parse(out).machineId).toBe('auto')
        const saved = join(dir, 'install.json')
        writeFileSync(saved, out)
        let resolved = ''
        planMain(['resolve-machine-id', '--install', saved, '--settings', join(dir, 'no-settings.json')], (text: string) => { resolved += text })
        expect(resolved).toBe('')
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({ machineId: 'machine-from-happy' }))
        planMain(['resolve-machine-id', '--install', saved, '--settings', join(dir, 'settings.json')], (text: string) => { resolved += text })
        expect(resolved).toBe('machine-from-happy\n')
    })
})

describe('abp-install --dry-run', () => {
    const run = () => bash('abp-install', ['--dry-run', 'install', '--machine-id', 'machine-1', '--workspace-id', 'ws-1', '--profile', 'main=user-1',
        '--issuer', `k1=${pemFile}`, '--sites', sitesFile, '--images', join(dir, 'images')])

    it('prints every action without needing root and exits 0', () => {
        const result = run()
        expect(result.stderr).not.toMatch(/abp-install: (?!warning)/)
        expect(result.status).toBe(0)
        for (const line of result.stdout.split('\n').filter(Boolean)) expect(line).toMatch(/^(\+ |== |    \| )/)
    })

    it('creates the accounts with the fixed container ids and the exact group memberships', () => {
        const out = run().stdout
        expect(out).toMatch(/\+ groupadd --system --gid 10870 abp-runtime/)
        expect(out).toMatch(/\+ useradd --system --uid 10870 --gid 10870 .* abp-runtime/)
        expect(out).toMatch(/\+ useradd --system --uid 10871 --gid 10871 .* abp-browser/)
        expect(out).toMatch(/\+ useradd --system .*--shell \/usr\/sbin\/nologin .*abp-proxy/)
        expect(out).toMatch(/\+ useradd --create-home --home-dir \/home\/agent-sbx .* agent-sbx/)
        expect(out).toMatch(/\+ useradd --create-home --home-dir \/home\/agent .*--shell \/bin\/bash .* agent/)
        expect(out).toContain('+ usermod -a -G abp-session,abp-work,agent-sbx agent')
        expect(out).toContain('+ usermod -G abp-work agent-sbx')
    })

    it('installs the S1 sandbox pieces with the documented modes and validates sudoers', () => {
        const out = run().stdout
        expect(out).toMatch(/\+ install -o root -g root -m 0755 \S+claude-sbx-launch \/usr\/local\/libexec\/abp\/claude-sbx-launch/)
        expect(out).toMatch(/\+ cc .*abp-firewall-read\.c/)
        expect(out).toMatch(/\+ install -o root -g abp-session -m 4750 \S+ \/usr\/local\/libexec\/abp\/abp-firewall-read/)
        expect(out).toMatch(/\+ visudo -cf \S+/)
        expect(out).toContain('+ write /etc/sudoers.d/abp-agent-sbx (root:root 0440')
        expect(out).toContain('    | agent ALL=(agent-sbx) NOPASSWD: /usr/local/libexec/abp/claude-sbx-launch 0')
        expect(out).toContain('+ write /etc/aplus/sandbox-policy.json (root:root 0644')
        expect(out).toContain('    |   "mode": "mandatory"')
    })

    it('writes the production runtime.json, firewall rules, units and daemon environment', () => {
        const out = run().stdout
        expect(out).toContain('+ write /etc/abp/runtime.json (root:root 0600')
        expect(out).toContain('    |   "authMode": "production",')
        expect(out).toContain('    |   "runtimePort": 38700,')
        expect(out).toContain('+ write /etc/abp/firewall.rules4 (root:root 0644')
        expect(out).toMatch(/ {4}\| -A OUTPUT -d 127\.0\.0\.1\/32 -p tcp -m owner --uid-owner \d+ -m tcp --dport 3128 -j ACCEPT/)
        expect(out).toContain('+ write /etc/systemd/system/abp-stack.service (root:root 0644')
        expect(out).toContain('+ write /etc/abp/happy-daemon.env (root:root 0644')
        expect(out).toContain('+ systemctl enable abp-firewall.service abp-egress-proxy.service abp-stack.service abp-happy-daemon.service')
        expect(out).toMatch(/\+ \S*node \S+abp-stack\.mjs load \S+images --set-initial/)
        expect(out).toContain('+ systemd-tmpfiles --create /etc/tmpfiles.d/abp.conf')
    })

    it('generates secrets only when missing and never prints them', () => {
        const result = run()
        expect(result.stdout).toContain('+ secret /var/lib/abp/daemon-token (agent:agent 0400) if missing')
        expect(result.stdout).toContain('+ secret /var/lib/abp/secrets/{runtime,browser}/vnc-password (same value; abp-runtime:root 0440, abp-browser:abp-browser 0400) if missing')
        expect(result.stdout + result.stderr).not.toContain(SECRET_SENTINEL)
    })

    it('refuses invalid options before any action', () => {
        const result = bash('abp-install', ['--dry-run', 'install', '--machine-id', 'm', '--workspace-id', 'w', '--profile', 'BAD=u', '--issuer', `k1=${pemFile}`])
        expect(result.status).not.toBe(0)
        expect(result.stderr).toMatch(/profileId/)
        expect(result.stdout).not.toMatch(/useradd/)
    })
})

describe('abp-uninstall --dry-run', () => {
    it('keeps profile and journal volumes, configuration and secrets unless --purge', () => {
        const kept = bash('abp-uninstall', ['--dry-run'])
        expect(kept.status).toBe(0)
        expect(kept.stdout).toMatch(/\+ systemctl disable --now abp-happy-daemon\.service/)
        expect(kept.stdout).toMatch(/\+ \/usr\/local\/libexec\/abp\/abp-firewall remove/)
        expect(kept.stdout).not.toMatch(/volume rm|rm -rf \/etc\/abp|rm -rf \/var\/lib\/abp/)
        const purged = bash('abp-uninstall', ['--dry-run', '--purge'])
        expect(purged.status).toBe(0)
        expect(purged.stdout).toMatch(/docker volume rm/)
        expect(purged.stdout).toMatch(/\+ rm -rf \/etc\/abp \/var\/lib\/abp/)
    })
})

const shellcheck = spawnSync('shellcheck', ['--version']).status === 0
describe.skipIf(!shellcheck)('shellcheck', () => {
    it('passes for every shell script', () => {
        const result = spawnSync('shellcheck', ['-x', ...['abp-install', 'abp-uninstall', 'abp-firewall', 'images/browser-entrypoint.sh'].map((file) => join(here, file))], { encoding: 'utf8' })
        expect(result.stdout + result.stderr).toBe('')
        expect(result.status).toBe(0)
    })
})
