// specs/happy-server-log-volume — 로그 레벨 해석.
//
// 기본은 'info'. hot path 로그는 debug 로 강등돼 있으므로, 조사할 때는
// LOG_LEVEL=debug 로 배포하면 예전 상세도가 그대로 돌아온다. 알 수 없는 값이
// 오면 pino 가 기동 시점에 throw 하므로 조용히 기본값으로 되돌린다.
//
// 'silent' 는 제외한다 — pino.multistream 의 StreamEntry.level 이 받지 않는
// 값이라 타입이 통과하지 않는다. 가장 조용한 레벨은 'fatal' 이다.
const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

export type LogLevel = (typeof LEVELS)[number];

export function resolveLogLevel(value: string | undefined): LogLevel {
    return LEVELS.includes(value as LogLevel) ? (value as LogLevel) : 'info';
}
