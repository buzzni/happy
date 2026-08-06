# Plan

## Phase 1 — 인증 로그 강등 (동작 변경)

`sources/app/api/utils/enableAuthentication.ts`

- `Auth check` / `Auth success` 를 `log()`(info) → `debug()` 로 강등
- `Auth failed` 2건은 info 유지 (드물고 진단 가치 큼)
- 검증: 인증 성공 시 info 로그 0건, 실패 시 info 로그 1건 이상

상태: Done

## Phase 2 — Fastify 요청 로그 대체 (동작 변경)

`sources/app/api/api.ts`, `sources/app/api/utils/enableMonitoring.ts`

- `fastify({ disableRequestLogging: true })`
- 기존 `onResponse` 훅(메트릭 기록)에 조건부 단일 라인 로그 추가:
  - `status >= 500` → error
  - `duration > 1s` → warn
  - 그 외 → 로그 없음
- 메트릭 기록 경로는 그대로 (spec Requirement 7)
- 검증: 200/빠름 → 0줄, 500 → 1줄, 느림 → 1줄

상태: Done

## Phase 3 — 로거 기본값 (동작 변경)

`sources/utils/log.ts`

- `level: 'debug'` → `process.env.LOG_LEVEL ?? 'info'`
- `colorize: true` → `process.stdout.isTTY === true`
- 검증: 기본 info, `LOG_LEVEL=debug` 로 Phase 1 로그 복구

상태: Done

## Phase 4 — 검증

- `pnpm vitest run sources/app/api/utils sources/utils`
- `pnpm typecheck`

상태: Done
