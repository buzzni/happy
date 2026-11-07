# happy-server push 결과 보고(PushOutcome) Spec

> 작성일: 2026-11-07 / 상태: 승인됨(Desktop `specs/happy-upstream-benchmark/spec.md` R3, 2026-11-07 사용자 승인)
> ⚠️ 승인 후에는 사용자 지시 없이 수정 금지

## 목표

세션 이벤트 push(완료·권한·질문)가 실제로 어떻게 처리됐는지(보냄·일부 실패·억제·토큰 없음·실패)를
서버가 호출자에게 돌려주고 로그·메트릭에 남긴다. 지금은 푸시가 전면 장애여도 CLI·Desktop·로그
어디서도 알 수 없다.

## 배경

- `sources/app/push/pushDispatch.ts` `dispatchSessionEventPush`는 `Promise<void>`이고 모든 오류를 삼킨다.
- `sources/app/api/routes/pushRoutes.ts`의 `/v1/sessions/:id/push-event`는 `void dispatchSessionEventPush(...)`로
  호출한 뒤 항상 `{ success: true }`를 응답한다.
- upstream(slopus/happy cf95337b6)은 같은 문제를 `PushOutcome`을 반환·응답에 펼쳐 담는 방식으로 고쳤다.
  우리 모양은 정본 R3-a의 평평한 객체로 다시 쓴다.

## 요구사항

정본: Desktop `specs/happy-upstream-benchmark/spec.md`

- R3. Given `dispatchSessionEventPush`, When 호출, Then `PushOutcome`(`sent | partial | suppressed | no_tokens | failed`,
  토큰 수·실패 사유 포함)을 반환하고 `/v1/sessions/:id/push-event` 응답에 담는다. 기존 void 호출자는 그대로 동작한다.

세부(작업 지시서 H1):

- R3-a. `PushOutcome = { status: 'sent' | 'partial' | 'suppressed' | 'no_tokens' | 'failed'; tokens: number; sent: number; failed: number; reason?: string }`.
  `dispatchSessionEventPush`가 이를 반환한다. `suppressed`는 presence 억제, `no_tokens`는 등록 토큰 없음,
  `failed`는 전송 전체 실패 또는 예외(사유 포함), `partial`은 일부 실패.
- R3-b. `fetchTokensAndSend`가 토큰 수·성공·실패 수를 돌려준다. Expo 응답의 `DeviceNotRegistered` 등 영구 실패는
  기존 토큰 정리 로직을 유지하면서 실패 수에 반영한다.
- R3-c. `/v1/sessions/:id/push-event` 응답은 `{ success: true, push: PushOutcome }`로 **필드 추가만** 한다(`success` 유지).
  다른 호출자(`void` 소비)는 그대로 동작한다.
- R3-d. `failed`·`partial`은 error 등급 로그에 사유와 함께, `suppressed`·`no_tokens`는 info. push 결과 카운터를
  `monitoring/metrics2.ts`에 붙인다.
- 구버전 CLI·Desktop은 새 필드를 무시하므로 호환된다.

## 결정 (R3-c 대기 방식)

- 핸들러는 dispatch 결과를 **기다려** 응답한다. CLI(`happy-cli/src/api/pushNotifications.ts`)는 이 요청을
  fire-and-forget(`void (async () => …)`, 15초 타임아웃)으로 보내므로 지연이 턴을 막지 않는다.
- 응답 지연에 상한을 두려고 `pushSend.ts`의 Expo 전송 전체에 8초 공용 마감(`AbortSignal.timeout`)을 둔다.
  마감을 넘긴 배치는 `Network error`/timeout 실패로 집계된다.
- SILENT 자동화 완료로 push를 보내지 않는 경로도 `push`를 채운다: `{ status: 'suppressed', reason: 'silent-automation', tokens: 0, sent: 0, failed: 0 }`.

## 수락 기준

- `pushDispatch.spec.ts`: 결과 5종 각 1건 이상(presence 억제, 토큰 0, 전부 성공, 일부 실패, 전부 실패·예외),
  `DeviceNotRegistered` 토큰 정리 유지.
- `pushRoutes.spec.ts`: 응답에 `push` 필드, `success` 유지, SILENT 경로도 `push` 포함.
- `pnpm typecheck`, happy-server `pnpm test` 관련 파일 통과, happy CI 초록.

## 범위 밖

- CLI·Desktop이 `push` 필드를 읽어 표시하는 일(이후 작업).
- 저장소 전반의 `log({ level: 'error' })` 관용구가 pino에서 info(30)로 기록되는 문제 — context.md 열린 문제 참조.
