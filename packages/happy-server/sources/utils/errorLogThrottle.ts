/**
 * 동일 에러 로그 rate-limit.
 *
 * 장애 중에는 같은 에러가 초당 수십 건씩 쏟아진다. `pino-pretty` 는 동기
 * in-process 스트림이라 그 출력이 요청 처리와 같은 이벤트 루프에서
 * 일어나고, 결과적으로 로깅이 장애를 증폭시킨다 (2026-08-06: P2024 분당
 * 3,264건 × 스택 트레이스).
 *
 * 창당 한 줄만 통과시키고, 억제한 건수는 다음 통과 로그에 실어 보낸다 —
 * "조용해진 것" 과 "묻힌 것" 을 구분할 수 있어야 하기 때문이다.
 *
 * specs/error-log-flood-guard
 */

export const ERROR_LOG_WINDOW_MS = 10_000;

/** 장애가 길어져도 메모리가 무한히 늘지 않도록 하는 상한. */
const MAX_TRACKED_KEYS = 1_000;

export interface ErrorLogAdmission {
    /** true 면 호출자가 실제로 로그를 남겨야 한다. */
    allowed: boolean;
    /** 직전 창에서 삼킨 건수. `allowed` 가 true 일 때만 의미가 있다. */
    suppressed: number;
}

export interface ErrorLogThrottle {
    admit(key: string, now?: number): ErrorLogAdmission;
    /** 추적 중인 키 수 — 메모리 상한 회귀 테스트용. */
    size(): number;
}

export function createErrorLogThrottle(
    opts: { windowMs?: number } = {},
): ErrorLogThrottle {
    const windowMs = opts.windowMs ?? ERROR_LOG_WINDOW_MS;
    const state = new Map<string, { lastLoggedAt: number; suppressed: number }>();

    /**
     * 상한을 넘으면 가장 오래 조용했던 키부터 버린다. 버려진 키는 다음
     * 발생 때 "첫 발생" 으로 취급돼 다시 로그가 나가므로, 정리 자체가
     * 관측성을 깎지는 않는다.
     */
    function evictIfNeeded(now: number): void {
        if (state.size <= MAX_TRACKED_KEYS) return;
        for (const [key, entry] of state) {
            if (now - entry.lastLoggedAt >= windowMs) state.delete(key);
            if (state.size <= MAX_TRACKED_KEYS) return;
        }
        // 전부 활성 창이면 가장 오래된 것부터 (Map 은 삽입 순서를 지킨다).
        for (const key of state.keys()) {
            state.delete(key);
            if (state.size <= MAX_TRACKED_KEYS) return;
        }
    }

    return {
        admit(key: string, now: number = Date.now()): ErrorLogAdmission {
            const entry = state.get(key);
            if (entry && now - entry.lastLoggedAt < windowMs) {
                entry.suppressed += 1;
                return { allowed: false, suppressed: entry.suppressed };
            }
            const suppressed = entry?.suppressed ?? 0;
            state.set(key, { lastLoggedAt: now, suppressed: 0 });
            evictIfNeeded(now);
            return { allowed: true, suppressed };
        },
        size(): number {
            return state.size;
        },
    };
}
