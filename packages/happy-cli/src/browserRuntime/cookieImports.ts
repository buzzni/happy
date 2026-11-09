/**
 * Site cookies the user imported from their own browser into the personal AI browser
 * (Saycode Desktop specs/ai-browser-cookie-import, ADR-087).
 *
 * Desktop reads and decrypts only the cookies its user chose for one host and sends them
 * over the daemon's Desktop-only control route; this module writes them into the dedicated
 * profile through CDP and keeps a record of what it wrote (keys only, never values) beside
 * the runtime state, so removal undoes exactly that and the record lives as long as the profile.
 */
import { randomBytes } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { BrowserRuntimeError } from './contracts'

/** The subset of CDP `Network.CookieParam` this module writes. */
export interface CdpCookieParam {
    name: string
    value: string
    url?: string
    domain?: string
    path: string
    secure?: boolean
    httpOnly?: boolean
    sameSite?: 'Strict' | 'Lax' | 'None'
    expires?: number
}

export interface CookieImportBrowser { setCookies(cookies: CdpCookieParam[]): Promise<void> }

const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/
const source = z.object({ browser: z.string().min(1).max(100), profile: z.string().min(1).max(200) }).strict()
/** A cookie as Desktop read it: a leading dot on `domain` means a domain cookie, none means host-only. */
const cookie = z.object({
    name: z.string().min(1).max(4096), value: z.string().max(4096),
    domain: z.string().min(1).max(255), path: z.string().startsWith('/').max(1024),
    secure: z.boolean(), httpOnly: z.boolean(),
    sameSite: z.enum(['unspecified', 'no_restriction', 'lax', 'strict']),
    expiresAt: z.number().int().positive().nullable(),
}).strict()
export const cookieImportRequest = z.object({ host: z.string().regex(HOST), source, cookies: z.array(cookie).min(1).max(300) }).strict()
export type CookieImportRequest = z.infer<typeof cookieImportRequest>
type ImportedCookie = z.infer<typeof cookie>

const key = z.object({ domain: z.string(), path: z.string(), name: z.string() }).strict()
type CookieKey = z.infer<typeof key>
const recordFile = z.object({
    schemaVersion: z.literal(1),
    imports: z.record(z.string(), z.object({ source, importedAtMs: z.number(), cookies: z.array(key) }).strict()),
}).strict()
type ImportRecord = z.infer<typeof recordFile>

const SAME_SITE = { no_restriction: 'None', lax: 'Lax', strict: 'Strict' } as const

/** RFC 6265 domain-match: the browser would send this cookie to `host`. */
function sentTo(domain: string, host: string): boolean {
    const bare = domain.replace(/^\./, '').toLowerCase()
    return domain.startsWith('.') ? host === bare || host.endsWith(`.${bare}`) : host === bare
}

/** Where the cookie lives: a domain cookie by `domain`, a host-only one by URL so Chrome keeps it host-only. */
function scope(key: CookieKey, secure: boolean): Pick<CdpCookieParam, 'url' | 'domain'> {
    return key.domain.startsWith('.') ? { domain: key.domain } : { url: `${secure ? 'https' : 'http'}://${key.domain}${key.path}` }
}

function toParam(input: ImportedCookie): CdpCookieParam {
    return {
        name: input.name, value: input.value, ...scope(input, input.secure), path: input.path,
        secure: input.secure, httpOnly: input.httpOnly,
        ...(input.sameSite === 'unspecified' ? {} : { sameSite: SAME_SITE[input.sameSite] }),
        ...(input.expiresAt === null ? {} : { expires: input.expiresAt }),
    }
}

const sameKey = (a: CookieKey, b: CookieKey) => a.domain === b.domain && a.path === b.path && a.name === b.name

export function createCookieImports(input: { stateDir: string; browser(): Promise<CookieImportBrowser>; now?: () => number }) {
    const path = join(input.stateDir, 'cookie-imports.json')
    const now = input.now ?? Date.now
    // One writer at a time: a removal must see the import that finished just before it.
    let queue: Promise<unknown> = Promise.resolve()
    const serial = <T>(work: () => Promise<T>): Promise<T> => { const next = queue.then(work, work); queue = next.catch(() => {}); return next }

    async function read(): Promise<ImportRecord> {
        const raw = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
        return raw === undefined ? { schemaVersion: 1, imports: {} } : recordFile.parse(JSON.parse(raw))
    }
    async function write(record: ImportRecord): Promise<void> {
        const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`
        await writeFile(temporary, JSON.stringify(record), { mode: 0o600 })
        await rename(temporary, path)
    }

    return {
        set: (raw: unknown) => serial(async () => {
            const parsed = cookieImportRequest.safeParse(raw)
            if (!parsed.success || parsed.data.cookies.some(item => !sentTo(item.domain, parsed.data.host)))
                throw new BrowserRuntimeError('INVALID_REQUEST', 'host and cookies sent to that host are required')
            const { host, cookies } = parsed.data
            const browser = await input.browser()
            const written: CookieKey[] = []
            for (const item of cookies) {
                // One at a time: Chrome rejects a whole batch for one cookie it would never have stored.
                try { await browser.setCookies([toParam(item)]); written.push({ domain: item.domain, path: item.path, name: item.name }) } catch { /* counted as skipped */ }
            }
            // Nothing landed: report it without recording an empty import.
            if (written.length === 0) return { host, imported: 0, skipped: cookies.length }
            const record = await read()
            const previous = record.imports[host]?.cookies ?? []
            record.imports[host] = { source: parsed.data.source, importedAtMs: now(),
                cookies: [...previous.filter(old => !written.some(next => sameKey(old, next))), ...written] }
            await write(record)
            return { host, imported: written.length, skipped: cookies.length - written.length }
        }),
        remove: (host: unknown) => serial(async () => {
            if (typeof host !== 'string' || !HOST.test(host)) throw new BrowserRuntimeError('INVALID_REQUEST', 'host is required')
            const record = await read()
            const entry = record.imports[host]
            if (!entry) throw new BrowserRuntimeError('TARGET_GONE', 'nothing was imported for this host')
            const browser = await input.browser()
            const failed: CookieKey[] = []
            // An expired cookie with the same key makes Chrome delete the stored one.
            for (const item of entry.cookies) {
                try { await browser.setCookies([{ name: item.name, value: '', ...scope(item, true), path: item.path, expires: 1 }]) } catch { failed.push(item) }
            }
            if (failed.length) record.imports[host] = { ...entry, cookies: failed }
            else delete record.imports[host]
            await write(record)
            return { host, removed: entry.cookies.length - failed.length, failed: failed.length }
        }),
        list: async () => Object.entries((await read()).imports)
            .map(([host, entry]) => ({ host, source: entry.source, importedAtMs: entry.importedAtMs, count: entry.cookies.length })),
    }
}

export type CookieImports = ReturnType<typeof createCookieImports>
