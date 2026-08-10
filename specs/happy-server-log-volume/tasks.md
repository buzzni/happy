# Tasks

## Phase 1 — 인증 로그 강등

- [x] `enableAuthentication.test.ts` 작성 (성공 경로 info 0건, 토큰 미노출, 실패는 계속 로깅)
- [x] 🔴 Red 확인 — 2건 실패
- [x] `Auth check` / `Auth success` → `debug()`, 토큰 문자열 제거
- [x] 🟢 Green — 5/5 통과

## Phase 2 — Fastify 요청 로그 대체

- [x] `enableMonitoring.test.ts` 에 접근 로그 describe 추가 (빠른 200 침묵, 500 한 줄, 느림 한 줄)
- [x] 🔴 Red 확인 — 2건 실패
- [x] `enableMonitoring.ts` onResponse 훅에 조건부 단일 라인 로그
- [x] `api.ts` 에 `disableRequestLogging: true`
- [x] 🟢 Green — 8/8 통과

## Phase 3 — 로거 기본값

- [x] `logLevel.test.ts` 작성
- [x] 🔴 Red 확인 — 모듈 없음
- [x] `logLevel.ts` — `LOG_LEVEL` 해석, 기본 info, 'silent' 제외 (pino StreamEntry 타입 제약)
- [x] `log.ts` — level 배선, `colorize` 를 TTY 조건부로
- [x] 🟢 Green — 4/4 통과

## Phase 4 — 검증

- [x] `npx vitest run` 전체 — 42 파일 / 493 테스트 통과
- [x] `tsc --noEmit` 클린
- [x] 실서버 실측 (`pnpm standalone:dev`) — 성공 요청 20건에 로그 0줄, ANSI 코드 0건

## 남은 것 (이 spec 범위 밖)

- [ ] 배포 — `vendor/happy` 는 서브모듈. buzzni/happy 에 PR → 이미지 빌드 → prod 롤아웃 필요
- [ ] `/v1/projects/:id/members` fan-out 제거
- [ ] 세션 메시지 폴링 완화 (140세션 × ~1.2초)
