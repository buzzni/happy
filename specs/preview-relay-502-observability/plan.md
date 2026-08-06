# Plan

Tidy First — 구조적 변경(Phase 1)과 동작 변경(Phase 2)을 별도 커밋으로 분리한다.

## Phase 1 — [구조적] 업스트림 path 계산을 소켓 조회보다 위로 이동  ✅ Done

`upstreamPath` 는 `buildPreviewUpstreamPath(subPath, request.raw.url)` 로만
계산되는 순수 값인데, 지금은 머신 소켓 조회 **아래**에 있다. 그래서
`machine-offline` 분기에서는 ptoken 이 제거된 path 를 쓸 수 없다
(spec Requirement 4 를 지키려면 필요).

- 계산 위치만 위로 옮긴다. 동작 변경 없음.
- 검증: `previewRoutes*.spec.ts` 전량 통과 (이동 전후 동일)

## Phase 2 — [동작] 실패 원인 로그 추가  ✅ Done

- 🔴 `previewRoutesFailureLog.spec.ts` 작성 — `describePreviewRelayFailure()`
  가 두 분기의 `status`/`reason`/로그 라인을 올바로 만드는지.
  현재 그 함수가 없으므로 실패한다.
- 🟢 `previewRoutes.ts` 에 `describePreviewRelayFailure()` 를 export 하고
  두 실패 분기에서 호출 + `log({ module: 'preview', level: 'warn' }, …)`.
  상태 코드 매핑은 기존 인라인 로직을 그대로 옮긴다 (400/504/502).
- 검증: 신규 스펙 + 기존 프리뷰 스펙 4종 통과

## Out of scope (spec Non-Goals 참조)

CONNECTION_REFUSED → 503 분리, 액세스 로그 레벨 조정, WS 릴레이 502.
