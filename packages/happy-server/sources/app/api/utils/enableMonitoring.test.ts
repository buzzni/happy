import fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { enableMonitoring } from "./enableMonitoring";

const { dbMock } = vi.hoisted(() => ({
    dbMock: {
        $queryRaw: vi.fn()
    }
}));

vi.mock("@/storage/db", () => ({
    db: dbMock
}));

describe("enableMonitoring health endpoints", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dbMock.$queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    });

    it("keeps liveness independent from database connectivity", async () => {
        const app = fastify();
        enableMonitoring(app as never);

        const response = await app.inject({ method: "GET", url: "/live" });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
            status: "ok",
            service: "happy-server"
        });
        expect(dbMock.$queryRaw).not.toHaveBeenCalled();
    });

    it("keeps readiness independent from database connectivity", async () => {
        const app = fastify();
        enableMonitoring(app as never);

        const response = await app.inject({ method: "GET", url: "/ready" });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
            status: "ok",
            service: "happy-server"
        });
        expect(dbMock.$queryRaw).not.toHaveBeenCalled();
    });

    it("stays ready while the database is unreachable", async () => {
        // specs/readiness-probe-decoupling — 2026-08-05 장애 재현.
        // DB 가 죽으면 readinessProbe 가 실패해 파드가 Service endpoint 에서
        // 빠지고, 단일 replica 라 전면 장애가 됐다. DB 열화가 트래픽 수신
        // 자격을 박탈해서는 안 된다.
        dbMock.$queryRaw.mockRejectedValue(new Error("db down"));
        const app = fastify();
        enableMonitoring(app as never);

        const response = await app.inject({ method: "GET", url: "/ready" });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ status: "ok" });
    });

    it("checks database connectivity for health", async () => {
        const app = fastify();
        enableMonitoring(app as never);

        const response = await app.inject({ method: "GET", url: "/health" });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
            status: "ok",
            service: "happy-server"
        });
        expect(dbMock.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it("returns unavailable when the health dependency check fails", async () => {
        dbMock.$queryRaw.mockRejectedValueOnce(new Error("db down"));
        const app = fastify();
        enableMonitoring(app as never);

        const response = await app.inject({ method: "GET", url: "/health" });

        expect(response.statusCode).toBe(503);
        expect(response.json()).toMatchObject({
            status: "error",
            service: "happy-server",
            error: "Database connectivity failed"
        });
    });
});
