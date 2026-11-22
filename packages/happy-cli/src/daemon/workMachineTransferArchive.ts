/**
 * What a work machine transfer carries, and how its archive is checked on the way back out
 * (aplus-dev-studio specs/work-machine-migration plan 2, 5.4).
 *
 * The selection is an allow-list built from the Studio plan: each project tree (Git directory,
 * dirty and untracked files included), the planned sessions' HAPPY_HOME recovery records and
 * their Claude/Codex provider records. Nothing else under HAPPY_HOME, CLAUDE_CONFIG_DIR or
 * CODEX_HOME is ever enumerated, so account/device keys, AI logins and execution credentials stay
 * behind by construction. Files that may still carry an execution credential (provider records,
 * env-like files, Git config) are scanned and the export stops, naming the file, never the value.
 *
 * Archive layout: `happy/sessions.json` (the selected records) and `fs/<absolute path>` for every
 * selected entry. Extraction admits only those two shapes, regular files, directories and symlinks
 * that stay inside their root.
 */
import { constants, createReadStream } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, readlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { create as createTar, extract as extractTar, list as listTar } from 'tar';
import { z } from 'zod';
import { getProjectPath } from '@/claude/utils/path';
import { withReportedProviderIdentity } from './resumeCursorPersistence';
import { readWorkMachineSessionStop, workMachineSessionStopPath } from './workMachineSessionStop';

export type WorkMachineTransferSession = {
    sessionId: string;
    provider: 'claude' | 'codex';
    nativeId: string;
    lastProcessedSeq: number;
};

export type WorkMachineTransferSelection = {
    /** Archive roots, sorted: project trees and provider records. The manifest's `paths`. */
    roots: string[];
    /** Every absolute path archived, each root before its descendants. */
    entries: string[];
    sessions: WorkMachineTransferSession[];
    /**
     * The planned sessions' recovery records from sessions.json, with the cursor and provider
     * conversation their processes recorded when they stopped (workMachineSessionStop.ts).
     */
    records: Record<string, unknown>;
};

const RECORDS_ENTRY = 'happy/sessions.json';
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const claudeNativeId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const codexNativeId = /^[A-Za-z0-9_-]{1,128}$/;
const recordSchema = z.object({
    encryptionKey: z.string().min(1),
    encryptionVariant: z.literal('dataKey'),
    metadata: z.object({
        path: z.string(),
        claudeSessionId: z.string().optional(),
        codexThreadId: z.string().optional(),
    }).passthrough(),
    lastProcessedSeq: z.number().int().nonnegative(),
    userHomeDir: z.never().optional(),
    deferredContinuationContextFile: z.string().optional(),
}).passthrough();

/** Logins that may sit inside a project tree and never travel. */
const LOGIN_FILES = new Set(['.git-credentials', '.netrc', '.credentials.json']);
const SCANNED_NAME = /^\.env(\..*)?$|\.env$|^\.mcp\.json$/;
const CREDENTIAL_PATTERNS = [
    /\bwm[xt]_[A-Za-z0-9_-]{8,}/,
    /authorization["']?\s*[:=]\s*["']?\s*bearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
    /extraheader\s*=\s*authorization/i,
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@"']+:[^\s/@"']+@/i,
];
/** A base64url JSON payload with a signature segment: caller grants, connector capabilities, JWTs. */
const SIGNED_TOKEN = /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g;

const within = (root: string, path: string) => path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);

function containsCredential(text: string): boolean {
    if (CREDENTIAL_PATTERNS.some(pattern => pattern.test(text))) return true;
    for (const match of text.matchAll(SIGNED_TOKEN)) {
        try {
            const payload = JSON.parse(Buffer.from(match[0].split('.')[0], 'base64url').toString('utf8'));
            if (payload && typeof payload === 'object' && (typeof payload.exp === 'number' || typeof payload.alg === 'string')) return true;
        } catch { /* Not a token. */ }
    }
    return false;
}

async function assertNoCredential(path: string): Promise<void> {
    // Overlap keeps a token split across two reads whole (tokens are capped at 4 KiB).
    let carry = '';
    for await (const chunk of createReadStream(path, { encoding: 'utf8', highWaterMark: 1024 * 1024 })) {
        const text = carry + (chunk as string);
        if (containsCredential(text)) throw new Error(`Credential material found in ${path}; remove it before exporting`);
        carry = text.slice(-8192);
    }
}

function assertPlannedPath(path: string): void {
    if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || path === '/') {
        throw new Error(`Transfer path is not an absolute normalized path: ${JSON.stringify(path)}`);
    }
}

/** Walks one root. Symlinks are kept only when they resolve inside the root. */
async function collectTree(root: string, scanAll: boolean, entries: string[]): Promise<void> {
    const visit = async (path: string): Promise<void> => {
        const info = await lstat(path);
        const name = basename(path);
        if (info.isSymbolicLink()) {
            if (!within(root, resolve(dirname(path), await readlink(path)))) {
                throw new Error(`Symbolic link leaves the transfer tree: ${path}`);
            }
            entries.push(path);
            return;
        }
        if (info.isDirectory()) {
            entries.push(path);
            for (const child of (await readdir(path)).sort()) await visit(join(path, child));
            return;
        }
        // Sockets, FIFOs and devices belong to running processes, pid and Git lock files to dead ones.
        if (!info.isFile() || name.endsWith('.pid') || LOGIN_FILES.has(name)
            || (name.endsWith('.lock') && path.includes('/.git/'))) return;
        if (scanAll || SCANNED_NAME.test(name) || path.endsWith('/.git/config')) await assertNoCredential(path);
        entries.push(path);
    };
    await visit(root);
}

async function readSessionRecords(happyHome: string): Promise<Record<string, unknown>> {
    const file = await open(join(happyHome, 'sessions.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        .catch(() => { throw new Error('The session recovery records are unreadable'); });
    try {
        const info = await file.stat();
        if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0) throw new Error('The session recovery records are not a private file');
        const parsed = z.object({ sessions: z.record(z.string(), z.unknown()) }).passthrough()
            .safeParse(JSON.parse(await file.readFile('utf8')));
        if (!parsed.success) throw new Error('The session recovery records are invalid');
        return parsed.data.sessions;
    } finally {
        await file.close();
    }
}

async function regularFile(path: string): Promise<boolean> {
    const info = await lstat(path).catch(() => null);
    return !!info && info.isFile();
}

async function providerRoots(input: {
    sessionId: string; cwd: string; claudeSessionId?: string; codexThreadId?: string; claudeConfigDir: string; codexHome: string;
}): Promise<{ session: Omit<WorkMachineTransferSession, 'sessionId' | 'lastProcessedSeq'>; roots: string[] }> {
    const { sessionId, claudeSessionId, codexThreadId } = input;
    if (!!claudeSessionId === !!codexThreadId) throw new Error(`Session ${sessionId} has no single provider identity`);
    if (claudeSessionId) {
        if (!claudeNativeId.test(claudeSessionId)) throw new Error(`Session ${sessionId} has an invalid Claude session id`);
        const record = join(getProjectPath(input.cwd, input.claudeConfigDir), `${claudeSessionId}.jsonl`);
        if (!await regularFile(record)) throw new Error(`Session ${sessionId} has no Claude record at ${record}`);
        // Subagent transcripts and tool results live in the session's own directory beside the record.
        const sidecar = record.slice(0, -'.jsonl'.length);
        const sidecarInfo = await lstat(sidecar).catch(() => null);
        if (sidecarInfo && !sidecarInfo.isDirectory()) throw new Error(`Session ${sessionId} has an unexpected Claude entry at ${sidecar}`);
        return { session: { provider: 'claude', nativeId: claudeSessionId }, roots: sidecarInfo ? [record, sidecar] : [record] };
    }
    if (!codexNativeId.test(codexThreadId!)) throw new Error(`Session ${sessionId} has an invalid Codex thread id`);
    const sessions = join(input.codexHome, 'sessions');
    const matches = (await readdir(sessions, { recursive: true }).catch(() => [] as string[]))
        .filter(entry => basename(entry).startsWith('rollout-') && basename(entry).endsWith(`-${codexThreadId}.jsonl`))
        .map(entry => join(sessions, entry));
    if (matches.length !== 1 || !await regularFile(matches[0])) {
        throw new Error(`Session ${sessionId} needs exactly one Codex rollout for ${codexThreadId}, found ${matches.length}`);
    }
    return { session: { provider: 'codex', nativeId: codexThreadId! }, roots: matches };
}

/**
 * The session's record as its process left it. The daemon's copy can trail the process by 30 s and
 * counts input delivered to the loop, not input a turn ran; a session with no stop record, or one
 * that stopped mid-turn, cannot say which input ran, and is never guessed at.
 */
async function stoppedRecord(happyHome: string, sessionId: string, stored: unknown): Promise<unknown> {
    const stop = await readWorkMachineSessionStop(workMachineSessionStopPath(happyHome, sessionId), sessionId);
    const drainLonger = 'Cancel the migration (resume) so the session can finish, then drain longer before freezing and exporting again';
    if (!stop) {
        throw new Error(`Session ${sessionId} has no clean-stop record: its process is still running or did not stop cleanly. ${drainLonger}`);
    }
    if (stop.turnInFlight) throw new Error(`Session ${sessionId} was stopped while a turn was still running. ${drainLonger}`);
    if (stop.inputSkipped) throw new Error(`Session ${sessionId} stopped with an input that never started a turn before a later one did. ${drainLonger}`);
    const record = z.object({ metadata: z.object({}).passthrough() }).passthrough().safeParse(stored);
    if (!record.success) return stored;
    const metadata = withReportedProviderIdentity(record.data.metadata, stop) ?? record.data.metadata;
    return { ...record.data, metadata, lastProcessedSeq: stop.lastProcessedSeq };
}

export async function selectWorkMachineTransfer(input: {
    happyHome: string;
    claudeConfigDir: string;
    codexHome: string;
    projectPaths: string[];
    sessionIds: string[];
    /** False only for the dry run (`export --check`), which runs while the sessions still do. */
    requireStopRecords: boolean;
}): Promise<WorkMachineTransferSelection> {
    const homes = [input.happyHome, input.claudeConfigDir, input.codexHome];
    for (const path of input.projectPaths) {
        assertPlannedPath(path);
        if (homes.some(home => within(path, home) || within(home, path))) {
            throw new Error(`Project path overlaps a Happy, Claude or Codex home: ${path}`);
        }
        const info = await lstat(path).catch(() => null);
        if (!info?.isDirectory()) throw new Error(`Project path is not a directory: ${path}`);
    }
    // A worktree nested inside another planned project travels with it.
    const projects = [...new Set(input.projectPaths)].sort()
        .filter((path, index, all) => !all.slice(0, index).some(outer => within(outer, path)));

    const stored = await readSessionRecords(input.happyHome);
    const records: Record<string, unknown> = {};
    const sessions: WorkMachineTransferSession[] = [];
    const providerPaths: string[] = [];
    for (const sessionId of [...new Set(input.sessionIds)].sort()) {
        identifier.parse(sessionId);
        if (!(sessionId in stored)) throw new Error(`Session ${sessionId} has no recovery record on this machine`);
        const record = input.requireStopRecords ? await stoppedRecord(input.happyHome, sessionId, stored[sessionId]) : stored[sessionId];
        const parsed = recordSchema.safeParse(record);
        if (!parsed.success) {
            throw new Error(`Session ${sessionId} is not transferable: it needs a dataKey record with a processed cursor and no staged user home`);
        }
        const { metadata, lastProcessedSeq, deferredContinuationContextFile } = parsed.data;
        if (!projects.some(project => within(project, metadata.path))) {
            throw new Error(`Session ${sessionId} works outside the planned projects: ${metadata.path}`);
        }
        if (deferredContinuationContextFile && !projects.some(project => within(project, deferredContinuationContextFile))) {
            throw new Error(`Session ${sessionId} keeps pending context outside the planned projects`);
        }
        const provider = await providerRoots({
            sessionId, cwd: metadata.path, claudeSessionId: metadata.claudeSessionId, codexThreadId: metadata.codexThreadId,
            claudeConfigDir: input.claudeConfigDir, codexHome: input.codexHome,
        });
        sessions.push({ sessionId, ...provider.session, lastProcessedSeq });
        providerPaths.push(...provider.roots);
        records[sessionId] = record;
    }
    if (containsCredential(JSON.stringify(records))) {
        throw new Error(`Credential material found in ${join(input.happyHome, 'sessions.json')}; remove it before exporting`);
    }

    const entries: string[] = [];
    for (const project of projects) await collectTree(project, false, entries);
    for (const path of providerPaths) await collectTree(path, true, entries);
    return { roots: [...projects, ...providerPaths].sort(), entries, sessions, records };
}

/** A tar stream of the selection. `recordsFile` holds `JSON.stringify(selection.records)`. */
export function packWorkMachineArchive(selection: WorkMachineTransferSelection, recordsFile: string): Readable {
    // A cache that never remembers makes every hard-linked file (local Git clones) a regular file.
    const noHardLinks = new Map<string, string>();
    noHardLinks.set = () => noHardLinks;
    return Readable.from(createTar({
        cwd: '/', portable: true, strict: true, noDirRecurse: true, linkCache: noHardLinks as never,
        onWriteEntry: entry => { entry.path = entry.absolute === recordsFile ? RECORDS_ENTRY : `fs/${entry.path}`; },
    }, [recordsFile, ...selection.entries].map(path => path.slice(1))));
}

/**
 * Checks every entry of an authenticated archive, then extracts it into `staging` (which must not
 * exist). Returns the session records. Nothing is extracted when any entry is out of shape.
 */
export async function extractWorkMachineArchive(input: {
    archivePath: string;
    roots: string[];
    staging: string;
}): Promise<Record<string, unknown>> {
    input.roots.forEach(assertPlannedPath);
    let records = 0;
    let invalid = false;
    const links: string[] = [];
    await listTar({
        file: input.archivePath, strict: true,
        onReadEntry: entry => {
            if (entry.path === RECORDS_ENTRY && entry.type === 'File') {
                records += 1;
                return;
            }
            const path = entry.path.startsWith('fs/') ? `/${entry.path.slice(3).replace(/\/$/, '')}` : '';
            const root = isAbsolute(path) && resolve(path) === path ? input.roots.find(candidate => within(candidate, path)) : undefined;
            const linkInside = entry.type !== 'SymbolicLink' || (!!root && !!entry.linkpath && within(root, resolve(dirname(path), entry.linkpath)));
            // Nothing may be written through a link: its target is a real path on this machine.
            const throughLink = links.some(link => path !== link && within(link, path));
            if (entry.type === 'SymbolicLink') links.push(path);
            if (!root || !['File', 'OldFile', 'Directory', 'SymbolicLink'].includes(entry.type) || !linkInside || throughLink) invalid = true;
        },
    });
    if (invalid || records !== 1) throw new Error('Work machine archive contains entries outside the transfer manifest');
    await mkdir(input.staging, { mode: 0o700 });
    // Links keep their absolute targets: the tree returns to the same absolute paths. Every entry
    // was checked above, so preserving paths cannot write outside `staging`.
    await extractTar({ file: input.archivePath, cwd: input.staging, strict: true, preserveOwner: false, preservePaths: true });
    const parsed = z.record(identifier, z.unknown()).safeParse(JSON.parse(await readFile(join(input.staging, RECORDS_ENTRY), 'utf8')));
    if (!parsed.success) throw new Error('Work machine archive session records are invalid');
    return parsed.data;
}
