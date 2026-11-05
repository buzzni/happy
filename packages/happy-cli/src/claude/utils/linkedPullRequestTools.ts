/**
 * Linked pull requests (Saycode Desktop specs/linked-pull-requests R1·R2): a conversation keeps the
 * PRs the user or the agent linked — other repositories included — in session metadata
 * `linkedPullRequests`, and a link can carry a request to watch it. The agent's tools only record
 * the link or the request. Watching is done by a Saycode Desktop that sees the request and claims it
 * (`watch.owner`), so a reply never says that watching has started.
 *
 * Desktop writes the same array (owner, heartbeat, state), so every change here is a pure transform
 * replayed by `updateMetadata` against the newest server document: it touches only this array,
 * keeps fields and entries it does not understand, and applying it twice gives the same result.
 *
 * No network: a URL is checked by its shape only, the way Desktop's `pullRequestPaneLink` reads it.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiSessionClient } from '@/api/apiSession';
import type { Metadata } from '@/api/types';

export const LINKED_PULL_REQUEST_LIMIT = 20;

/** Tool names (without the `mcp__happy__` prefix) this module registers. */
export const LINKED_PULL_REQUEST_TOOL_NAMES = ['saycode_pr_link', 'saycode_pr_watch'] as const;

export type LinkedPullRequestActor = 'agent' | 'user';

export type LinkedPullRequestWatch = {
    requested: boolean;
    requestedAt: number;
    requestedBy: LinkedPullRequestActor;
    /** Written by the Desktop that runs the watch; `clientId` is a random per-install id. */
    owner?: { clientId: string; claimedAt: number; heartbeatAt: number };
    state?: 'watching' | 'ready' | 'merged' | 'stopped';
    stopReason?: string;
    updatedAt: number;
};

export type LinkedPullRequest = {
    /** `https://github.com/<owner>/<repo>/pull/<n>` */
    url: string;
    /** `owner/repo` as written in the URL; compared case-insensitively. */
    repo: string;
    number: number;
    linkedAt: number;
    linkedBy: LinkedPullRequestActor;
    watch?: LinkedPullRequestWatch;
};

export type PullRequestRef = Pick<LinkedPullRequest, 'url' | 'repo' | 'number'>;

const NAME = /^[A-Za-z0-9_.-]+$/;
const NUMBER = /^[1-9]\d{0,9}$/;

/** A GitHub pull request URL, or null. Same rules as Desktop `pullRequestPaneLink`: the query is dropped, a fragment refused. */
export function parsePullRequestUrl(input: string): PullRequestRef | null {
    let url: URL;
    try {
        url = new URL(input.trim());
    } catch {
        return null;
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return null;
    const host = url.hostname.toLowerCase();
    if (host !== 'github.com' && host !== 'www.github.com') return null;
    const segments = url.pathname.replace(/\/$/, '').split('/').slice(1);
    if (segments.length !== 4 || segments[2] !== 'pull') return null;
    const [owner, repo, , rawNumber] = segments;
    if (!NAME.test(owner) || !NAME.test(repo) || !NUMBER.test(rawNumber)) return null;
    const number = Number(rawNumber);
    if (!Number.isSafeInteger(number)) return null;
    return { url: `https://github.com/${owner}/${repo}/pull/${number}`, repo: `${owner}/${repo}`, number };
}

export function linkedPullRequestKey(ref: Pick<PullRequestRef, 'repo' | 'number'>): string {
    return `${ref.repo.toLowerCase()}#${ref.number}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The entry's key when it names a PR this module can read; other entries are kept but never matched. */
function entryKey(entry: unknown): string | null {
    if (!isRecord(entry) || typeof entry.url !== 'string') return null;
    const ref = parsePullRequestUrl(entry.url);
    return ref && typeof entry.number === 'number' && entry.number === ref.number && typeof entry.repo === 'string'
        && entry.repo.toLowerCase() === ref.repo.toLowerCase() ? linkedPullRequestKey(ref) : null;
}

function entries(metadata: Metadata): unknown[] {
    return Array.isArray(metadata.linkedPullRequests) ? metadata.linkedPullRequests : [];
}

/** Readable entries, for `list`. An entry with a malformed `watch` is shown as unwatched. */
export function readLinkedPullRequests(metadata: Metadata | null): LinkedPullRequest[] {
    if (!metadata) return [];
    return entries(metadata).flatMap((entry) => {
        if (entryKey(entry) === null) return [];
        const value = entry as LinkedPullRequest;
        return [{ ...value, watch: isRecord(value.watch) && typeof value.watch.requested === 'boolean' ? value.watch : undefined }];
    });
}

export type LinkedPullRequestChange =
    | { kind: 'link'; pr: PullRequestRef; by: LinkedPullRequestActor; at: number }
    | { kind: 'unlink'; pr: PullRequestRef }
    | { kind: 'watch'; pr: PullRequestRef; requested: boolean; by: LinkedPullRequestActor; at: number };

export type LinkedPullRequestOutcome =
    | 'linked' | 'already-linked' | 'limit'
    | 'unlinked' | 'not-linked'
    | 'watch-requested' | 'watch-already-requested' | 'watch-stopped' | 'watch-not-requested';

/**
 * Applies one change. Returns the same `metadata` object when nothing changes, so callers can
 * skip the write; `at` comes from the caller so a replay writes the same timestamps.
 *
 * `unlink` removes the entry even while it is watched: the owner Desktop stops the run of an entry
 * that disappeared (R3-6), and there is no field that would tell it to remove the entry later.
 */
export function applyLinkedPullRequestChange(metadata: Metadata, change: LinkedPullRequestChange): { metadata: Metadata; outcome: LinkedPullRequestOutcome } {
    const list = entries(metadata);
    const key = linkedPullRequestKey(change.pr);
    const index = list.findIndex((entry) => entryKey(entry) === key);
    const current = index >= 0 ? list[index] as LinkedPullRequest & Record<string, unknown> : null;
    const write = (next: unknown[], outcome: LinkedPullRequestOutcome) => ({ metadata: { ...metadata, linkedPullRequests: next }, outcome });
    const same = (outcome: LinkedPullRequestOutcome) => ({ metadata, outcome });
    const added = (at: number, by: LinkedPullRequestActor, watch?: LinkedPullRequestWatch): LinkedPullRequest => ({
        url: change.pr.url, repo: change.pr.repo, number: change.pr.number, linkedAt: at, linkedBy: by,
        ...(watch ? { watch } : {}),
    });

    if (change.kind === 'link') {
        if (current) return same('already-linked');
        // Unreadable entries count too: they are someone's data and stay.
        if (list.length >= LINKED_PULL_REQUEST_LIMIT) return same('limit');
        return write([...list, added(change.at, change.by)], 'linked');
    }
    if (change.kind === 'unlink') {
        if (!current) return same('not-linked');
        return write(list.filter((_, i) => i !== index), 'unlinked');
    }
    const watch = current && isRecord(current.watch) ? current.watch as LinkedPullRequestWatch & Record<string, unknown> : null;
    if (!change.requested) {
        if (!current) return same('not-linked');
        if (watch?.requested !== true) return same('watch-not-requested');
        const next = { ...current, watch: { ...watch, requested: false, updatedAt: change.at } };
        return write(list.map((entry, i) => i === index ? next : entry), 'watch-stopped');
    }
    if (watch?.requested === true) return same('watch-already-requested');
    // A new request starts a new watch: the previous run's state no longer describes it. The owner
    // stays; the owning Desktop picks the request up again or another takes over once it expires.
    const { state: _state, stopReason: _stopReason, ...kept } = watch ?? {};
    const requested: LinkedPullRequestWatch = { ...kept, requested: true, requestedAt: change.at, requestedBy: change.by, updatedAt: change.at };
    if (current) return write(list.map((entry, i) => i === index ? { ...current, watch: requested } : entry), 'watch-requested');
    if (list.length >= LINKED_PULL_REQUEST_LIMIT) return same('limit');
    return write([...list, added(change.at, change.by, requested)], 'watch-requested');
}

/** Whether the metadata already says what the change asked for. */
function changeHolds(metadata: Metadata, change: LinkedPullRequestChange): boolean {
    const entry = readLinkedPullRequests(metadata).find((pr) => linkedPullRequestKey(pr) === linkedPullRequestKey(change.pr));
    if (change.kind === 'link') return !!entry;
    if (change.kind === 'unlink') return !entry;
    return change.requested ? entry?.watch?.requested === true : entry?.watch?.requested !== true;
}

const STALE_MS = 30 * 60_000;
const REASON = /^[A-Za-z0-9_.:-]{1,40}$/;

/** One `list` line. Desktop writes `state` and `stopReason`, so only known values are repeated. */
function describeEntry(pr: LinkedPullRequest, now: number): string {
    const watch = pr.watch;
    const name = `${pr.repo}#${pr.number}`;
    let status: string;
    if (watch?.state === 'merged') status = 'merged';
    else if (watch?.state === 'stopped') status = `stopped: ${typeof watch.stopReason === 'string' && REASON.test(watch.stopReason) ? watch.stopReason : 'no reason given'}`;
    else if (!watch?.requested) status = watch?.state === 'watching' || watch?.state === 'ready' ? 'stop requested, Desktop has not stopped it yet' : 'not watched';
    else if (watch.state === 'watching' || watch.state === 'ready') {
        status = watch.state === 'ready' ? 'ready to merge' : 'watching';
        if (typeof watch.updatedAt === 'number' && now - watch.updatedAt > STALE_MS) status += ' (no update from the watching Desktop for over 30 minutes)';
    } else status = isRecord(watch.owner) ? 'requested, a Saycode Desktop is starting it' : 'requested, waiting for a Saycode Desktop to pick it up';
    return `- ${name} · watch: ${status} · ${pr.url}`;
}

export function renderLinkedPullRequestList(metadata: Metadata | null, now: number): string {
    const list = readLinkedPullRequests(metadata);
    if (list.length === 0) return 'No pull requests are linked to this conversation.';
    return [`Linked pull requests (${list.length}/${LINKED_PULL_REQUEST_LIMIT}):`, ...list.map((pr) => describeEntry(pr, now))].join('\n');
}

type ToolReply = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
type RunTool = (work: () => Promise<ToolReply>) => Promise<ToolReply>;

const reply = (text: string, isError = false): ToolReply => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

const NOT_A_PR_URL = 'Only GitHub pull request URLs (https://github.com/<owner>/<repo>/pull/<n>) can be linked.';
const LIMIT_REACHED = `This conversation already has ${LINKED_PULL_REQUEST_LIMIT} linked pull requests. Unlink one with saycode_pr_link before linking another; none was removed.`;
const NO_METADATA = 'LINKED_PULL_REQUESTS_UNAVAILABLE: this session has no metadata to record links in. Nothing was recorded.';
const NOT_CONFIRMED = 'The change was sent but the server has not confirmed it yet. Check with saycode_pr_link list before telling the user it is recorded.';
const WATCH_NOTE = 'Watching starts only while a Saycode Desktop that supports linked pull requests and can see this conversation is open; check its status with saycode_pr_link list. Do not tell the user that watching has started.';

export type LinkedPullRequestToolOptions = {
    client: ApiSessionClient;
    runTool: RunTool;
    now?: () => number;
    /** How long to wait for the server to store a change, and how often to look. */
    confirm?: { timeoutMs: number; pollMs: number };
};

const DEFAULT_CONFIRM = { timeoutMs: 5000, pollMs: 50 };

/**
 * Queues the change and waits until the client's copy of the metadata shows it, so a `list` right
 * after reads it. `updateMetadata` reports nothing back; the client copy changes on the server's ack.
 */
async function record(options: LinkedPullRequestToolOptions, change: LinkedPullRequestChange): Promise<{ outcome: LinkedPullRequestOutcome; confirmed: boolean } | null> {
    const { client } = options;
    const current = client.getMetadata();
    if (!current) return null;
    const planned = applyLinkedPullRequestChange(current, change);
    if (planned.metadata === current) return { outcome: planned.outcome, confirmed: true };
    client.updateMetadata((metadata) => applyLinkedPullRequestChange(metadata, change).metadata);
    const { timeoutMs, pollMs } = options.confirm ?? DEFAULT_CONFIRM;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const latest = client.getMetadata();
        if (latest && changeHolds(latest, change)) return { outcome: planned.outcome, confirmed: true };
        if (Date.now() >= deadline) {
            // Replayed against a newer document the change can turn into the limit refusal.
            const replay = latest ? applyLinkedPullRequestChange(latest, change).outcome : planned.outcome;
            return { outcome: replay === 'limit' ? 'limit' : planned.outcome, confirmed: false };
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
}

function linkReply(outcome: LinkedPullRequestOutcome, name: string): ToolReply {
    switch (outcome) {
        case 'linked': return reply(`Linked ${name} to this conversation.`);
        case 'already-linked': return reply(`${name} is already linked to this conversation; nothing changed.`);
        case 'limit': return reply(LIMIT_REACHED, true);
        case 'unlinked': return reply(`Unlinked ${name}. If a Saycode Desktop was watching it, that Desktop stops watching when it sees the change.`);
        case 'not-linked': return reply(`${name} is not linked to this conversation; nothing changed.`);
        default: return reply(`Unexpected result ${outcome}.`, true);
    }
}

function watchReply(outcome: LinkedPullRequestOutcome, name: string): ToolReply {
    switch (outcome) {
        case 'watch-requested': return reply(`Recorded a request to watch ${name} (linked to this conversation if it was not). ${WATCH_NOTE}`);
        case 'watch-already-requested': return reply(`A request to watch ${name} was already recorded; nothing changed. ${WATCH_NOTE}`);
        case 'watch-stopped': return reply(`Recorded a request to stop watching ${name}. The watching Desktop, if any, stops when it sees the change; ${name} stays linked.`);
        case 'watch-not-requested': return reply(`Watching ${name} was not requested; nothing changed.`);
        case 'not-linked': return reply(`${name} is not linked to this conversation; nothing changed.`);
        case 'limit': return reply(LIMIT_REACHED, true);
        default: return reply(`Unexpected result ${outcome}.`, true);
    }
}

function confirmed(result: { outcome: LinkedPullRequestOutcome; confirmed: boolean }, render: (outcome: LinkedPullRequestOutcome) => ToolReply): ToolReply {
    if (result.confirmed || result.outcome === 'limit') return render(result.outcome);
    return reply(NOT_CONFIRMED, true);
}

const urlInput = z.string().max(2048).describe('The pull request URL, https://github.com/<owner>/<repo>/pull/<n>.');

export function registerLinkedPullRequestTools(mcp: McpServer, options: LinkedPullRequestToolOptions): void {
    const now = options.now ?? Date.now;

    mcp.registerTool('saycode_pr_link', {
        title: 'Linked pull requests',
        description: 'Link a GitHub pull request to this conversation, unlink one, or list the linked ones with their watch status. Use link after you open a pull request the user should follow from this conversation, including one in another repository. Only the URL is checked; GitHub is not contacted. At most 20 pull requests can be linked.',
        inputSchema: {
            action: z.enum(['link', 'unlink', 'list']),
            url: urlInput.optional().describe('Required for link and unlink.'),
        },
    }, async ({ action, url }) => options.runTool(async () => {
        if (action === 'list') {
            const metadata = options.client.getMetadata();
            return metadata ? reply(renderLinkedPullRequestList(metadata, now())) : reply(NO_METADATA, true);
        }
        const pr = url === undefined ? null : parsePullRequestUrl(url);
        if (!pr) return reply(NOT_A_PR_URL, true);
        const result = await record(options, action === 'link' ? { kind: 'link', pr, by: 'agent', at: now() } : { kind: 'unlink', pr });
        return result ? confirmed(result, (outcome) => linkReply(outcome, `${pr.repo}#${pr.number}`)) : reply(NO_METADATA, true);
    }));

    mcp.registerTool('saycode_pr_watch', {
        title: 'Request pull request watching',
        description: 'Ask Saycode Desktop to watch a pull request of this conversation (CI, review bots, conflicts, merge readiness) and send you follow-up work, or to stop. start links the pull request first if needed. This only records the request: watching runs in a Saycode Desktop that picks it up, so never say watching has started; check with saycode_pr_link list.',
        inputSchema: {
            action: z.enum(['start', 'stop']),
            url: urlInput,
        },
    }, async ({ action, url }) => options.runTool(async () => {
        const pr = parsePullRequestUrl(url);
        if (!pr) return reply(NOT_A_PR_URL, true);
        const result = await record(options, { kind: 'watch', pr, requested: action === 'start', by: 'agent', at: now() });
        return result ? confirmed(result, (outcome) => watchReply(outcome, `${pr.repo}#${pr.number}`)) : reply(NO_METADATA, true);
    }));
}
