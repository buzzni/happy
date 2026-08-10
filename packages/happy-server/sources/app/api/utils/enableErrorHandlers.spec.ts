import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyError } from "fastify";

// specs/error-log-flood-guard AC5/AC6 — 두 로깅 지점(setErrorHandler,
// onError 훅)이 각각 억제되어야 하고, 4xx 는 억제 대상이 아니다.

let logMock: any;
vi.mock("@/utils/log", () => ({
    log: (...args: any[]) => logMock(...args),
}));

import { enableErrorHandlers } from "./enableErrorHandlers";

/** setErrorHandler / addHook 만 붙잡는 최소 Fastify 대역. */
function fakeApp() {
    const captured: {
        errorHandler?: (e: FastifyError, req: any, reply: any) => Promise<unknown>;
        onError?: (req: any, reply: any, e: FastifyError) => Promise<unknown>;
    } = {};
    const app = {
        setErrorHandler(fn: any) { captured.errorHandler = fn; },
        setNotFoundHandler() { /* unused here */ },
        addHook(name: string, fn: any) {
            if (name === 'onError') captured.onError = fn;
        },
    };
    return { app: app as any, captured };
}

function err(code: string, statusCode?: number): FastifyError {
    const e = new Error(`${code} boom`) as FastifyError;
    e.code = code;
    if (statusCode !== undefined) e.statusCode = statusCode;
    return e;
}

const req = { method: 'GET', url: '/v1/projects/p-1/members', headers: {}, ip: '10.0.0.1' };
const reply = { code: () => reply, send: () => reply, statusCode: 500 };

function errorLogCount() {
    return logMock.mock.calls.filter(
        (c: any[]) => c[0]?.module === 'fastify-error',
    ).length;
}
function hookLogCount() {
    return logMock.mock.calls.filter(
        (c: any[]) => c[0]?.module === 'fastify-hook-error',
    ).length;
}

describe("enableErrorHandlers — 에러 로그 폭주 방지", () => {
    beforeEach(() => {
        logMock = vi.fn();
    });

    // AC1 + AC2
    it("동일 5xx 가 100번 나도 setErrorHandler 로그는 한 번만 남는다", async () => {
        const { app, captured } = fakeApp();
        enableErrorHandlers(app, { skipNotFoundHandler: true });

        for (let i = 0; i < 100; i++) {
            await captured.errorHandler!(err('P2024', 500), req, reply);
        }

        expect(errorLogCount()).toBe(1);
    });

    // AC6 — 훅도 따로 막혀야 한다. 한쪽만 막으면 절반만 줄어든다.
    it("onError 훅도 동일하게 한 번만 남는다", async () => {
        const { app, captured } = fakeApp();
        enableErrorHandlers(app, { skipNotFoundHandler: true });

        for (let i = 0; i < 100; i++) {
            await captured.onError!(req, reply, err('P2024', 500));
        }

        expect(hookLogCount()).toBe(1);
    });

    // AC4
    it("다른 에러 코드는 폭주하는 에러에 가려지지 않는다", async () => {
        const { app, captured } = fakeApp();
        enableErrorHandlers(app, { skipNotFoundHandler: true });

        for (let i = 0; i < 50; i++) {
            await captured.errorHandler!(err('P2024', 500), req, reply);
        }
        await captured.errorHandler!(err('P1001', 500), req, reply);

        expect(errorLogCount()).toBe(2);
    });

    // code 가 없는 예외들이 한 통에 묶이면, 평상시 드물게 나는 별개 버그가
    // 서로를 가린다. name 까지 키에 넣어 구분한다.
    it("code 가 없는 서로 다른 예외는 서로를 가리지 않는다", async () => {
        const { app, captured } = fakeApp();
        enableErrorHandlers(app, { skipNotFoundHandler: true });

        const typeError = new TypeError("x is not a function") as FastifyError;
        typeError.statusCode = 500;
        const rangeError = new RangeError("out of range") as FastifyError;
        rangeError.statusCode = 500;

        await captured.errorHandler!(typeError, req, reply);
        await captured.errorHandler!(rangeError, req, reply);

        expect(errorLogCount()).toBe(2);
    });

    // AC5
    it("4xx 는 억제하지 않는다", async () => {
        const { app, captured } = fakeApp();
        enableErrorHandlers(app, { skipNotFoundHandler: true });

        for (let i = 0; i < 10; i++) {
            await captured.errorHandler!(err('FST_ERR_VALIDATION', 400), req, reply);
        }

        expect(errorLogCount()).toBe(10);
    });

    it("첫 로그는 기존처럼 스택과 컨텍스트를 담는다", async () => {
        const { app, captured } = fakeApp();
        enableErrorHandlers(app, { skipNotFoundHandler: true });

        await captured.errorHandler!(err('P2024', 500), req, reply);

        const meta = logMock.mock.calls[0][0];
        expect(meta).toMatchObject({
            module: 'fastify-error',
            level: 'error',
            method: 'GET',
            url: '/v1/projects/p-1/members',
            errorCode: 'P2024',
        });
        expect(typeof meta.stack).toBe('string');
    });

    // 응답 자체는 억제와 무관해야 한다 — 로깅만 손대는 변경이다.
    it("억제된 요청도 정상적으로 5xx 응답을 받는다", async () => {
        const { app, captured } = fakeApp();
        enableErrorHandlers(app, { skipNotFoundHandler: true });
        const sent: any[] = [];
        const capturingReply = {
            statusCode: 500,
            code(c: number) { sent.push({ code: c }); return capturingReply; },
            send(body: any) { sent.push({ body }); return capturingReply; },
        };

        await captured.errorHandler!(err('P2024', 500), req, capturingReply);
        await captured.errorHandler!(err('P2024', 500), req, capturingReply);

        expect(errorLogCount()).toBe(1);
        expect(sent.filter((s) => s.code === 500)).toHaveLength(2);
    });
});
