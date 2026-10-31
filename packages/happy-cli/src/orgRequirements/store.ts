/**
 * The daemon's last known good organization requirements (aplus-dev-studio-desktop
 * specs/codexcli-org-requirements R16, plan 결정 5).
 *
 * `<HAPPY_HOME_DIR>/org-requirements/<hash16>.json` per (server, account, organization), owner-only,
 * replaced atomically, at most 64KB. A session that cannot reach Studio does not know its organization,
 * so every successful response also records which organization a scope (a project id the daemon handed
 * over, or the server session id) resolved to: `scope-<hash16>.json`. File names are hashes, so the
 * directory listing names no organization, project or account.
 *
 * This is a cache, not a policy source: a user can delete it (threat model ③), and a missing or broken
 * file reads as "never received". Every failure is swallowed — it must not stop a session.
 */

import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseOrgRequirements, type OrgRequirementsDocument } from './resolve';

export const LKG_MAX_BYTES = 64 * 1024;
export const ORG_REQUIREMENTS_DIR = 'org-requirements';
const SCOPE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export type OrgScopeKey = { kind: 'project' | 'session'; id: string };

/** What one running session enforces, for the daemon's own writers (the autonomous quality gate, R10.5). */
export interface OrgSessionSummary {
    companyId: string;
    autopilotDisabled: boolean;
}

export interface OrgRequirementsLkg {
    document: OrgRequirementsDocument;
    /** When this process (or an earlier one) last received it from Studio. */
    receivedAt: number;
}

export interface OrgRequirementsStore {
    readLkg(companyId: string): OrgRequirementsLkg | null;
    writeLkg(document: OrgRequirementsDocument, receivedAt: number): 'written' | 'too_large' | 'failed';
    deleteLkg(companyId: string): void;
    readScope(scope: OrgScopeKey): string | null;
    writeScope(scope: OrgScopeKey, companyId: string): void;
    deleteScope(scope: OrgScopeKey): void;
    /** Keyed by the server and session id only: the daemon reading it holds another account. `null` removes it. */
    writeSessionSummary(sessionId: string, summary: OrgSessionSummary | null): void;
    readSessionSummary(sessionId: string): OrgSessionSummary | null;
}

export function orgRequirementsDirectory(happyHomeDir: string): string {
    return join(happyHomeDir, ORG_REQUIREMENTS_DIR);
}

export function createOrgRequirementsStore(options: {
    happyHomeDir: string;
    serverUrl: string;
    /** Stable per account and never stored: only its hash reaches a file name. */
    accountKey: string;
    now?: () => number;
}): OrgRequirementsStore {
    const dir = orgRequirementsDirectory(options.happyHomeDir);
    const now = options.now ?? Date.now;
    const hash = (part: string) => createHash('sha256').update(`${options.serverUrl}\n${options.accountKey}\n${part}`).digest('hex').slice(0, 16);
    const lkgFile = (companyId: string) => join(dir, `${hash(`company:${companyId}`)}.json`);
    const scopeFile = (scope: OrgScopeKey) => join(dir, `scope-${hash(`${scope.kind}:${scope.id}`)}.json`);
    const sessionFile = (sessionId: string) => join(dir, `session-${createHash('sha256').update(`${options.serverUrl}\nsession:${sessionId}`).digest('hex').slice(0, 16)}.json`);
    let pruned = false;

    const write = (file: string, body: string) => {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        chmodSync(dir, 0o700);
        const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
        try {
            writeFileSync(temp, body, { mode: 0o600 });
            chmodSync(temp, 0o600);
            renameSync(temp, file);
        } finally {
            rmSync(temp, { force: true });
        }
    };
    const readJson = (file: string): Record<string, unknown> | null => {
        try {
            const value = JSON.parse(readFileSync(file, 'utf8')) as unknown;
            return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
        } catch {
            return null;
        }
    };
    const remove = (file: string) => { try { unlinkSync(file); } catch { /* already gone */ } };
    const prune = () => {
        if (pruned) return;
        pruned = true;
        try {
            for (const name of readdirSync(dir)) {
                if (!name.startsWith('scope-') && !name.startsWith('session-')) continue;
                const file = join(dir, name);
                if (now() - statSync(file).mtimeMs > SCOPE_MAX_AGE_MS) remove(file);
            }
        } catch { /* best effort */ }
    };

    return {
        readLkg: (companyId) => {
            const stored = readJson(lkgFile(companyId));
            if (!stored || stored.version !== 1 || typeof stored.receivedAt !== 'number') return null;
            try {
                // Judged exactly as a response would be: the file is user-writable (spec R9).
                const { document } = parseOrgRequirements(stored.document);
                return document.companyId === companyId ? { document, receivedAt: stored.receivedAt } : null;
            } catch {
                return null;
            }
        },
        writeLkg: (document, receivedAt) => {
            const body = JSON.stringify({ version: 1, receivedAt, document });
            if (Buffer.byteLength(body) > LKG_MAX_BYTES) return 'too_large';
            try {
                write(lkgFile(document.companyId), body);
                return 'written';
            } catch {
                return 'failed';
            }
        },
        deleteLkg: (companyId) => remove(lkgFile(companyId)),
        readScope: (scope) => {
            const stored = readJson(scopeFile(scope));
            return stored && stored.version === 1 && typeof stored.companyId === 'string' && stored.companyId ? stored.companyId : null;
        },
        writeScope: (scope, companyId) => {
            try {
                write(scopeFile(scope), JSON.stringify({ version: 1, companyId, at: now() }));
                prune();
            } catch { /* a missing mapping only means "unknown" after a later failure */ }
        },
        deleteScope: (scope) => remove(scopeFile(scope)),
        writeSessionSummary: (sessionId, summary) => {
            if (!summary) return remove(sessionFile(sessionId));
            try {
                write(sessionFile(sessionId), JSON.stringify({ version: 1, ...summary, at: now() }));
                prune();
            } catch { /* the daemon then sees an older runtime: nothing enforced on its side */ }
        },
        readSessionSummary: (sessionId) => {
            const stored = readJson(sessionFile(sessionId));
            return stored && stored.version === 1 && typeof stored.companyId === 'string' && typeof stored.autopilotDisabled === 'boolean'
                ? { companyId: stored.companyId, autopilotDisabled: stored.autopilotDisabled }
                : null;
        },
    };
}
