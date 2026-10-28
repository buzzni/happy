/**
 * Replays the recorded Codex sub-agent sessions (`__fixtures__/subagent-recordings/`) through the real
 * CodexAppServerClient and the session-protocol mapper, wired the way runCodex wires them, on fake
 * timers.
 *
 * - identity: the no-subagent cut of each recording (main thread only, parent-side sub-agent items
 *   removed — an ordinary session) must reproduce `golden/<name>.no-subagent.json` exactly. Only the
 *   envelope `id`/`time` are dropped and the mapper's random turn ids renumbered by first
 *   appearance; `subagent_tasks` snapshots (session metadata, newer than the golden) are checked on
 *   their own. Passes on the runtime before the sub-agent work and must keep passing after it.
 * - full stream: the behaviour for the complete recordings — the main turn reported once, no child
 *   text, one `CodexAgent` row inside the main turn, and the running list (design §1.2–§1.4).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { SessionEnvelope } from '@slopus/happy-wire';
import { CodexAppServerClient } from './codexAppServerClient';
import type { EventMsg } from './codexAppServerTypes';
import { mapCodexMcpMessageToSessionEnvelopes, type CodexTurnState } from './utils/sessionProtocolMapper';
import {
    createFakeProcess,
    loadRecording,
    noSubagent,
    stableEnvelope,
    threadIdOf,
    type RecordedLine,
    type Recording,
} from './testing/replayCodexRecording';

const {
    mockExecSync,
    mockSpawn,
    mockResolveCodexStateEnvironment,
    mockPrepareCodexMultiAuthProxy,
} = vi.hoisted(() => ({
    mockExecSync: vi.fn(),
    mockSpawn: vi.fn(),
    mockResolveCodexStateEnvironment: vi.fn(async (env: Record<string, string>) => env),
    mockPrepareCodexMultiAuthProxy: vi.fn(async () => null),
}));

vi.mock('./codexStateRecovery', () => ({ resolveCodexStateEnvironment: mockResolveCodexStateEnvironment }));

vi.mock('node:child_process', () => ({
    execSync: mockExecSync,
    spawn: mockSpawn,
}));

vi.mock('cross-spawn', () => ({
    spawn: mockSpawn,
}));

vi.mock('@/sandbox/manager', () => ({
    initializeSandbox: vi.fn(),
    wrapForMcpTransport: vi.fn(),
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        debugLargeJson: vi.fn(),
    },
}));

vi.mock('./codexMultiAuthProxy', () => ({
    prepareCodexMultiAuthProxy: mockPrepareCodexMultiAuthProxy,
}));

const FIXTURE_DIR = join(__dirname, '__fixtures__', 'subagent-recordings');
/**
 * Fake time watched after the last recorded line, for trailing timers (delta flush, final-answer
 * fallback, sub-agent label wait). For these recordings the window closes before the 5s initial
 * background refresh, so no `background_tasks` snapshot is part of the output.
 */
const SETTLE_MS = 2_000;
/** Bound on 1ms steps while waiting for a request/reply phase (connect, thread start, …). */
const SETTLE_STEP_LIMIT = 10_000;

/**
 * What each recording shows (see the fixture README): the one child it spawns, the label Codex's TUI
 * would give it (its nickname; no role was assigned), the main turn's own preview text, and whether
 * the child is still running when the main turn ends.
 */
const FIXTURES = [
    { name: 'a-default-terra-v2', childThreadId: '01a17e3f-c662-7f91-badc-ed6f4599c813', label: 'Linnaeus', mainStreamText: 'DONE', childOutlivesMainTurn: false },
    { name: 'a-luna-v1', childThreadId: '01a17e45-7995-7073-95b8-8199e9c068cc', label: 'Plato', mainStreamText: 'DONE', childOutlivesMainTurn: false },
    { name: 'b-default-terra-v2', childThreadId: '01a17e40-b32d-7682-ad6c-ea3b9dfa0034', label: 'Hume', mainStreamText: 'SPAWNED', childOutlivesMainTurn: true },
    { name: 'b-luna-v1', childThreadId: '01a17e45-b4f1-7ef1-9495-994311ed86f6', label: 'Mencius', mainStreamText: 'SPAWNED', childOutlivesMainTurn: true },
    { name: 'c-default-terra-v2', childThreadId: '01a17e41-e23a-7301-ab87-41c04c0215d1', label: 'Epicurus', mainStreamText: '', childOutlivesMainTurn: false },
    { name: 'c-default-terra-v2-retry', childThreadId: '01a17e49-9126-7e10-838b-fa98c0443066', label: 'Bohr', mainStreamText: '', childOutlivesMainTurn: true },
] as const;

type Fixture = (typeof FIXTURES)[number];

type TimelineEntry =
    | { kind: 'push'; line: RecordedLine }
    | { kind: 'event'; event: EventMsg }
    | { kind: 'resolved' };

/** A mapper envelope without `id`/`time`, tagged with the index of the event that produced it; turns renumbered 1, 2, … */
type EnvelopeRow = Omit<SessionEnvelope, 'id' | 'time' | 'turn'> & { atEvent: number; turn?: number };

type ReplayOutput = {
    events: EventMsg[];
    /** `subagent_tasks` snapshots, kept out of `events`; `atEvent` is how many events came before each. */
    snapshots: Array<{ atEvent: number; snapshot: unknown }>;
    envelopes: EnvelopeRow[];
    /** Concatenated `agent_message_delta` text: what runCodex streams to the preview. */
    streamDeltaText: string;
    /** `events.length` when `sendTurnAndWait` resolved; null if it never did. */
    resolvedAt: number | null;
    /** Recorded lines as written to the client, events and the turn resolution, interleaved in order. */
    timeline: TimelineEntry[];
};

/**
 * Kept away from the mapper. In runCodex, deltas go to the stream preview, background_tasks and
 * subagent_tasks to metadata, plan_update to its own plan envelope and reasoning/turn_diff through
 * processors (those side envelopes are not modelled here); codex_usage and token_count do reach the
 * mapper there, which maps them to nothing.
 */
const NOT_MAPPED = new Set([
    'agent_message_delta',
    'background_tasks',
    'subagent_tasks',
    'codex_usage',
    'token_count',
    'plan_update',
    'agent_reasoning_delta',
    'agent_reasoning',
    'agent_reasoning_section_break',
    'turn_diff',
]);

const LIFECYCLE_EVENTS = new Set(['task_started', 'task_complete', 'turn_aborted']);

/** Moves fake time in 1ms steps until `promise` settles, so replies scheduled on fake timers arrive. */
async function advanceUntilSettled<T>(promise: Promise<T>, what: string): Promise<T> {
    let settled = false;
    promise.then(() => { settled = true; }, () => { settled = true; });
    for (let step = 0; !settled && step < SETTLE_STEP_LIMIT; step++) {
        await vi.advanceTimersByTimeAsync(1);
    }
    if (!settled) throw new Error(`replay: ${what} did not settle within ${SETTLE_STEP_LIMIT}ms of fake time`);
    return promise;
}

function renumberTurns(rows: Array<Omit<SessionEnvelope, 'id' | 'time'> & { atEvent: number }>): EnvelopeRow[] {
    const numbers = new Map<string, number>();
    return rows.map(({ turn, ...row }) => {
        if (turn === undefined) return row;
        if (!numbers.has(turn)) numbers.set(turn, numbers.size + 1);
        return { ...row, turn: numbers.get(turn) };
    });
}

/** The mapper state runCodex starts a session with. */
function newTurnState(): CodexTurnState {
    return {
        currentTurnId: null,
        currentProviderTurnId: null,
        startedSubagents: new Set<string>(),
        activeSubagents: new Set<string>(),
        providerSubagentToSessionSubagent: new Map<string, string>(),
        pendingRequestId: null,
        currentRequestId: null,
        providerTurnToProtocol: new Map<string, string>(),
    };
}

/** Drives one recording through the client, feeds its events to the mapper the way runCodex does, and records what comes out. */
async function replay(recording: Recording): Promise<ReplayOutput> {
    vi.useFakeTimers();
    try {
        const timeline: TimelineEntry[] = [];
        const events: EventMsg[] = [];
        const snapshots: ReplayOutput['snapshots'] = [];
        const rows: Array<Omit<SessionEnvelope, 'id' | 'time'> & { atEvent: number }> = [];
        let streamDeltaText = '';
        let resolvedAt: number | null = null;
        // Same carried state as runCodex's event handler.
        const turnState = newTurnState();

        const proc = createFakeProcess(recording, { onPush: (line) => { timeline.push({ kind: 'push', line }); } });
        mockExecSync.mockReturnValue('codex-cli 0.157.1');
        mockSpawn.mockReturnValue(proc);
        const client = new CodexAppServerClient();
        client.setEventHandler((event) => {
            timeline.push({ kind: 'event', event });
            // The running list is session metadata, compared on its own; the golden event stream predates it.
            if (event.type === 'subagent_tasks') snapshots.push({ atEvent: events.length, snapshot: event.snapshot });
            else events.push(event);
            if (event.type === 'agent_message_delta' && typeof event.delta === 'string') streamDeltaText += event.delta;
            if (NOT_MAPPED.has(event.type)) return;
            const mapped = mapCodexMcpMessageToSessionEnvelopes(event, turnState, false);
            turnState.currentTurnId = mapped.currentTurnId;
            turnState.currentProviderTurnId = mapped.currentProviderTurnId;
            turnState.startedSubagents = mapped.startedSubagents;
            turnState.activeSubagents = mapped.activeSubagents;
            turnState.providerSubagentToSessionSubagent = mapped.providerSubagentToSessionSubagent;
            for (const envelope of mapped.envelopes) rows.push({ atEvent: events.length - 1, ...stableEnvelope(envelope) });
        });

        await advanceUntilSettled(client.connect(), 'connect');
        await advanceUntilSettled(client.startThread({ cwd: '/replay', approvalPolicy: 'never', sandbox: 'read-only' }), 'thread/start');
        const turn = client.sendTurnAndWait('replayed prompt', { turnTimeoutMs: 120_000 }).then(
            () => {
                resolvedAt = events.length;
                timeline.push({ kind: 'resolved' });
            },
            () => {},
        );
        await advanceUntilSettled(proc.replayStarted, 'turn/start');
        await vi.advanceTimersByTimeAsync(proc.replayDurationMs + SETTLE_MS);

        const output: ReplayOutput = {
            events: [...events],
            snapshots: [...snapshots],
            envelopes: renumberTurns(rows),
            streamDeltaText,
            resolvedAt,
            timeline: [...timeline],
        };
        await advanceUntilSettled(client.disconnect(), 'disconnect');
        await advanceUntilSettled(turn, 'turn settlement');
        return output;
    } finally {
        vi.useRealTimers();
    }
}

function describeEvent(event: EventMsg): string {
    return event.type
        + (event.turn_id ? `(turn=${String(event.turn_id).slice(-6)})` : '')
        + (event.item_id ? `[item=${String(event.item_id).slice(0, 10)}]` : '')
        + (event.call_id ? `[call=${String(event.call_id).slice(0, 10)}]` : '');
}

function describeEnvelope(row: EnvelopeRow): string {
    const ev: Record<string, unknown> = row.ev;
    return `${row.atEvent}:${row.role}:${String(ev.t)}`
        + (ev.status ? `/${String(ev.status)}` : '')
        + (row.turn ? ` turn=${row.turn}` : '')
        + (ev.text ? ` text=${JSON.stringify(String(ev.text).slice(0, 40))}` : '')
        + (ev.name ? ` name=${String(ev.name)}` : '');
}

/** The shape stored in `golden/<name>.no-subagent.json`. */
function goldenView(output: ReplayOutput) {
    return {
        resolvedAt: output.resolvedAt,
        eventTypes: output.events.map(describeEvent),
        envelopeSummary: output.envelopes.map(describeEnvelope),
        streamDeltaText: output.streamDeltaText,
        events: output.events,
        envelopes: output.envelopes,
    };
}

function loadFixture(name: string): Recording {
    return loadRecording(join(FIXTURE_DIR, `${name}.jsonl`));
}

const fullReplays = new Map<string, Promise<{ recording: Recording; output: ReplayOutput }>>();

/** The complete recording replayed once per fixture and shared by the full-stream tests. */
function replayFull(fixture: Fixture): Promise<{ recording: Recording; output: ReplayOutput }> {
    let pending = fullReplays.get(fixture.name);
    if (!pending) {
        const recording = loadFixture(fixture.name);
        pending = replay(recording).then((output) => ({ recording, output }));
        fullReplays.set(fixture.name, pending);
    }
    return pending;
}

/** Timeline index of the main thread's own end of the turn: its idle status or turn/completed, whichever comes first. */
function mainTurnEndIndex(timeline: TimelineEntry[], recording: Recording): number {
    const mainLine = (entry: TimelineEntry, method: string): RecordedLine | null =>
        entry.kind === 'push' && entry.line.msg.method === method && threadIdOf(entry.line) === recording.mainThreadId
            ? entry.line
            : null;
    const started = timeline.findIndex((entry) => mainLine(entry, 'turn/started') !== null);
    if (started < 0) return -1;
    return timeline.findIndex((entry, index) => {
        if (index <= started) return false;
        if (mainLine(entry, 'turn/completed')) return true;
        const statusChange = mainLine(entry, 'thread/status/changed')?.msg.params as { status?: { type?: unknown } } | undefined;
        return statusChange?.status?.type === 'idle';
    });
}

function snapshotTasks(snapshot: unknown): unknown[] | null {
    const tasks = snapshot !== null && typeof snapshot === 'object' ? (snapshot as { tasks?: unknown }).tasks : undefined;
    return Array.isArray(tasks) ? tasks : null;
}

describe('Codex sub-agent recordings replayed through CodexAppServerClient and the session mapper', () => {
    describe.each(FIXTURES)('$name', (fixture) => {
        it('identity: no-subagent stream reproduces the golden exactly', async () => {
            const golden: unknown = JSON.parse(readFileSync(join(FIXTURE_DIR, 'golden', `${fixture.name}.no-subagent.json`), 'utf8'));
            const output = await replay(noSubagent(loadFixture(fixture.name)));
            expect(goldenView(output)).toEqual(golden);
            // All an ordinary session gains: the empty initial list (session metadata), never an envelope —
            // not even through a mapper that is handed it.
            expect(output.snapshots.length).toBeGreaterThan(0);
            for (const { snapshot } of output.snapshots) {
                const { startedAt, ...state } = snapshot as { startedAt: unknown };
                expect(typeof startedAt).toBe('number');
                expect([{ available: true, tasks: [] }, { available: false, tasks: null }]).toContainEqual(state);
                expect(mapCodexMcpMessageToSessionEnvelopes({ type: 'subagent_tasks', snapshot }, newTurnState(), false).envelopes).toEqual([]);
            }
        });
    });
});

// Behaviour for the complete recordings (sub-agent work, design §1.2–§1.4).
describe('Codex sub-agent recordings: full stream target', () => {
    describe.each(FIXTURES)('$name', (fixture) => {
        it('full stream: main turn is reported exactly once and never completed by a child', async () => {
            const { recording, output } = await replayFull(fixture);
            const lifecycle = output.events
                .filter((event) => LIFECYCLE_EVENTS.has(event.type))
                .map((event) => ({ type: event.type, turn_id: event.turn_id }));
            expect(lifecycle).toEqual([
                { type: 'task_started', turn_id: recording.mainTurnId },
                { type: expect.stringMatching(/^(task_complete|turn_aborted)$/), turn_id: recording.mainTurnId },
            ]);
            // sendTurnAndWait resolves only once the main thread itself ends the turn, never on a child's signal.
            const mainEnd = mainTurnEndIndex(output.timeline, recording);
            expect(mainEnd).toBeGreaterThanOrEqual(0);
            expect(output.timeline.findIndex((entry) => entry.kind === 'resolved')).toBeGreaterThan(mainEnd);
        });

        it('full stream: child text never reaches the transcript or the stream preview', async () => {
            const { output } = await replayFull(fixture);
            expect(output.streamDeltaText).toBe(fixture.mainStreamText);
            const texts = output.envelopes.flatMap((row) => (row.ev.t === 'text' ? [row.ev.text] : []));
            expect(texts.filter((text) => text.includes('OK') || text.includes('1\n2'))).toEqual([]);
        });

        it('full stream: exactly one collab_agent_spawned event, inside the main turn', async () => {
            const { recording, output } = await replayFull(fixture);
            // The parent's item that confirms the spawn: V2 `subAgentActivity started`, V1 `spawnAgent` completed.
            const spawnItem = recording.inbound
                .filter((line) => line.msg.method === 'item/completed' && threadIdOf(line) === recording.mainThreadId)
                .map((line) => (line.msg.params as { item: Record<string, unknown> }).item)
                .find((item) => (item.type === 'subAgentActivity' && item.kind === 'started')
                    || (item.type === 'collabAgentToolCall' && item.tool === 'spawnAgent' && item.status === 'completed'));
            expect(spawnItem).toBeDefined();
            const rows = output.events.filter((event) => event.type === 'collab_agent_spawned');
            expect(rows).toEqual([{
                type: 'collab_agent_spawned',
                call_id: spawnItem?.id,
                turn_id: recording.mainTurnId,
                thread_id: fixture.childThreadId,
                label: fixture.label,
            }]);
            const row = output.events.indexOf(rows[0]);
            const turnStart = output.events.findIndex((event) => event.type === 'task_started' && event.turn_id === recording.mainTurnId);
            const turnEnd = output.events.findIndex((event) =>
                (event.type === 'task_complete' || event.type === 'turn_aborted') && event.turn_id === recording.mainTurnId);
            expect(turnStart).toBeGreaterThanOrEqual(0);
            expect(row).toBeGreaterThan(turnStart);
            expect(row).toBeLessThan(turnEnd);
        });

        it('full stream: exactly one CodexAgent row inside the main turn, none after it', async () => {
            const { output } = await replayFull(fixture);
            const rows = output.envelopes;
            const turnStarts = rows.filter((row) => row.ev.t === 'turn-start');
            const turnEnds = rows.filter((row) => row.ev.t === 'turn-end');
            expect(turnStarts).toHaveLength(1);
            expect(turnEnds).toHaveLength(1);
            const mainTurn = turnStarts[0].turn;
            // Nothing after the main turn ends.
            expect(rows.indexOf(turnEnds[0])).toBe(rows.length - 1);

            const agentStarts = rows.filter((row) => row.ev.t === 'tool-call-start' && row.ev.name === 'CodexAgent');
            expect(agentStarts).toHaveLength(1);
            const [agentStart] = agentStarts;
            expect(agentStart.turn).toBe(mainTurn);
            expect(agentStart.ev).toEqual({
                t: 'tool-call-start',
                call: fixture.childThreadId,
                name: 'CodexAgent',
                title: fixture.label,
                description: fixture.label,
                args: { agent: fixture.label },
            });
            const call = agentStart.ev.t === 'tool-call-start' ? agentStart.ev.call : null;
            const agentEnds = rows.filter((row) => row.ev.t === 'tool-call-end' && row.ev.call === call);
            expect(agentEnds).toHaveLength(1);
            const [agentEnd] = agentEnds;
            expect(agentEnd.turn).toBe(mainTurn);
            expect(agentEnd.ev).toEqual({ t: 'tool-call-end', call });

            const turnStartIndex = rows.indexOf(turnStarts[0]);
            const agentStartIndex = rows.indexOf(agentStart);
            const agentEndIndex = rows.indexOf(agentEnd);
            expect(agentStartIndex).toBeGreaterThan(turnStartIndex);
            expect(agentEndIndex).toBeGreaterThan(agentStartIndex);
            expect(agentEndIndex).toBeLessThan(rows.indexOf(turnEnds[0]));
        });

        it('full stream: subagent_tasks snapshots', async () => {
            const { recording, output } = await replayFull(fixture);
            // `index` counts the events before the snapshot, so `index > i` means "after event i".
            const published = output.snapshots.map(({ atEvent, snapshot }) => ({ index: atEvent, snapshot }));
            // Leading empty snapshots are the initial state published at connect / thread start.
            const firstRunning = published.findIndex(({ snapshot }) => (snapshotTasks(snapshot)?.length ?? 0) > 0);
            const afterFirstRunning = firstRunning < 0 ? [] : published.slice(firstRunning);
            expect(afterFirstRunning.map(({ snapshot }) => snapshot)).toEqual([
                { startedAt: expect.any(Number), available: true, tasks: [{ taskId: fixture.childThreadId, label: fixture.label, kind: 'agent' }] },
                { startedAt: expect.any(Number), available: true, tasks: [] },
            ]);
            // The list is emptied when the child finishes: after the main turn ended when the child outlives it.
            const mainTurnEnd = output.events.findIndex((event) =>
                (event.type === 'task_complete' || event.type === 'turn_aborted') && event.turn_id === recording.mainTurnId);
            expect(mainTurnEnd).toBeGreaterThanOrEqual(0);
            expect(afterFirstRunning[1].index > mainTurnEnd).toBe(fixture.childOutlivesMainTurn);
        });
    });
});
