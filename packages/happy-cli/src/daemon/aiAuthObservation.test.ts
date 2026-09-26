import { describe, expect, it } from 'vitest'
import { CLAUDE_AUTH_OVERRIDE_ENV_KEYS } from '@/claude/utils/claudeAuthOverrideEnv'
import { observeClaudeAiAuthSource } from './aiAuthObservation'
import { AI_CREDENTIAL_PROVENANCE_PATH, serializeAppliedClaudeProvenance } from './aiCredentialProvenance'

const HOME = '/home/operator'
const CWD = '/work/project'
const MANAGED = '/etc/claude-code/managed-settings.json'
const bundleIdentity = ['a@corp.com', 'org-a'] as const

function baseFiles(): Record<string, string> {
    return {
        [`${HOME}/${AI_CREDENTIAL_PROVENANCE_PATH}`]: serializeAppliedClaudeProvenance({
            generation: 7,
            companyId: 'co-1',
            bundleId: 'bundle-1',
            bundleVersion: 2,
            identities: [JSON.stringify(bundleIdentity), JSON.stringify(['b@corp.com', ''])],
        }),
        [`${HOME}/.happy/ai-credential-apply-generations.json`]:
            JSON.stringify({ version: 1, generations: { claude: 7 } }),
        [`${HOME}/.claude.json`]: JSON.stringify({
            oauthAccount: { emailAddress: bundleIdentity[0], organizationUuid: bundleIdentity[1] },
        }),
    }
}

function observe(options: {
    files?: Record<string, string>
    env?: Record<string, string | undefined>
    agent?: string
    spawnPath?: 'spawn' | 'resume' | 'tmux'
    cwd?: string | undefined
    failingPaths?: string[]
} = {}) {
    const files = options.files ?? baseFiles()
    return observeClaudeAiAuthSource({
        agent: options.agent ?? 'claude',
        spawnPath: options.spawnPath ?? 'spawn',
        env: options.env ?? { PATH: '/usr/bin' },
        cwd: 'cwd' in options ? options.cwd : CWD,
        homeDir: HOME,
        managedSettingsPaths: [MANAGED],
        readFile: async (path: string) => {
            if (options.failingPaths?.includes(path)) throw Object.assign(new Error('denied'), { code: 'EACCES' })
            if (path in files) return files[path]!
            throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        },
    })
}

function withFile(path: string, content: string) {
    return { ...baseFiles(), [path]: content }
}

describe('observeClaudeAiAuthSource', () => {
    it('reports org-bundle when every piece of evidence lines up', async () => {
        await expect(observe()).resolves.toBe('org-bundle')
    })

    it('allows a resumed spawn the same way', async () => {
        await expect(observe({ spawnPath: 'resume' })).resolves.toBe('org-bundle')
    })

    describe('path', () => {
        it('is unknown for a non-Claude agent', async () => {
            await expect(observe({ agent: 'codex' })).resolves.toBe('unknown')
        })

        it('is unknown for a tmux spawn — variables left on the tmux server cannot be seen', async () => {
            await expect(observe({ spawnPath: 'tmux' })).resolves.toBe('unknown')
        })
    })

    describe('provenance', () => {
        it('is unknown without a fenced deployment record', async () => {
            const files = baseFiles()
            delete files[`${HOME}/${AI_CREDENTIAL_PROVENANCE_PATH}`]
            await expect(observe({ files })).resolves.toBe('unknown')
        })

        it('is unknown when the record is from an earlier generation', async () => {
            await expect(observe({
                files: withFile(`${HOME}/.happy/ai-credential-apply-generations.json`,
                    JSON.stringify({ version: 1, generations: { claude: 8 } })),
            })).resolves.toBe('unknown')
        })
    })

    describe('live identity', () => {
        it('is unknown when the logged-in account is not one of the bundle accounts', async () => {
            await expect(observe({
                files: withFile(`${HOME}/.claude.json`, JSON.stringify({
                    oauthAccount: { emailAddress: 'me@personal.com', organizationUuid: 'org-me' },
                })),
            })).resolves.toBe('unknown')
        })

        it('is unknown when the email matches but the organization does not', async () => {
            // One cswap pool can hold the same email under two organizations.
            await expect(observe({
                files: withFile(`${HOME}/.claude.json`, JSON.stringify({
                    oauthAccount: { emailAddress: bundleIdentity[0], organizationUuid: 'org-other' },
                })),
            })).resolves.toBe('unknown')
        })

        it('matches an account with no organization against an empty organization', async () => {
            await expect(observe({
                files: withFile(`${HOME}/.claude.json`, JSON.stringify({
                    oauthAccount: { emailAddress: 'b@corp.com' },
                })),
            })).resolves.toBe('org-bundle')
        })

        it('is unknown when there is no login metadata', async () => {
            await expect(observe({ files: withFile(`${HOME}/.claude.json`, '{}') }))
                .resolves.toBe('unknown')
        })

        it('is unknown when the login file cannot be parsed', async () => {
            await expect(observe({ files: withFile(`${HOME}/.claude.json`, '{oops') }))
                .resolves.toBe('unknown')
        })

        it("reads the child's CLAUDE_CONFIG_DIR, not the daemon's home", async () => {
            const files = baseFiles()
            files['/profiles/p1/.claude.json'] = JSON.stringify({
                oauthAccount: { emailAddress: 'me@personal.com', organizationUuid: 'org-me' },
            })
            await expect(observe({ files, env: { CLAUDE_CONFIG_DIR: '/profiles/p1' } }))
                .resolves.toBe('unknown')
        })

        it('prefers the legacy <config home>/.config.json when it exists, as Claude Code does', async () => {
            await expect(observe({
                files: withFile(`${HOME}/.claude/.config.json`, JSON.stringify({
                    oauthAccount: { emailAddress: 'me@personal.com', organizationUuid: 'org-me' },
                })),
            })).resolves.toBe('unknown')
        })
    })

    describe('environment overrides', () => {
        it.each([...CLAUDE_AUTH_OVERRIDE_ENV_KEYS])('is unknown when the child env carries %s', async (key) => {
            await expect(observe({ env: { PATH: '/usr/bin', [key]: 'x' } })).resolves.toBe('unknown')
        })

        it('is unknown even when an override key is present but empty — cannot tell how it is read', async () => {
            await expect(observe({ env: { ANTHROPIC_BASE_URL: '' } })).resolves.toBe('unknown')
        })
    })

    describe('settings overrides — a settings env beats the startup env', () => {
        it.each([
            ['user', `${HOME}/.claude/settings.json`],
            ['project', `${CWD}/.claude/settings.json`],
            ['local', `${CWD}/.claude/settings.local.json`],
            ['managed policy', MANAGED],
        ])('is unknown when %s settings set an auth variable', async (_scope, path) => {
            await expect(observe({
                files: withFile(path, JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk-other' } })),
            })).resolves.toBe('unknown')
        })

        it.each([
            ['user', `${HOME}/.claude/settings.json`],
            ['project', `${CWD}/.claude/settings.json`],
        ])('is unknown when %s settings define an apiKeyHelper', async (_scope, path) => {
            await expect(observe({
                files: withFile(path, JSON.stringify({ apiKeyHelper: '/bin/print-key' })),
            })).resolves.toBe('unknown')
        })

        it("follows the child's CLAUDE_CONFIG_DIR for user settings", async () => {
            const files = baseFiles()
            files['/profiles/p1/.claude.json'] = files[`${HOME}/.claude.json`]!
            files['/profiles/p1/settings.json'] = JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk-other' } })
            await expect(observe({ files, env: { CLAUDE_CONFIG_DIR: '/profiles/p1' } }))
                .resolves.toBe('unknown')
        })

        it('is unknown when a settings file exists but cannot be parsed', async () => {
            await expect(observe({ files: withFile(`${CWD}/.claude/settings.json`, '{oops') }))
                .resolves.toBe('unknown')
        })

        it('is unknown when a settings file exists but cannot be read', async () => {
            await expect(observe({ failingPaths: [`${CWD}/.claude/settings.local.json`] }))
                .resolves.toBe('unknown')
        })

        it('is unknown when the working directory is not known — project settings cannot be checked', async () => {
            await expect(observe({ cwd: undefined })).resolves.toBe('unknown')
        })

        it('does not over-trigger on settings that change nothing about the credential', async () => {
            await expect(observe({
                files: withFile(`${CWD}/.claude/settings.json`, JSON.stringify({
                    env: { DISABLE_TELEMETRY: '1', ANTHROPIC_MODEL: 'claude-opus-5' },
                    permissions: { allow: ['Bash'] },
                })),
            })).resolves.toBe('org-bundle')
        })
    })

    it('never throws — any unexpected failure is unknown', async () => {
        await expect(observeClaudeAiAuthSource({
            agent: 'claude',
            spawnPath: 'spawn',
            env: {},
            cwd: CWD,
            homeDir: HOME,
            managedSettingsPaths: [MANAGED],
            readFile: () => { throw new Error('synchronous explosion') },
        })).resolves.toBe('unknown')
    })
})
