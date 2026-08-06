# 장애 중 에러 로그가 장애를 증폭시키는 문제

## 문제

2026-08-06 장애에서 happy-server 는 P2024 (Prisma connection pool timeout)
를 **분당 3,264건** 남겼다. 각 건은 `enableErrorHandlers.ts` 에서 두 번
찍힌다.

| 위치 | 내용 |
|---|---|
| `setErrorHandler` | method/url/userAgent/ip/statusCode/errorCode + **전체 스택 트레이스** |
| `onError` 훅 | method/url/duration/statusCode/errorName/errorCode |

`pino-pretty` 는 동기 in-process 스트림이라 이 출력은 요청 처리와 같은
이벤트 루프에서 일어난다. buzzni/happy#128 이 **정상 경로** 의 요청당 23줄을
없앴지만, **장애 경로** 는 그대로 남았다. DB 가 열화되기 시작하면 에러
로깅이 다시 이벤트 루프를 물어뜯어 accept 지연 → 502/504 로 증폭된다.

#128 의 PR 본문도 이걸 후속 과제로 명시했다:

> 장애 중 로그 폭주는 그대로입니다. … 동일 에러 rate-limit 이 후속 과제입니다.

## Goal

같은 종류의 에러가 쏟아질 때 **창당 한 줄**로 묶고, 억제된 건수를 함께
알린다. 진단 정보(첫 발생의 전체 컨텍스트 + 스택)는 잃지 않는다.

## Acceptance Criteria

### AC1 — 첫 발생은 그대로 남는다

- **Given** 어떤 에러 코드가 처음 발생하면
- **Then** 기존과 동일하게 전체 컨텍스트 + 스택이 기록된다

### AC2 — 같은 코드의 연속 발생은 억제된다

- **Given** 같은 `error.code` 가 창(기본 10초) 안에 반복되면
- **Then** 추가 로그가 나가지 않는다

### AC3 — 창이 끝나면 억제 건수를 알린다

- **Given** 창 안에서 N건이 억제됐고 창이 지난 뒤 같은 에러가 또 오면
- **Then** 그 로그에 억제 건수 N 이 포함된다

### AC4 — 서로 다른 에러는 서로를 가리지 않는다

- **Given** P2024 가 폭주하는 중에 다른 코드의 에러가 발생하면
- **Then** 그 에러는 자기 창을 따로 가지므로 즉시 기록된다

### AC5 — 4xx 는 억제 대상이 아니다

- 클라이언트 오류는 원래 드물고 개별 진단 가치가 높다. 5xx (또는
  statusCode 미상) 만 억제한다.

### AC6 — 두 곳 모두 적용된다

- `setErrorHandler` 와 `onError` 훅이 각각 자기 창을 갖는다. 한쪽만
  막으면 절반만 줄어든다.

## 비목표

- 응답 본문/상태 코드 변경. 로깅만 손댄다.
- pino-pretty → JSON 구조화 로그 전환 (#128 과 동일한 이유로 제외).
- P2024 의 1차 원인(`/v1/projects/:id/members` fan-out, 세션 메시지 폴링)
  해결. 별도 과제.
