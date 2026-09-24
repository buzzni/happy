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

function primeMachineCacheEntry(machineId: string, userId: string, validUntilOffset = 60_000) {
    const cache = (activityCache as any).machineCache as Map<string, any>;
    cache.set(machineId, {
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
    const sCache = (activityCache as any).sessionCache as Map<string, any>;
    sCache.clear();
    const mCache = (activityCache as any).machineCache as Map<string, any>;
    mCache.clear();
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

    it("session + machine flushed in same tick → both use $executeRaw", async () => {
        primeCacheEntry("sess-Z", "user-1");
        primeMachineCacheEntry("mach-Z", "user-1");
        activityCache.queueSessionUpdate("sess-Z", Date.now());
        activityCache.queueMachineUpdate("mach-Z", Date.now());
        await flushNow();
        // Both branches must now use raw SQL — symmetric semantics, neither
        // should call the Prisma model accessor that triggers @updatedAt.
        expect(executeRawCalls.length).toBe(2);
        expect(sessionUpdateMock).not.toHaveBeenCalled();
        expect(machineUpdateMock).not.toHaveBeenCalled();
    });
});

describe("sessionCache.flushPendingUpdates — Machine keepalive must not bump Machine.updatedAt", () => {
    it("queueMachineUpdate + flush uses $executeRaw (NOT db.machine.update)", async () => {
        primeMachineCacheEntry("mach-A", "user-1");
        const queued = activityCache.queueMachineUpdate("mach-A", Date.now());
        expect(queued).toBe(true);

        await flushNow();

        // Critical invariant: prisma's machine.update must NOT be called.
        // That path triggers @updatedAt and is the source of the symmetric
        // bug. See specs/machine-keepalive-bump.
        expect(machineUpdateMock).not.toHaveBeenCalled();
        expect(executeRawCalls.length).toBe(1);
    });

    it("raw SQL UPDATE references lastActiveAt + active + accountId + id (NOT updatedAt)", async () => {
        primeMachineCacheEntry("mach-B", "user-1");
        activityCache.queueMachineUpdate("mach-B", Date.now());
        await flushNow();

        expect(executeRawCalls.length).toBe(1);
        const sql = executeRawCalls[0].strings.join("?");
        expect(sql).toMatch(/UPDATE\s+"Machine"/);
        expect(sql).toMatch(/"lastActiveAt"/);
        expect(sql).toMatch(/"accountId"/);
        expect(sql).toMatch(/"id"/);
        // Same regression guard as the session branch — adding "updatedAt"
        // to the SET list would defeat the whole fix.
        expect(sql).not.toMatch(/SET[^W]*"updatedAt"/);
        // specs/machine-active-recovery AC1 — 이 단언은 원래 정반대였다
        // (`not.toMatch`). 근거는 "active toggling lives in
        // presence/timeout.ts" 였는데, timeout.ts 는 **끄기만** 하고 켜는
        // 주기적 경로가 어디에도 없었다. 그래서 데몬이 재연결해도 DB 의
        // active 가 false 로 남아 머신이 계속 offline 로 보였다. 세션
        // 브랜치는 이미 `"active" = true` 를 세팅하고 있어 비대칭이기도
        // 했다. 의도적으로 뒤집는다.
        expect(sql).toMatch(/SET[^W]*"active"/);
    });

    it("machine keepalive flush 가 active 를 true 로 되살린다", async () => {
        primeMachineCacheEntry("mach-C", "user-1");
        activityCache.queueMachineUpdate("mach-C", Date.now());
        await flushNow();

        const sql = executeRawCalls[0].strings.join("?");
        expect(sql).toMatch(/"active"\s*=\s*true/);
    });

    it("flushes multiple queued machines in parallel via $executeRaw", async () => {
        primeMachineCacheEntry("mach-X", "user-1");
        primeMachineCacheEntry("mach-Y", "user-2");
        activityCache.queueMachineUpdate("mach-X", Date.now());
        activityCache.queueMachineUpdate("mach-Y", Date.now());

        await flushNow();

        expect(executeRawCalls.length).toBe(2);
        expect(machineUpdateMock).not.toHaveBeenCalled();
    });
});

// 2026-09-24 prod: RDS 의 기본 TimeZone 이 Asia/Seoul 이고 lastActiveAt 은
// `timestamp without time zone` 이다. Prisma 엔진은 raw 쿼리의 Date 파라미터를
// timestamptz 로 보내므로, 서버가 세션 타임존으로 벽시계 변환을 하면서 keepalive
// 가 KST 값(9시간 미래)을 썼다. ORM 쓰기(markMachineOnline/Offline, timeout.ts
// 비교)는 UTC 값이라, 죽은 머신이 9시간 넘게 active 로 남았고 offline 쓰기의
// `lastActiveAt <= at` 가드도 매번 빗나갔다.
//
// 아래 하네스는 운영과 같은 조건을 PGlite 로 만든다: DB TimeZone 을 KST 로 두고,
// 코드가 만든 SQL 을 그대로 실행하되 Date 값은 Prisma 엔진처럼 timestamptz 로
// 바인딩한다.
describe("sessionCache.flushPendingUpdates — lastActiveAt 은 DB 세션 타임존과 무관하게 UTC 로 저장된다", () => {
    async function runCapturedAgainstKstDatabase(table: "Session" | "Machine") {
        const { PGlite } = await import("@electric-sql/pglite");
        const pg = new PGlite();
        try {
            await pg.exec(`
                SET TimeZone = 'Asia/Seoul';
                CREATE TABLE "${table}" (
                    "id" TEXT NOT NULL,
                    "accountId" TEXT,
                    "active" BOOLEAN NOT NULL DEFAULT false,
                    "lastActiveAt" TIMESTAMP(3) NOT NULL
                );
                INSERT INTO "${table}" ("id", "accountId", "lastActiveAt")
                VALUES ('row-1', 'user-1', '2000-01-01 00:00:00');
            `);
            const call = executeRawCalls[0];
            const sql = call.strings.reduce((acc, part, i) => {
                if (i === 0) return part;
                const value = call.values[i - 1];
                const cast = value instanceof Date ? "::timestamptz" : "";
                return `${acc}$${i}${cast}${part}`;
            });
            const params = call.values.map((value) => value instanceof Date ? value.toISOString() : value);
            await pg.query(sql, params);
            const row = await pg.query<{ at: string }>(
                `SELECT to_char("lastActiveAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at FROM "${table}" WHERE "id" = 'row-1'`,
            );
            return row.rows[0].at;
        } finally {
            await pg.close();
        }
    }

    const at = Date.UTC(2026, 8, 23, 14, 57, 48, 397);

    it("machine keepalive 가 KST 세션에서도 UTC 벽시계 값을 쓴다", async () => {
        primeMachineCacheEntry("row-1", "user-1");
        activityCache.queueMachineUpdate("row-1", at);
        await flushNow();

        expect(await runCapturedAgainstKstDatabase("Machine")).toBe("2026-09-23T14:57:48.397Z");
    });

    it("session keepalive 가 KST 세션에서도 UTC 벽시계 값을 쓴다", async () => {
        primeCacheEntry("row-1", "user-1");
        activityCache.queueSessionUpdate("row-1", at);
        await flushNow();

        expect(await runCapturedAgainstKstDatabase("Session")).toBe("2026-09-23T14:57:48.397Z");
    });
});
