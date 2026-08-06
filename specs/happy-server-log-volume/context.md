# Context

## 2026-08-06 — Phase 1~4 완료, 미배포

### 변경된 파일

| 파일 | 변경 |
|---|---|
| `sources/app/api/utils/enableAuthentication.ts` | `Auth check`/`Auth success` → `debug()`, 토큰 로깅 제거 |
| `sources/app/api/utils/enableAuthentication.test.ts` | 신규 — 5 tests |
| `sources/app/api/api.ts` | `disableRequestLogging: true` |
| `sources/app/api/utils/enableMonitoring.ts` | onResponse 훅에 5xx/느린 요청 단일 라인 로그 |
| `sources/app/api/utils/enableMonitoring.test.ts` | 접근 로그 describe 추가 — 3 tests |
| `sources/utils/logLevel.ts` | 신규 — `LOG_LEVEL` 해석 |
| `sources/utils/logLevel.test.ts` | 신규 — 4 tests |
| `sources/utils/log.ts` | level 배선, `colorize` TTY 조건부 |

### 실측 결과

배포 전 prod: 23줄/요청 (2분에 50,794줄 / 2,204 요청, ≈920줄/초)

로컬 `pnpm standalone:dev` 실측:

```
성공 요청 20건 (GET /live)              → 로그 0줄
인증 실패 요청 20건 (GET /v1/machines)  → 60줄 (3줄 × 20, 의도된 동작)
ANSI 이스케이프                          → 0건
```

`Auth failed` 는 info 유지가 의도다 — prod 에서 2분에 9건 수준으로 드물고 진단
가치가 크다.

### 결정 기록

- **정상 요청 로그를 전부 제거**하고 5xx/1s 초과만 남기기로 사용자가 선택했다.
  대안(전 요청 1줄)은 초당 ~40줄이 남아 로그 보존 창 문제가 해결되지 않는다.
- **기본 레벨 debug → info.** `LOG_LEVEL=debug` 로 언제든 예전 상세도 복구 가능.
- **`silent` 레벨은 미지원.** `pino.multistream` 의 `StreamEntry.level` 타입이
  받지 않는다. 가장 조용한 값은 `fatal`.
- **pino-pretty → JSON 전환은 하지 않았다.** 포맷 계약이 바뀌고 happy-server
  `CLAUDE.md` 의 디버깅 문서가 전부 영향받는다. 별도 트랙 (spec Non-Goals).

### 사이드 이펙트 리뷰 (2026-08-06)

`disableRequestLogging: true` 가 Fastify 5.7.2 내부에서 정확히 무엇을 막는지 확인했다:

| 위치 | 로그 | 영향 |
|---|---|---|
| `lib/route.js:515` | `incoming request` (info) | 의도된 제거 |
| `lib/reply.js:916` | `request completed` (info) | 의도된 제거 |
| `lib/reply.js:676` | `stream closed prematurely` (info) | 제거 — 정보성 |
| `lib/reply.js:905` | `request errored` (error) | **주의 대상** |
| `lib/error-handler.js:94` | `reply.log.error` | 게이트되지 않음 — 유지 |

`request errored` 만 error 레벨이라 검토했는데, happy-server 에서는 **변경 전에도
도달 불가능한 경로**였다. `setupResponseListeners` 는 onResponse 훅이 등록돼
있으면 `onResponseHookRunner(...)` 를 통해 `onResponseCallback` 을 부르는데,
hookRunner 는 transport `err` 를 콜백에 전달하지 않는다. enableMonitoring 이 항상
onResponse 훅을 등록하므로 이 분기는 늘 `err == null` 이다. prod 10분 실측에서도
`request errored` 0건, `stream closed prematurely` 0건이었다.

에러 로깅 자체는 그대로다 — `enableErrorHandlers.ts` 의 `setErrorHandler` /
`onError` 훅은 커스텀이고 게이트되지 않는다. 5xx 스택 트레이스는 계속 남는다.

`sources/app/monitoring/metrics.ts` 의 두 번째 fastify 인스턴스는 이미
`logger: false` 라 손댈 것이 없다.

**리뷰 중 발견해 고친 회귀 1건:** `fileConsolidatedLogger` 가 `baseOptions` 를
공유해 기본 레벨 info 를 물려받으면서, `devRoutes.ts:46` 의
`fileConsolidatedLogger.debug(...)` — CLI/모바일이 보내온 debug 레벨 원격 로그가
전부 유실될 뻔했다. 이 로거는 `DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING`
가 켜졌을 때만 존재하는 파일 전용 스트림이므로 `level: 'debug'` 로 고정했다.

### 이 변경이 **해결하지 않는** 것

장애 중 로그 폭주는 그대로다. 2026-08-06 11:56 의 분당 3,264건 P2024 로그는
`enableErrorHandlers.ts` 가 요청마다 전체 스택 트레이스를 남긴 것이고, 이번
변경 대상이 아니다. 평상시 firehose(초당 920줄)는 사라지지만 DB 열화가 시작되면
에러 경로가 다시 이벤트 루프를 물어뜯는다. 동일 에러 rate-limit / 스택 트레이스
요약이 후속 과제다.

### 다음 세션이 알아야 할 것

- **아직 배포되지 않았다.** `vendor/happy` 는 서브모듈이므로 buzzni/happy 에 PR →
  이미지 빌드 → `aplus-dev-studio-prod-shared/happy-server` 롤아웃이 필요하다.
  배포 전까지 prod 로그는 그대로 초당 900줄이다.
- 배포 후 확인: `kubectl logs` 시간 창이 15초 → 수십 분으로 늘어야 한다.
  Grafana `http_requests_total` / `http_request_duration_seconds` 는 변동 없어야
  한다 (메트릭이 관측성 대체재이므로 여기가 깨지면 롤백 대상).
- 이번 작업은 2026-08-06 11:52 502 장애의 **증폭 요인**만 제거했다. 1차 원인인
  `/v1/projects/:id/members` fan-out 과 세션 메시지 폴링은 그대로다.
