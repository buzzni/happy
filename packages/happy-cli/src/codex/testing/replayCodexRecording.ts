/**
 * Test-only replay of recorded Codex app-server sessions
 * (`src/codex/__fixtures__/subagent-recordings/*.jsonl`, provenance in the README there).
 *
 * `createFakeProcess` stands in for the spawned `codex app-server` so a test can drive the real
 * `CodexAppServerClient` with what Codex actually sent. It answers the client's own lifecycle
 * requests (initialize, thread/start, turn/start, …) itself, answers `thread/read` and
 * `thread/loaded/list` with the replies Codex gave in the recording, and, once the client sends
 * `turn/start`, writes every recorded server notification to stdout in recorded order — one line
 * per timer, recorded gaps divided by `timeScale`. Every delay goes through `setTimer`, which
 * defaults to the global `setTimeout` looked up at call time, so `vi.useFakeTimers()` makes a
 * replay deterministic.
 */
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { Readable, Writable } from 'node:stream';

export type RecordedRpcMessage = {
    id?: number | string;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: unknown;
};

/** One recorded JSON-RPC line: `t` is ms since the recorder spawned Codex, `dir` is `out` (client → Codex) or `in`. */
export type RecordedLine = { t: number; ts: string; dir: string; msg: RecordedRpcMessage };

type RecordedReply = { result?: unknown; error?: unknown; latencyMs: number };

export type Recording = {
    name: string;
    mainThreadId: string;
    mainTurnId: string;
    model: string;
    /** Server notifications and server → client requests, in recorded order. */
    inbound: RecordedLine[];
    /** Codex's replies to `thread/read` (per thread) and `thread/loaded/list`, in the order it gave them. */
    replies: Map<string, RecordedReply[]>;
};

export type FakeCodexProcessOptions = {
    /** Recorded gaps (and recorded reply latencies) are divided by this. Default 10. */
    timeScale?: number;
    /** Schedules every reply and every recorded line. Default: the global `setTimeout`, looked up per call. */
    setTimer?: (callback: () => void, ms: number) => unknown;
    /** Sees each JSON-RPC message the client writes, before it is answered. */
    onRequest?: (message: RecordedRpcMessage) => void;
    /** Sees each recorded inbound line right before it is written to stdout. */
    onPush?: (line: RecordedLine) => void;
    /** Overrides the reply to a client request; `undefined` keeps the default reply. */
    respond?: (message: RecordedRpcMessage) => { result: unknown } | { error: unknown } | undefined;
};

export type FakeCodexProcess = EventEmitter & {
    stdin: Writable;
    stdout: Readable;
    stderr: Readable;
    pid: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: (signal?: NodeJS.Signals) => boolean;
    /** Every JSON-RPC message the client wrote, in order. */
    requests: RecordedRpcMessage[];
    /** Delay from the replay start to the last recorded line, after scaling. */
    replayDurationMs: number;
    /** Resolves when the replay is scheduled (5ms after the client's `turn/start`). */
    replayStarted: Promise<void>;
    /** Resolves after the last recorded line has been written. */
    replayDone: Promise<void>;
};

const DEFAULT_TIME_SCALE = 10;
const LIFECYCLE_REPLY_DELAY_MS = 2;
const REPLAY_START_DELAY_MS = 5;
const EXIT_DELAY_MS = 5;
const SUBAGENT_ITEM_TYPES = new Set(['collabAgentToolCall', 'subAgentActivity']);

function field(value: unknown, key: string): unknown {
    return value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

/** The thread a recorded line belongs to, if it names one. */
export function threadIdOf(line: RecordedLine): string | null {
    const threadId = field(line.msg.params, 'threadId') ?? field(field(line.msg.params, 'thread'), 'id');
    return typeof threadId === 'string' && threadId.length > 0 ? threadId : null;
}

function replyKey(method: string | undefined, params: unknown): string | null {
    if (method === 'thread/loaded/list') return method;
    const threadId = field(params, 'threadId');
    return method === 'thread/read' && typeof threadId === 'string' ? `thread/read ${threadId}` : null;
}

export function loadRecording(path: string): Recording {
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as RecordedLine);
    const requests = new Map<number | string, RecordedLine>();
    for (const line of lines) {
        if (line.dir === 'out' && line.msg.id != null && line.msg.method) requests.set(line.msg.id, line);
    }
    let mainThreadId = '';
    let mainTurnId = '';
    let model = '';
    const replies = new Map<string, RecordedReply[]>();
    for (const line of lines) {
        const request = line.dir === 'in' && line.msg.id != null && !line.msg.method ? requests.get(line.msg.id) : undefined;
        if (!request) continue;
        const { method, params } = request.msg;
        if (method === 'thread/start' && line.msg.result !== undefined) {
            mainThreadId = String(field(field(line.msg.result, 'thread'), 'id') ?? '');
            model = String(field(line.msg.result, 'model') ?? '');
        }
        if (method === 'turn/start' && line.msg.result !== undefined && !mainTurnId) {
            mainTurnId = String(field(field(line.msg.result, 'turn'), 'id') ?? '');
        }
        const key = replyKey(method, params);
        if (!key) continue;
        const recorded = replies.get(key) ?? [];
        recorded.push({ result: line.msg.result, error: line.msg.error, latencyMs: line.t - request.t });
        replies.set(key, recorded);
    }
    const inbound = lines.filter((line) => line.dir === 'in' && typeof line.msg.method === 'string');
    return { name: basename(path), mainThreadId, mainTurnId, model, inbound, replies };
}

/** Only lines of the main thread or of no thread: what a perfect thread separation lets through. */
export function mainOnly(recording: Recording): Recording {
    const inbound = recording.inbound.filter((line) => {
        const threadId = threadIdOf(line);
        return !threadId || threadId === recording.mainThreadId;
    });
    return { ...recording, name: `${recording.name}#main-only`, inbound };
}

/** An ordinary session: `mainOnly` minus the parent-side sub-agent items (`collabAgentToolCall`, `subAgentActivity`). */
export function noSubagent(recording: Recording): Recording {
    const inbound = mainOnly(recording).inbound.filter((line) => {
        const itemType = field(field(line.msg.params, 'item'), 'type');
        return typeof itemType !== 'string' || !SUBAGENT_ITEM_TYPES.has(itemType);
    });
    return { ...recording, name: `${recording.name}#no-subagent`, inbound };
}

export function createFakeProcess(recording: Recording, opts: FakeCodexProcessOptions = {}): FakeCodexProcess {
    const timeScale = opts.timeScale ?? DEFAULT_TIME_SCALE;
    const setTimer = opts.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const push = (payload: unknown) => { stdout.push(`${JSON.stringify(payload)}\n`); };
    const requests: RecordedRpcMessage[] = [];
    const replyCursor = new Map<string, number>();

    // Monotonic integer delays: same-delay timers fire in insertion order, so recorded order holds.
    const first = recording.inbound[0]?.t ?? 0;
    let offset = 0;
    const schedule = recording.inbound.map((line) => {
        offset = Math.max(offset, line.t - first);
        return { line, delayMs: Math.floor(offset / timeScale) };
    });
    const replayDurationMs = schedule.at(-1)?.delayMs ?? 0;

    let markStarted!: () => void;
    let markDone!: () => void;
    const replayStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const replayDone = new Promise<void>((resolve) => { markDone = resolve; });
    let replayScheduled = false;
    const startReplay = () => {
        if (replayScheduled) return;
        replayScheduled = true;
        for (const { line, delayMs } of schedule) {
            setTimer(() => {
                opts.onPush?.(line);
                push(line.msg);
            }, delayMs);
        }
        setTimer(markDone, replayDurationMs);
        markStarted();
    };

    const reply = (id: number | string, answer: { result?: unknown; error?: unknown }, delayMs: number) => {
        setTimer(() => push(answer.error !== undefined ? { id, error: answer.error } : { id, result: answer.result }), delayMs);
    };
    const answerFromRecording = (id: number | string, key: string | null, fallback: { result?: unknown; error?: unknown }) => {
        const recorded = key ? recording.replies.get(key) : undefined;
        if (!key || !recorded?.length) {
            reply(id, fallback, LIFECYCLE_REPLY_DELAY_MS);
            return;
        }
        // The n-th request gets Codex's n-th recorded reply (the last one repeats), after its recorded latency.
        const index = Math.min(replyCursor.get(key) ?? 0, recorded.length - 1);
        replyCursor.set(key, index + 1);
        reply(id, recorded[index], Math.max(1, Math.round(recorded[index].latencyMs / timeScale)));
    };
    const answer = (message: RecordedRpcMessage & { id: number | string; method: string }) => {
        const custom = opts.respond?.(message);
        if (custom) return reply(message.id, custom, LIFECYCLE_REPLY_DELAY_MS);
        const key = replyKey(message.method, message.params);
        switch (message.method) {
            case 'initialize':
                return reply(message.id, { result: { userAgent: 'replay' } }, LIFECYCLE_REPLY_DELAY_MS);
            case 'thread/start':
            case 'thread/resume':
                return reply(message.id, {
                    result: { thread: { id: recording.mainThreadId, ephemeral: true }, model: recording.model },
                }, LIFECYCLE_REPLY_DELAY_MS);
            case 'turn/start':
                reply(message.id, { result: { turn: { id: recording.mainTurnId } } }, LIFECYCLE_REPLY_DELAY_MS);
                setTimer(startReplay, REPLAY_START_DELAY_MS);
                return;
            case 'thread/read':
                return answerFromRecording(message.id, key, {
                    error: { code: -32600, message: `replay: no recorded thread/read for ${String(field(message.params, 'threadId'))}` },
                });
            case 'thread/loaded/list':
                return answerFromRecording(message.id, key, {
                    result: { data: [recording.mainThreadId], nextCursor: null },
                });
            case 'thread/backgroundTerminals/list':
                return reply(message.id, { result: { data: [], nextCursor: null } }, LIFECYCLE_REPLY_DELAY_MS);
            default:
                return reply(message.id, { result: {} }, LIFECYCLE_REPLY_DELAY_MS);
        }
    };

    const stdin = new Writable({
        write(chunk: Buffer | string, _encoding, callback) {
            for (const text of chunk.toString().split('\n')) {
                if (!text.trim()) continue;
                let message: RecordedRpcMessage;
                try {
                    message = JSON.parse(text) as RecordedRpcMessage;
                } catch {
                    continue;
                }
                requests.push(message);
                opts.onRequest?.(message);
                if (message.id != null && typeof message.method === 'string') {
                    answer({ ...message, id: message.id, method: message.method });
                }
            }
            callback();
        },
    });

    const proc: FakeCodexProcess = Object.assign(new EventEmitter(), {
        stdin,
        stdout,
        stderr,
        pid: 4242,
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        kill: (signal?: NodeJS.Signals) => {
            setTimer(() => {
                if (proc.exitCode !== null) return;
                proc.exitCode = 0;
                proc.emit('exit', 0, signal ?? null);
            }, EXIT_DELAY_MS);
            return true;
        },
        requests,
        replayDurationMs,
        replayStarted,
        replayDone,
    });
    return proc;
}

/** Drops the fields that differ on every run (`id`, `time`) so envelope streams can be compared. */
export function stableEnvelope<T extends { id?: unknown; time?: unknown }>(envelope: T): Omit<T, 'id' | 'time'> {
    const { id: _id, time: _time, ...rest } = envelope;
    return rest;
}
