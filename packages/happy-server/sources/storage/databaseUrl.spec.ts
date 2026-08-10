import { describe, expect, it } from "vitest";
import { buildAppDatabaseUrl } from "./databaseUrl";

// specs/db-pool-socket-timeout — 앱 풀에만 socket_timeout 을 주입한다.
// prisma migrate deploy 는 같은 DATABASE_URL 을 쓰므로 URL 자체는 건드리지
// 않는다 (긴 마이그레이션이 중간에 끊기면 배포가 영구히 막힌다).
describe("buildAppDatabaseUrl", () => {
    it("appends socket_timeout when the url has no query string", () => {
        const url = buildAppDatabaseUrl("postgresql://u:p@host:5432/happy", 30);

        expect(url).toBe("postgresql://u:p@host:5432/happy?socket_timeout=30");
    });

    it("preserves existing query parameters", () => {
        const url = buildAppDatabaseUrl(
            "postgresql://u:p@host:5432/happy?connection_limit=30&pool_timeout=30",
            30
        );

        expect(url).toContain("connection_limit=30");
        expect(url).toContain("pool_timeout=30");
        expect(url).toContain("socket_timeout=30");
    });

    it("respects an explicitly configured socket_timeout", () => {
        const raw = "postgresql://u:p@host:5432/happy?socket_timeout=5";

        expect(buildAppDatabaseUrl(raw, 30)).toBe(raw);
    });

    it("returns undefined when DATABASE_URL is not set", () => {
        expect(buildAppDatabaseUrl(undefined, 30)).toBeUndefined();
        expect(buildAppDatabaseUrl("", 30)).toBeUndefined();
    });

    it("leaves the url untouched when the timeout is not a positive number", () => {
        const raw = "postgresql://u:p@host:5432/happy";

        expect(buildAppDatabaseUrl(raw, 0)).toBe(raw);
        expect(buildAppDatabaseUrl(raw, Number.NaN)).toBe(raw);
    });

    it("keeps a url it cannot parse usable", () => {
        // 파싱 실패로 서버 기동을 막지 않는다 — 원본을 그대로 돌려준다.
        const raw = "not-a-url";

        expect(buildAppDatabaseUrl(raw, 30)).toBe(raw);
    });
});
