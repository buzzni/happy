# happy-server 로그 볼륨 축소

## Goal

`happy-server` 가 요청 1건마다 남기는 로그를 정상 경로에서 0줄로 줄인다. 관측성은
이미 존재하는 Prometheus 메트릭이 대신하고, 로그는 **비정상 요청(느림/에러)** 만
남긴다.

## Motivation

2026-08-06 11:52:14~11:54:47 KST, happy CLI 데몬의 WebSocket 이 502 로 끊겼다.
happy-server pod 은 재시작하지 않았다(`Restart Count: 0`) — 응답을 못 했을 뿐이다.

- ingress: `GET /v1/updates/?EIO=4&transport=websocket` → `upstream_time 5.000` → `504, 502`
- web-ui: `[vite proxy] connect ETIMEDOUT 10.96.10.114:3000` 423건 (TCP connect 자체 실패)
- happy-server: `P2024 Timed out fetching a new connection from the connection pool`
  (limit 89, timeout 10s) 분당 3,264건

풀 고갈의 1차 원인은 별도 트랙(`/v1/projects/:id/members` fan-out, 세션 메시지
폴링)이지만, **로그 자체가 장애를 증폭시켰다**. 복구된 뒤에도 측정값은:

```
2분 창: 50,794줄 / 요청 2,204건 = 23줄/요청 (≈920줄/초)

incoming request     2,204건 × ~9줄  ≈ 19,800   Fastify 기본
request completed    2,204건 × ~7줄  ≈ 15,400   Fastify 기본
Auth check           2,184건 × 3줄   ≈  6,550   enableAuthentication.ts:9
Auth success         2,175건 × 3줄   ≈  6,525   enableAuthentication.ts:22
                                     ─────────
                                       48,275  = 전체의 95%
```

pino-pretty 는 동기 in-process 스트림이므로(`utils/log.ts:37-47` 참조) 이 출력은
전부 요청 처리와 같은 이벤트 루프에서 일어난다. 초당 900줄의 pretty-print +
ANSI 컬러라이즈가 이벤트 루프를 점유해 새 연결 accept 를 막았다.

부수 피해: 컨테이너 로그 보존 창이 **약 15초**로 줄어 장애 직후 원인 조사가
사실상 불가능하다.

## Requirements

1. 정상 요청(2xx, 빠른 응답)은 접근 로그를 남기지 않는다.
2. `status >= 500` 또는 소요시간 > 1s 인 요청은 **단일 라인** 으로 남긴다.
3. 인증 성공 경로는 info 레벨 로그를 남기지 않는다. 인증 **실패** 는 계속 남긴다.
4. 매 요청 Bearer 토큰을 평문으로 로깅하지 않는다.
5. 기본 로그 레벨은 `info` 이며 `LOG_LEVEL` 환경변수로 덮어쓸 수 있다.
6. ANSI 컬러는 TTY 에서만 적용한다.
7. 기존 Prometheus 메트릭(`httpRequestsCounter`, `httpRequestDurationHistogram`)의
   레이블·집계는 바뀌지 않는다 — 관측성 대체재이므로 절대 훼손하지 않는다.

## Non-Goals

- pino-pretty → JSON 구조화 로그 전환. 포맷 계약이 바뀌고 디버깅 문서
  (`packages/happy-server/CLAUDE.md`)가 전부 영향받는다. 별도 트랙.
- `/v1/projects/:id/members` fan-out 제거, 세션 메시지 폴링 완화. 부하의 1차
  원인이지만 이 spec 의 범위가 아니다.
- WebSocket/socket.io 이벤트 로깅.

## Verification

- `pnpm vitest run sources/app/api/utils` 통과
- 배포 후 `kubectl logs` 창이 15초 → 수십 분 단위로 늘어난다
- Grafana 의 `http_requests_total` / `http_request_duration_seconds` 가 변동 없음
