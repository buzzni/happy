import { describe, expect, it, vi } from 'vitest';

import {
    LESSON_SESSION_BOOTSTRAP_BUDGET_MS,
    createLazyLessonSessionHost,
    createLessonSessionHost,
    lessonStateRoot,
    readLessonSessionKind,
    type LessonSessionHost,
} from './lessonSessionHost';
import {
    lessonReviewLedgerPath,
    lessonReviewOutcomePath,
    lessonSettingsPath,
} from './lessonSettingsStore';

const spawnContext = JSON.stringify({
    schemaVersion: 1, projectId: 'p1', worktreeId: null, checkpointRoot: '/tmp/checkpoints',
});

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
    return {
        HAPPY_APLUS_MCP_CONFIG_URL: 'https://studio.example/api/me/mcp-config',
        HAPPY_CHECKPOINT_SPAWN_CONTEXT: spawnContext,
        HAPPY_LESSON_DAEMON_HOME: '/tmp/happy-lesson-bootstrap',
        CLAUDE_MEMORY_LESSON_OWNER: 'host',
        ...overrides,
    } as NodeJS.ProcessEnv;
}

describe('lesson session bootstrap', () => {
    it('gives up on its own budget instead of holding the first turn open', async () => {
        // A studio that never answers. Every inner call has its own timeout,
        // but three in sequence still add up to a wait the user sits through.
        const hanging = vi.fn(() => new Promise<Response>(() => {}));
        (globalThis as { fetch: typeof fetch }).fetch = hanging as unknown as typeof fetch;

        const started = Date.now();
        const host = await createLessonSessionHost({
            accountToken: 'token',
            machineId: 'm1',
            sessionId: 's1',
            happyHomeDir: '/tmp/happy-lesson-bootstrap',
            env: env(),
            budgetMs: 150,
        });
        expect(host).toBeNull();
        expect(Date.now() - started).toBeLessThan(LESSON_SESSION_BOOTSTRAP_BUDGET_MS);
    });

    it('refuses without an account credential, which is what a managed run has', async () => {
        const fetchImpl = vi.fn();
        (globalThis as { fetch: typeof fetch }).fetch = fetchImpl as unknown as typeof fetch;
        expect(await createLessonSessionHost({
            accountToken: null, machineId: 'm1', sessionId: 's1',
            happyHomeDir: '/tmp/happy-lesson-bootstrap', env: env(),
        })).toBeNull();
        // Nothing is even asked for: there is no identity to ask with.
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('refuses without a trusted project id from the daemon', async () => {
        const fetchImpl = vi.fn();
        (globalThis as { fetch: typeof fetch }).fetch = fetchImpl as unknown as typeof fetch;
        expect(await createLessonSessionHost({
            accountToken: 'token', machineId: 'm1', sessionId: 's1',
            happyHomeDir: '/tmp/happy-lesson-bootstrap',
            env: env({ HAPPY_CHECKPOINT_SPAWN_CONTEXT: undefined }),
        })).toBeNull();
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('refuses when the studio origin is not configured', async () => {
        const fetchImpl = vi.fn();
        (globalThis as { fetch: typeof fetch }).fetch = fetchImpl as unknown as typeof fetch;
        expect(await createLessonSessionHost({
            accountToken: 'token', machineId: 'm1', sessionId: 's1',
            happyHomeDir: '/tmp/happy-lesson-bootstrap',
            env: env({ HAPPY_APLUS_MCP_CONFIG_URL: undefined }),
        })).toBeNull();
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});

describe('single lesson owner', () => {
    it('does not authenticate or review an explicitly disabled staged caller', async () => {
        const fetchImpl = vi.fn();
        (globalThis as { fetch: typeof fetch }).fetch = fetchImpl as unknown as typeof fetch;
        expect(await createLessonSessionHost({
            accountToken: 'token', machineId: 'm1', sessionId: 's1',
            happyHomeDir: '/tmp/happy-lesson-bootstrap',
            env: env({ HAPPY_LESSON_HOST_DISABLED: 'unsupported-caller' }),
        })).toBeNull();
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('does not inject when the launch left injection to the native hook', async () => {
        /*
         * The daemon decided `native` for this launch — because CML is too old
         * to stand down. A host that
         * injected anyway would put the same lessons in twice.
         */
        const fetchImpl = vi.fn();
        (globalThis as { fetch: typeof fetch }).fetch = fetchImpl as unknown as typeof fetch;
        expect(await createLessonSessionHost({
            accountToken: 'token', machineId: 'm1', sessionId: 's1',
            happyHomeDir: '/tmp/happy-lesson-bootstrap',
            env: env({ CLAUDE_MEMORY_LESSON_OWNER: undefined }),
        })).toBeNull();
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('refuses a marker that is not exactly the agreed value', async () => {
        const fetchImpl = vi.fn();
        (globalThis as { fetch: typeof fetch }).fetch = fetchImpl as unknown as typeof fetch;
        expect(await createLessonSessionHost({
            accountToken: 'token', machineId: 'm1', sessionId: 's1',
            happyHomeDir: '/tmp/happy-lesson-bootstrap',
            env: env({ CLAUDE_MEMORY_LESSON_OWNER: 'HOST' }),
        })).toBeNull();
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});

describe('state root agreement', () => {
    it('uses the daemon\'s root even when this provider\'s home was relocated', async () => {
        /*
         * The daemon relocates HAPPY_HOME_DIR per session for a collaborator's
         * credentials. Settings, the spending ledger and the review outcome are
         * the machine's, so they must not fork with the home — but the caller,
         * the grant and the permissions stay this session's.
         */
        expect(lessonStateRoot(env())).toBe('/tmp/happy-lesson-bootstrap');
        expect(lessonStateRoot(env({ HAPPY_LESSON_DAEMON_HOME: '/tmp/daemon-home' })))
            .toBe('/tmp/daemon-home');
    });

    it('is unsupported when the daemon never said what its root is', async () => {
        const fetchImpl = vi.fn();
        (globalThis as { fetch: typeof fetch }).fetch = fetchImpl as unknown as typeof fetch;
        expect(await createLessonSessionHost({
            accountToken: 'token', machineId: 'm1', sessionId: 's1',
            happyHomeDir: '/tmp/happy-lesson-bootstrap',
            env: env({ HAPPY_LESSON_DAEMON_HOME: undefined }),
        })).toBeNull();
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('names the same settings, ledger and outcome files from either home', () => {
        // Two runtimes, one machine: the UI's "recall off" and the machine-wide
        // budget only bind if both processes read the same files.
        const daemonRoot = lessonStateRoot(env())!;
        expect(lessonSettingsPath(daemonRoot, 'p1'))
            .toBe(lessonSettingsPath(lessonStateRoot(env())!, 'p1'));
        expect(lessonReviewLedgerPath(daemonRoot))
            .toBe(lessonReviewLedgerPath(lessonStateRoot(env())!));
        expect(lessonReviewOutcomePath(daemonRoot, 'p1'))
            .toBe(lessonReviewOutcomePath(lessonStateRoot(env())!, 'p1'));
        // And a different project is a different file.
        expect(lessonSettingsPath(daemonRoot, 'p1')).not.toBe(lessonSettingsPath(daemonRoot, 'p2'));
    });
});

describe('readLessonSessionKind', () => {
    it('reads an automation run from the daemon\'s own markers', () => {
        expect(readLessonSessionKind({ HAPPY_AUTOMATION_RUN_ONCE: '1' } as NodeJS.ProcessEnv))
            .toBe('automation');
        expect(readLessonSessionKind({ HAPPY_AUTOMATION_RESUME_PROMPT: '1' } as NodeJS.ProcessEnv))
            .toBe('automation');
    });

    it('treats an unmarked session as an ordinary one', () => {
        expect(readLessonSessionKind({} as NodeJS.ProcessEnv)).toBe('foreground');
    });
});

describe('lazy bootstrap', () => {
    it('returns at once and answers unsupported until it is ready', async () => {
        // A studio that never answers: the session must still start now.
        (globalThis as { fetch: typeof fetch }).fetch =
            (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
        const started = Date.now();
        const host = createLazyLessonSessionHost({
            accountToken: 'token', machineId: 'm1', sessionId: 's1',
            happyHomeDir: '/tmp/happy-lesson-bootstrap', env: env(), budgetMs: 100,
        });
        expect(Date.now() - started).toBeLessThan(50);
        expect(host.sessionKind).toBe('foreground');
        // Not "no lessons apply" — this host cannot answer yet, and says so.
        expect(await host.turn!.recall({ turnId: 't', query: 'anything' }))
            .toEqual({ outcome: 'unsupported' });
        expect(await host.review!.reviewFinishedTurn({
            record: {
                sessionId: 's1', turnId: 't', kind: 'foreground', endedNormally: true,
                hadPriorAssistantTurn: false, userMessages: ['x'], agentSummary: '',
                recoveredFailures: [],
            },
            signal: new AbortController().signal,
        })).toBe('unsupported');
        await host.close();
    });

    it('closes a host that finishes starting after it was disposed', async () => {
        (globalThis as { fetch: typeof fetch }).fetch =
            (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
        const host = createLazyLessonSessionHost({
            accountToken: 'token', machineId: 'm1', sessionId: 's1',
            happyHomeDir: '/tmp/happy-lesson-bootstrap', env: env(),
        });
        // Disposing before the bootstrap settles must not leave a store open.
        await expect(host.close()).resolves.toBeUndefined();
    });
});

describe('lazy bootstrap boundaries', () => {
    function stub(): LessonSessionHost & { closed: number } {
        const host = {
            closed: 0,
            sessionKind: 'foreground' as const,
            turn: {
                async recall() { return { outcome: 'ready' as never }; },
                async acknowledge() { return true; },
            },
            review: { async reviewFinishedTurn() { return 'reviewed' as never; } },
            async close() { host.closed += 1; },
        };
        return host as LessonSessionHost & { closed: number };
    }

    it('serves a host that took longer than the bootstrap budget to arrive', async () => {
        /*
         * The budgeted bootstrap answers null at its deadline and closes what
         * arrives afterwards — right for a caller that must proceed, wrong
         * here: it would leave the whole session without lessons because one
         * studio call was slow once. Nothing waits on the lazy path, so a late
         * host is simply the first one a turn can use.
         */
        const built = stub();
        let land!: () => void;
        const host = createLazyLessonSessionHost({
            accountToken: 'token', machineId: 'm1', sessionId: 's1',
            happyHomeDir: '/tmp/happy-lesson-bootstrap', env: env(),
            budgetMs: 5,
            bootstrap: () => new Promise((resolve) => { land = () => resolve(built); }),
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(await host.turn!.recall({ turnId: 't', query: 'x' })).toEqual({ outcome: 'unsupported' });

        land();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(await host.turn!.acknowledge({} as never)).toBe(true);
        expect(built.closed).toBe(0);
        await host.close();
        expect(built.closed).toBe(1);
    });

    it('does not hold shutdown open for a bootstrap that never lands', async () => {
        // The reason it never lands is usually the studio, which is also what
        // close would be waiting on.
        const host = createLazyLessonSessionHost({
            accountToken: 'token', machineId: 'm1', sessionId: 's1',
            happyHomeDir: '/tmp/happy-lesson-bootstrap', env: env(),
            bootstrap: () => new Promise(() => {}),
        });
        const started = Date.now();
        await host.close();
        expect(Date.now() - started).toBeLessThan(50);
    });

    it('closes a host that lands after shutdown instead of leaking the store', async () => {
        const built = stub();
        let land!: () => void;
        const host = createLazyLessonSessionHost({
            accountToken: 'token', machineId: 'm1', sessionId: 's1',
            happyHomeDir: '/tmp/happy-lesson-bootstrap', env: env(),
            bootstrap: () => new Promise((resolve) => { land = () => resolve(built); }),
        });
        await host.close();
        land();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(built.closed).toBe(1);
        // And it is never served to a turn that came after the close.
        expect(await host.turn!.recall({ turnId: 't', query: 'x' })).toEqual({ outcome: 'unsupported' });
    });
});
