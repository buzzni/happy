import { spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
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
        expect(out).toContain('+ systemctl enable abp-firewall.service abp-egress.service abp-egress-proxy.service abp-stack.service abp-happy-daemon.service')
        expect(out).toContain('+ write /etc/abp/egress.rules4 (root:root 0644')
        expect(out).toMatch(/ {4}\| jump DOCKER-USER -i br-abp\+ -j ABP-EGRESS/)
        expect(out).toContain('+ systemctl restart abp-egress.service')
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
        const other = bash('abp-install', ['--dry-run', 'install', '--machine-id', 'm', '--workspace-id', 'w', '--profile', 'ops=u', '--issuer', `k1=${pemFile}`])
        expect(other.status).not.toBe(0)
        expect(other.stderr).toMatch(/exactly one profile named main/)
        expect(other.stdout).not.toMatch(/useradd/)
    })
})

/**
 * safe_path refuses paths below directories that others may write (e.g. /tmp, 1777), so its
 * fixtures must live below a directory whose whole ancestor chain passes the same rule: owned by
 * root or this user, not group/other-writable, no symlinks. The first such candidate is used.
 */
function trustedBase(): string | undefined {
    const uid = userInfo().uid
    const passes = (dir: string): boolean => {
        for (let current = dir; ; current = dirname(current)) {
            const stat = lstatSync(current)
            if (stat.isSymbolicLink() || (stat.uid !== 0 && stat.uid !== uid) || (stat.mode & 0o022)) return false
            if (current === '/') return true
        }
    }
    for (const candidate of [tmpdir(), homedir(), here]) {
        try {
            const real = realpathSync(candidate)
            if (passes(real)) return real
        } catch { /* try the next one */ }
    }
    return undefined
}
const fixtureBase = trustedBase()

describe.skipIf(!fixtureBase)('abp-install internals (sourced; needs a directory with a trusted ancestor chain)', () => {
    /** Runs a snippet with abp-install's functions loaded (main does not run when sourced). */
    const sourced = (snippet: string) => spawnSync('bash', ['-c', `set -euo pipefail; source "$1"; DRY_RUN=0; ${snippet}`, 'test', join(here, 'abp-install')], {
        encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, ABP_NODE: process.execPath },
    })
    const me = spawnSync('id', ['-un'], { encoding: 'utf8' }).stdout.trim()
    const group = spawnSync('id', ['-gn'], { encoding: 'utf8' }).stdout.trim()

    it('never pipes into write_file (a pipeline runs it in a subshell and loses the change record)', () => {
        const source = readFileSync(join(here, 'abp-install'), 'utf8')
        expect(source.split('\n').filter((line) => /\|\s*write_file\b/.test(line) && !line.trim().startsWith('#'))).toEqual([])
    })

    it('records a changed file in the parent shell and not an unchanged one, so restarts follow real changes', () => {
        const root = mkdtempSync(join(fixtureBase!, '.abp-emit-'))
        chmodSync(root, 0o755)
        const target = join(root, 'config.json')
        const result = sourced(`
            emit() { printf '%s' "$4" > "$WORK/x"; write_file "$1" "$2" "$3" 0600 < "$WORK/x"; }
            WORK=$(mktemp -d)
            emit ${target} ${me} ${group} one; changed ${target} && echo first-changed
            CHANGED=" "; emit ${target} ${me} ${group} one; changed ${target} || echo second-unchanged
            CHANGED=" "; emit ${target} ${me} ${group} two; changed ${target} && echo third-changed`)
        expect(result.stderr).toBe('')
        expect(result.stdout.split('\n').filter(Boolean)).toEqual(['first-changed', 'second-unchanged', 'third-changed'])
        expect(readFileSync(target, 'utf8')).toBe('two')
        rmSync(root, { recursive: true, force: true })
    })

    it('refuses to write through a symlink, under a symlinked or group-writable directory', () => {
        const root = mkdtempSync(join(fixtureBase!, '.abp-path-'))
        chmodSync(root, 0o755)
        mkdirSync(join(root, 'real'), { mode: 0o755 })
        writeFileSync(join(root, 'elsewhere'), 'x')
        symlinkSync(join(root, 'elsewhere'), join(root, 'real', 'link'))
        symlinkSync(join(root, 'real'), join(root, 'linkdir'))
        mkdirSync(join(root, 'open'), { mode: 0o775 })
        chmodSync(join(root, 'open'), 0o775)
        expect(sourced(`safe_path ${join(root, 'real', 'ok')} file ${me} && echo fine`).stdout.trim()).toBe('fine')
        expect(sourced(`safe_path ${join(root, 'real', 'link')} file ${me}`).stderr).toMatch(/symbolic link/)
        expect(sourced(`safe_path ${join(root, 'linkdir', 'file')} file ${me}`).stderr).toMatch(/symbolic link/)
        expect(sourced(`safe_path ${join(root, 'open', 'file')} file ${me}`).stderr).toMatch(/writable by group or others/)
        expect(sourced(`safe_path ${join(root, 'real')} file ${me}`).stderr).toMatch(/not a regular file/)
        rmSync(root, { recursive: true, force: true })
    })
})

describe('abp-uninstall', () => {
    it('keeps profile and journal volumes, configuration and secrets unless --purge', () => {
        const kept = bash('abp-uninstall', ['--dry-run'])
        expect(kept.status).toBe(0)
        expect(kept.stdout).toMatch(/\+ systemctl disable --now abp-happy-daemon\.service/)
        expect(kept.stdout).toMatch(/\+ \/usr\/local\/libexec\/abp\/abp-firewall remove$/m)
        expect(kept.stdout).not.toMatch(/volume rm|rm -rf \/etc\/abp|rm -rf \/var\/lib\/abp/)
        const purged = bash('abp-uninstall', ['--dry-run', '--purge'])
        expect(purged.status).toBe(0)
        expect(purged.stdout).toMatch(/docker volume rm/)
        expect(purged.stdout).toMatch(/\+ rm -rf \/etc\/abp \/var\/lib\/abp/)
    })

    it('fences new sessions, terminates every session process, and only then removes the owner firewall rules', () => {
        const lines = bash('abp-uninstall', ['--dry-run']).stdout.split('\n')
        const at = (text: string) => lines.findIndex((line) => line === text)
        const sudoers = at('+ rm -f /etc/sudoers.d/abp-agent-sbx')
        const daemon = at('+ systemctl disable --now abp-happy-daemon.service')
        const kill = at('+ pkill -KILL -u agent-sbx')
        const rules = at('+ /usr/local/libexec/abp/abp-firewall remove')
        expect(sudoers).toBeGreaterThanOrEqual(0)
        expect(daemon).toBeGreaterThan(sudoers)
        expect(at('+ pkill -TERM -u agent-sbx')).toBeGreaterThan(daemon)
        expect(at('+ pkill -TERM -u agent')).toBeGreaterThan(daemon)
        expect(rules).toBeGreaterThan(kill)
    })

    it('keeps the firewall rules and fails when a session process survives SIGKILL', () => {
        const script = `set -euo pipefail; source "$1"
            run() { printf '+ %s\\n' "$*"; }
            id() { echo 1000; }
            pkill() { :; }
            pgrep() { echo 4242; }
            TERM_WAIT_S=0
            main_uninstall`
        const result = spawnSync('bash', ['-c', script, 'test', join(here, 'abp-uninstall')], { encoding: 'utf8' })
        expect(result.status).toBe(1)
        expect(result.stderr).toMatch(/survived SIGKILL/)
        expect(result.stdout).toMatch(/KEPT the owner firewall rules/)
        expect(result.stdout).not.toMatch(/abp-firewall remove|docker rm|disable --now abp-stack/)
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
