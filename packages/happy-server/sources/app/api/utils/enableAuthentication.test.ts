import fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { enableAuthentication } from "./enableAuthentication";

const { logMock, debugMock, authMock } = vi.hoisted(() => ({
    logMock: vi.fn(),
    debugMock: vi.fn(),
    authMock: { verifyToken: vi.fn() }
}));

vi.mock("@/utils/log", () => ({
    log: logMock,
    debug: debugMock
}));

vi.mock("@/app/auth/auth", () => ({
    auth: authMock
}));

async function buildApp() {
    const app = fastify();
    enableAuthentication(app as never);
    app.get(
        "/protected",
        { preHandler: (app as never as { authenticate: never }).authenticate },
        async (request) => ({ userId: (request as { userId?: string }).userId })
    );
    await app.ready();
    return app;
}

describe("enableAuthentication logging", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        authMock.verifyToken.mockResolvedValue({ userId: "user-1" });
    });

    it("authenticates a valid bearer token", async () => {
        const app = await buildApp();

        const response = await app.inject({
            method: "GET",
            url: "/protected",
            headers: { authorization: "Bearer valid-token" }
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ userId: "user-1" });
    });

    it("emits no info-level log on the success path", async () => {
        // specs/happy-server-log-volume — 요청당 6줄을 차지하던 Auth check /
        // Auth success 는 정상 경로의 hot path 다. 초당 900줄 로깅이 이벤트
        // 루프를 점유해 2026-08-06 502 장애를 증폭시켰다.
        const app = await buildApp();

        await app.inject({
            method: "GET",
            url: "/protected",
            headers: { authorization: "Bearer valid-token" }
        });

        expect(logMock).not.toHaveBeenCalled();
    });

    it("never logs the bearer token", async () => {
        const app = await buildApp();

        await app.inject({
            method: "GET",
            url: "/protected",
            headers: { authorization: "Bearer super-secret-token" }
        });

        const everythingLogged = [...logMock.mock.calls, ...debugMock.mock.calls]
            .flat()
            .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
            .join(" ");
        expect(everythingLogged).not.toContain("super-secret-token");
    });

    it("still logs a missing authorization header", async () => {
        const app = await buildApp();

        const response = await app.inject({ method: "GET", url: "/protected" });

        expect(response.statusCode).toBe(401);
        expect(logMock).toHaveBeenCalled();
    });

    it("still logs an invalid token", async () => {
        authMock.verifyToken.mockResolvedValue(null);
        const app = await buildApp();

        const response = await app.inject({
            method: "GET",
            url: "/protected",
            headers: { authorization: "Bearer bad-token" }
        });

        expect(response.statusCode).toBe(401);
        expect(logMock).toHaveBeenCalled();
    });
});
