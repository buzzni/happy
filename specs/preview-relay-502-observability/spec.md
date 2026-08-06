# 프리뷰 릴레이 5xx 원인 관측성

## Goal

`/v1/preview/:machineId/:port/*` 가 5xx 를 돌려줄 때 **원인을 로그 한 줄에서
식별할 수 있게** 한다. 상태 코드와 응답 본문은 바꾸지 않는다.

## Motivation

2026-08-06 09:56:57~58, `happy-server-66c597cf6b-ds6g7` 로그에 502 6건이 찍혔다.
pod 수명 8시간 전체에서 유일한 5xx 다.

```
09:56:57.088 INFO  Minted preview token  machine=c93c0067… port=40022
09:56:57.089 INFO  Minted preview token  machine=c93c0067… port=30023
09:56:57.212 ERROR HEAD /v1/preview/:machineId/:port/* 502  12ms
09:56:57.223 ERROR HEAD …                              502   4ms
09:56:57.288 ERROR GET  …                              502   7ms
09:56:57.442 ERROR GET  …                              502   6ms
09:56:58.527 ERROR HEAD …                              502 782ms
09:56:58.528 ERROR HEAD …                              502 712ms
```

원인 규명에 반나절이 아니라 로그 한 줄이면 충분했어야 한다. 문제는 502 를
만드는 두 분기가 **로그를 하나도 남기지 않는다**는 것이다:

- `previewRoutes.ts` 머신 소켓 부재 → `502 Machine offline` (로그 없음)
- `previewRoutes.ts` 데몬이 error 응답 → 코드별 400/504/**502** (로그 없음)

유일한 흔적인 액세스 로그(`enableMonitoring.ts:58`)는 `status >= 500` 을 전부
ERROR 로 찍으면서 method·route 템플릿·소요시간만 담는다. machineId, port,
userId, 데몬 에러 코드가 전부 없다. 그래서:

- **"데몬이 죽었다"(비정상)** 와 **"dev 서버가 아직 포트를 안 열었다"(기동 중
  정상)** 가 로그상 완전히 동일하다.
- 위 사건은 응답시간 782ms 가 "릴레이를 실제로 왕복했다"는 증거가 되어
  간신히 후자로 판별했다. 12ms 짜리 4건은 끝까지 확정할 수 없었다.

502 가 정상 신호라는 점은 설계에 명시돼 있다 —
`packages/web-ui/src/lib/previewUrl.ts:73` `checkPortReachable()` 은 iframe 이
로드할 바로 그 URL 을 HEAD 로 폴링하며 `502/504` 를 "아직 안 뜸"으로 판정한다.
즉 프리뷰를 켤 때마다 502 는 **정상적으로 발생한다**.

## Requirements

1. 5xx/4xx 를 반환하는 릴레이 실패 분기는 `module: 'preview'` 로 한 줄을 남긴다.
2. 그 줄은 최소한 `reason`, `method`, `machineId`, `port`, `userId`,
   업스트림 `path` 를 담는다. 데몬 에러면 데몬이 준 `code` 와 메시지도 담는다.
3. `reason` 은 두 분기를 구분한다 — `machine-offline` / `daemon:<CODE>`.
4. **ptoken 을 평문으로 로깅하지 않는다.** 로그에 넣는 path 는 `ptoken` 이
   제거된 업스트림 path (`buildPreviewUpstreamPath` 결과) 여야 한다.
   (`specs/happy-server-log-volume` Requirement 4 와 동일한 계약.)
5. 레벨은 `warn` 이다. `machine-offline` 도 노트북을 닫은 정상 상황에서 나오고,
   `daemon:CONNECTION_REFUSED` 는 기동 중 정상이다. 둘 다 `error` 가 아니다.
6. 응답 상태 코드와 본문은 현행과 **바이트 단위로 동일**하다. 관측성만 더한다.
   특히 `checkPortReachable` 의 502/504 계약을 깨지 않는다.

## Non-Goals

- **`CONNECTION_REFUSED` 를 503 으로 분리**하는 것. 가치는 있지만 크로스 레포
  계약 변경이다 — 배포된 web-ui 는 502/504 만 "아직 안 뜸"으로 보므로 503 을
  "떴다"로 오판한다. web-ui 가 503 을 먼저 수용하도록 배포한 뒤에야 서버를
  바꿀 수 있다. 별도 트랙.
- 액세스 로그(`enableMonitoring.ts`)의 5xx 레벨을 라우트별로 낮추는 것. 별도 트랙.
- `previewWebSocketRelay.ts:282,316` 의 WS 업그레이드 502. 별도 경로이고 이번
  사건과 무관하다.
- Prometheus 메트릭 변경. `httpRequestsCounter` 는 손대지 않는다.

## Verification

- `pnpm vitest run sources/app/api/routes/previewRoutesFailureLog.spec.ts` 통과
- 기존 프리뷰 릴레이 스펙 4종 회귀 없음 (`previewRoutes*.spec.ts`)
- 배포 후 프리뷰 기동 시 502 액세스 로그 바로 옆에
  `preview relay failed reason=daemon:CONNECTION_REFUSED …` 가 함께 보인다
