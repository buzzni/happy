import fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableMonitoring } from "./enableMonitoring";

const { dbMock, logMock, warnMock, errorMock, debugMock } = vi.hoisted(() => ({
    dbMock: {
        $queryRaw: vi.fn()
    },
    logMock: vi.fn(),
    warnMock: vi.fn(),
    errorMock: vi.fn(),
    debugMock: vi.fn()
}));

vi.mock("@/storage/db", () => ({
    db: dbMock
}));

vi.mock("@/utils/log", () => ({
    log: logMock,
    warn: warnMock,
    error: errorMock,
    debug: debugMock
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

describe("enableMonitoring hook timing", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dbMock.$queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    });

    // 구간 계측 훅을 async 로 두면 send 파이프라인에 마이크로태스크가 끼어들어,
    // 핸들러가 reply.send() 를 직접 부르는 라우트(/live, /ready, /health)에서
    // 헤더가 두 번 쓰인다(ERR_HTTP_HEADERS_SENT). 단언 실패가 아니라 unhandled
    // rejection 으로만 드러나서 테스트는 초록으로 통과한다 — 그래서 명시적으로 잡는다.
    it.each(["/live", "/ready", "/health"])(
        "sends %s without racing the header write",
        async (url) => {
            const rejections: unknown[] = [];
            const capture = (reason: unknown) => { rejections.push(reason); };
            process.on("unhandledRejection", capture);
            try {
                const app = fastify();
                enableMonitoring(app as never);
                await app.ready();

                const response = await app.inject({ method: "GET", url });

                expect(response.statusCode).toBe(200);
                // rejection 은 다음 틱에 도착한다.
                await new Promise((resolve) => setImmediate(resolve));
            } finally {
                process.off("unhandledRejection", capture);
            }
            expect(rejections).toEqual([]);
        },
    );
});

describe("enableMonitoring access logging", () => {
    // specs/happy-server-log-volume — Fastify 기본 요청 로그(incoming request +
    // request completed)는 요청당 16줄이었고 전체 로그의 73% 였다. 정상 요청은
    // 침묵하고, 조사할 가치가 있는 요청만 단일 라인으로 남긴다. method/route/
    // status/duration 전량 집계는 같은 훅의 Prometheus 메트릭이 계속 담당한다.
    const SLOW_MS = 2000;
    let now = 1_700_000_000_000;

    beforeEach(() => {
        vi.clearAllMocks();
        now = 1_700_000_000_000;
        vi.spyOn(Date, "now").mockImplementation(() => now);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    async function buildApp() {
        const app = fastify({ disableRequestLogging: true });
        enableMonitoring(app as never);
        app.get("/fast", async () => ({ ok: true }));
        app.get("/slow", async () => {
            now += SLOW_MS;
            return { ok: true };
        });
        app.get("/boom", async (_request, reply) => {
            reply.code(500);
            return { error: "nope" };
        });
        await app.ready();
        return app;
    }

    it("stays silent for a fast successful request", async () => {
        const app = await buildApp();

        const response = await app.inject({ method: "GET", url: "/fast" });

        expect(response.statusCode).toBe(200);
        expect(logMock).not.toHaveBeenCalled();
        expect(warnMock).not.toHaveBeenCalled();
        expect(errorMock).not.toHaveBeenCalled();
    });

    it("logs one line for a server error", async () => {
        const app = await buildApp();

        const response = await app.inject({ method: "GET", url: "/boom" });

        expect(response.statusCode).toBe(500);
        expect(errorMock).toHaveBeenCalledTimes(1);
        const message = String(errorMock.mock.calls[0]?.[1]);
        expect(message).toContain("/boom");
        expect(message).toContain("500");
    });

    // 느린 요청의 시간이 "핸들러 안"인지 "응답을 다 내보내는 데"인지 구분하지 못하면
    // 무엇을 고쳐야 할지 알 수 없다 (specs/desktop-server-load-reduction T67).
    // 2026-09-19 lookup 28초 조사에서 DB 1.25ms·직렬화 2.9ms 로 요청당 계산 비용이
    // 전부 기각됐는데, 기존 로그는 onRequest~onResponse 총시간 하나뿐이라 남은
    // 후보(전송/대기)를 가릴 수 없었다.
    it("splits a slow request into handler, serialize and send phases", async () => {
        const app = fastify({ disableRequestLogging: true });
        enableMonitoring(app as never);
        // enableMonitoring 다음에 등록하므로 이 훅은 그쪽 onSend 뒤에 돈다 —
        // 여기서 흘린 시간은 "다 내보내는 데 걸린 시간"으로 잡혀야 한다.
        app.addHook("onSend", async (_request, _reply, payload) => {
            now += 400;
            return payload;
        });
        app.get("/split", async () => {
            now += 1500;
            return { ok: true };
        });
        await app.ready();

        const response = await app.inject({ method: "GET", url: "/split" });

        expect(response.statusCode).toBe(200);
        expect(warnMock).toHaveBeenCalledTimes(1);
        const message = String(warnMock.mock.calls[0]?.[1]);
        expect(message).toContain("1900ms");
        expect(message).toContain("handler 1500ms");
        expect(message).toContain("send 400ms");
    });

    it("attributes time to send when the handler itself was fast", async () => {
        const app = fastify({ disableRequestLogging: true });
        enableMonitoring(app as never);
        app.addHook("onSend", async (_request, _reply, payload) => {
            now += 3000;
            return payload;
        });
        app.get("/drain", async () => ({ ok: true }));
        await app.ready();

        await app.inject({ method: "GET", url: "/drain" });

        const message = String(warnMock.mock.calls[0]?.[1]);
        expect(message).toContain("handler 0ms");
        expect(message).toContain("send 3000ms");
    });

    it("logs one line for a slow request", async () => {
        const app = await buildApp();

        const response = await app.inject({ method: "GET", url: "/slow" });

        expect(response.statusCode).toBe(200);
        expect(warnMock).toHaveBeenCalledTimes(1);
        const message = String(warnMock.mock.calls[0]?.[1]);
        expect(message).toContain("/slow");
        expect(message).toContain("2000ms");
    });
});
