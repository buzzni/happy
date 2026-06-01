import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// specs/session-list-keepalive-bump — regression test for the bug where
// keepalive flushes were calling `db.session.update`, which triggered
// Prisma's `@updatedAt` decorator and bumped `Session.updatedAt` on every
// flush. The fix replaces that path with `db.$executeRaw` so only the
// intended `lastActiveAt` + `active` columns are touched.

let sessionUpdateMock: any;
let machineUpdateMock: any;
let executeRawMock: any;
let executeRawCalls: Array<{ strings: TemplateStringsArray; values: any[] }>;

vi.mock("@/storage/db", () => ({
    db: {
        get session() {
            return { update: sessionUpdateMock };
        },
        get machine() {
            return { update: machineUpdateMock };
        },
        $executeRaw: (strings: TemplateStringsArray, ...values: any[]) => {
            executeRawCalls.push({ strings, values });
            return Promise.resolve(1);
        },
    },
}));

vi.mock("@/utils/log", () => ({
    log: vi.fn(),
}));

vi.mock("@/app/monitoring/metrics2", () => ({
    sessionCacheCounter: { inc: vi.fn() },
    databaseUpdatesSkippedCounter: { inc: vi.fn() },
}));

// Import after mocks are wired so the module-load-time `setInterval` and
// `new ActivityCache()` see the mocked db.
import { activityCache } from "./sessionCache";

function primeCacheEntry(sessionId: string, userId: string, validUntilOffset = 60_000) {
    // Reach into the private map via cast — the public surface only exposes
    // queue/flush, but tests need to seed an entry without hitting the DB.
    const cache = (activityCache as any).sessionCache as Map<string, any>;
    cache.set(sessionId, {
        validUntil: Date.now() + validUntilOffset,
        lastUpdateSent: 0,
        pendingUpdate: null,
        userId,
    });
}

async function flushNow(): Promise<void> {
    await (activityCache as any).flushPendingUpdates();
}

beforeEach(() => {
    sessionUpdateMock = vi.fn();
    machineUpdateMock = vi.fn();
    executeRawCalls = [];
    // Clear any leftover state between tests.
    const cache = (activityCache as any).sessionCache as Map<string, any>;
    cache.clear();
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("sessionCache.flushPendingUpdates — keepalive must not bump Session.updatedAt", () => {
    it("queueSessionUpdate + flush uses $executeRaw (NOT db.session.update)", async () => {
        primeCacheEntry("sess-A", "user-1");
        const queued = activityCache.queueSessionUpdate("sess-A", Date.now());
        expect(queued).toBe(true);

        await flushNow();

        // Critical invariant: prisma's session.update must NOT be called.
        // That path triggers @updatedAt and is the source of the bug.
        expect(sessionUpdateMock).not.toHaveBeenCalled();
        expect(executeRawCalls.length).toBe(1);
    });

    it("raw SQL UPDATE only references lastActiveAt + active + id (NOT updatedAt)", async () => {
        primeCacheEntry("sess-B", "user-1");
        activityCache.queueSessionUpdate("sess-B", Date.now());
        await flushNow();

        expect(executeRawCalls.length).toBe(1);
        const sql = executeRawCalls[0].strings.join("?");
        // The keepalive UPDATE must touch only these columns. If a future
        // contributor adds "updatedAt" to the SET list, this test catches it.
        expect(sql).toMatch(/UPDATE\s+"Session"/);
        expect(sql).toMatch(/"lastActiveAt"/);
        expect(sql).toMatch(/"active"/);
        expect(sql).toMatch(/WHERE\s+"id"/);
        expect(sql).not.toMatch(/"updatedAt"/);
    });

    it("flushes multiple queued sessions in parallel via $executeRaw", async () => {
        primeCacheEntry("sess-X", "user-1");
        primeCacheEntry("sess-Y", "user-1");
        activityCache.queueSessionUpdate("sess-X", Date.now());
        activityCache.queueSessionUpdate("sess-Y", Date.now());

        await flushNow();

        expect(executeRawCalls.length).toBe(2);
        expect(sessionUpdateMock).not.toHaveBeenCalled();
    });

    it("machine keepalive path is intentionally untouched in this spec (out of scope)", async () => {
        // Sanity check the symmetric branch — we left machine.update alone
        // because Machine list ordering uses lastActiveAt and no user-visible
        // regression has been reported. Future spec can extend coverage.
        primeCacheEntry("sess-Z", "user-1");
        activityCache.queueSessionUpdate("sess-Z", Date.now());
        await flushNow();
        // sessions used raw SQL; machine.update remains the Prisma path.
        expect(executeRawCalls.length).toBe(1);
    });
});
