import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { groupAccountIdentity } from '@/daemon/aiCredentialGroupAdapters'

export type PersonalClaudeCredential = { accountRef: string; label: string; accessToken: string; expiresAt: number; roster?: { email: string; organizationUuid: string } }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
/** The stored OAuth token and login metadata must agree; every managed journal scope is excluded. */
export function personalClaudeCredentials(pool: unknown, journal: unknown, now: number, legacyOrganizationIdentities: readonly (readonly [string, string])[] = []): PersonalClaudeCredential[] {
    if (!object(pool) || pool.version !== 1 || pool.encrypted !== false || !Array.isArray(pool.accounts)
        || !object(journal) || journal.version !== 1 || !Array.isArray(journal.entries)) return []
    const owned = new Set<string>(); let managedJournal = false
    for (const entry of journal.entries) {
        if (!object(entry) || entry.provider !== 'claude' && entry.provider !== 'codex') return []
        if (entry.provider !== 'claude') continue
        if (entry.pending !== false || !Array.isArray(entry.desired) || !Array.isArray(entry.owned) || !Array.isArray(entry.managed) || entry.managedHeld !== undefined && !Array.isArray(entry.managedHeld)) return []
        managedJournal ||= entry.managed.length > 0
        for (const id of [...entry.desired, ...entry.owned, ...entry.managed, ...(Array.isArray(entry.managedHeld) ? entry.managedHeld : [])]) {
            if (typeof id !== 'string') return []
            owned.add(id)
        }
    }
    if (!managedJournal) return []
    const candidates = pool.accounts.flatMap((a: unknown) => {
        if (!object(a) || typeof a.email !== 'string' || typeof a.organizationUuid !== 'string' || !a.email.includes('@') || /@setup-token\.local$/.test(a.email)
            || a.managedAccountId !== undefined || a.credentialType === 'setup_token' || a.disabled === true || a.enabled === false) return []
        const email = a.email, organizationUuid = a.organizationUuid
        const credentials = object(a.credentials) ? a.credentials : null, config = object(a.config) ? a.config : null
        const oauth = object(credentials?.claudeAiOauth) ? credentials.claudeAiOauth : null
        const login = object(config?.oauthAccount) ? config.oauthAccount : null
        if (typeof oauth?.accessToken !== 'string' || !oauth.accessToken.length || typeof oauth.expiresAt !== 'number' || !Number.isFinite(oauth.expiresAt)
            || oauth.expiresAt <= now + 60_000 || login?.emailAddress !== a.email || login?.organizationUuid !== a.organizationUuid
            || owned.has(groupAccountIdentity('claude', a)) || legacyOrganizationIdentities.some(([knownEmail, organization]) => knownEmail.toLowerCase() === email.toLowerCase() && organization === organizationUuid)) return []
        return [{ email: a.email, organizationUuid: a.organizationUuid, accessToken: oauth.accessToken, expiresAt: oauth.expiresAt }]
    })
    const result = candidates.map(a => ({ accountRef: createHash('sha256').update(JSON.stringify([a.email, a.organizationUuid])).digest('hex'),
        label: a.email.replace(/^(.{1,2})[^@]*(@.*)$/, '$1…$2'), accessToken: a.accessToken, expiresAt: a.expiresAt,
        roster: { email: a.email, organizationUuid: a.organizationUuid } }))
    return new Set(result.map(a => a.accountRef)).size === result.length ? result : []
}
export function selectPersonalClaudeCredential(pool: unknown, journal: unknown, now: number, legacy: readonly (readonly [string, string])[] = [], accountRef?: string): PersonalClaudeCredential | null {
    const candidates = personalClaudeCredentials(pool, journal, now, legacy)
    const chosen = accountRef ? candidates.find(a => a.accountRef === accountRef) : candidates.length === 1 ? candidates[0] : undefined
    if (!chosen) return null
    const { roster, ...credential } = chosen
    return credential
}

/** No capture, import, switch or refresh: secrets stay inside the CLI process. */
export async function readPersonalClaudeCredentials(): Promise<PersonalClaudeCredential[]> {
    const path = join(homedir(), '.happy', 'ai-credential-groups.json')
    const provenancePath = join(homedir(), '.happy', 'ai-credential-provenance.json')
    const readProvenance = async () => {
        try { return await readFile(provenancePath, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    }
    try {
        const before = await readFile(path, 'utf8'), provenance = await readProvenance()
        const legacyIdentities: Array<readonly [string, string]> = []
        if (provenance !== null) {
            const value: unknown = JSON.parse(provenance)
            if (!object(value) || value.version !== 1 || !object(value.claude) || value.claude.state !== 'applied' || !Array.isArray(value.claude.identities)) return []
            for (const row of value.claude.identities) {
                if (!Array.isArray(row) || row.length !== 3 || row.some(v => typeof v !== 'string')) return []
                legacyIdentities.push([row[0], row[1]])
            }
        }
        const result = await promisify(execFile)('cswap', ['export', '-'], { timeout: 15_000, maxBuffer: 1024 * 1024 })
        if (before !== await readFile(path, 'utf8') || provenance !== await readProvenance()) return []
        return personalClaudeCredentials(JSON.parse(result.stdout), JSON.parse(before), Date.now(), legacyIdentities)
    } catch { return [] }
}

export async function readPersonalClaudeCredential(accountRef?: string): Promise<PersonalClaudeCredential | null> {
    const candidates = await readPersonalClaudeCredentials()
    const chosen = accountRef ? candidates.find(a => a.accountRef === accountRef) : candidates.length === 1 ? candidates[0] : undefined
    if (!chosen) return null
    const { roster, ...credential } = chosen
    return credential
}
