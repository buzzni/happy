import { describe, it, expect } from "vitest";

// specs/error-log-flood-guard — 장애 중 동일 에러가 초당 수십 건씩
// 쏟아지면 pino-pretty 의 동기 출력이 이벤트 루프를 점유해 장애를
// 증폭시킨다. 창당 한 줄로 묶되 진단 정보는 잃지 않는다.
import { createErrorLogThrottle, ERROR_LOG_WINDOW_MS } from "./errorLogThrottle";

describe("createErrorLogThrottle", () => {
    // AC1
    it("같은 키의 첫 발생은 통과시킨다", () => {
        const throttle = createErrorLogThrottle();
        expect(throttle.admit("P2024", 1_000)).toEqual({ allowed: true, suppressed: 0 });
    });

    // AC2
    it("창 안의 반복은 억제한다", () => {
        const throttle = createErrorLogThrottle();
        throttle.admit("P2024", 1_000);

        for (let i = 1; i <= 50; i++) {
            expect(throttle.admit("P2024", 1_000 + i).allowed).toBe(false);
        }
    });

    // AC3
    it("창이 지나면 다시 통과시키고 억제 건수를 알려준다", () => {
        const throttle = createErrorLogThrottle();
        throttle.admit("P2024", 1_000);
        for (let i = 1; i <= 50; i++) throttle.admit("P2024", 1_000 + i);

        const next = throttle.admit("P2024", 1_000 + ERROR_LOG_WINDOW_MS);
        expect(next).toEqual({ allowed: true, suppressed: 50 });
    });

    it("억제 건수는 알린 뒤 초기화된다", () => {
        const throttle = createErrorLogThrottle();
        throttle.admit("P2024", 1_000);
        throttle.admit("P2024", 1_001);
        throttle.admit("P2024", 1_000 + ERROR_LOG_WINDOW_MS);

        const later = throttle.admit("P2024", 1_000 + ERROR_LOG_WINDOW_MS * 2);
        expect(later).toEqual({ allowed: true, suppressed: 0 });
    });

    // AC4 — 폭주하는 에러가 다른 에러를 가리면 안 된다
    it("키가 다르면 서로의 창에 영향받지 않는다", () => {
        const throttle = createErrorLogThrottle();
        throttle.admit("P2024", 1_000);
        throttle.admit("P2024", 1_001);

        expect(throttle.admit("P1001", 1_002).allowed).toBe(true);
    });

    it("창 길이를 주입할 수 있다", () => {
        const throttle = createErrorLogThrottle({ windowMs: 100 });
        throttle.admit("X", 0);
        expect(throttle.admit("X", 99).allowed).toBe(false);
        expect(throttle.admit("X", 100).allowed).toBe(true);
    });

    // 장애가 길어져도 키 종류만큼만 메모리를 쓰는지 — 무한 증가하면
    // 로그를 줄이려다 메모리 누수를 만든다.
    it("오래된 키는 정리되어 무한히 쌓이지 않는다", () => {
        const throttle = createErrorLogThrottle({ windowMs: 10 });
        for (let i = 0; i < 5_000; i++) {
            throttle.admit(`code-${i}`, i * 100);
        }
        expect(throttle.size()).toBeLessThanOrEqual(1_000);
    });
});
