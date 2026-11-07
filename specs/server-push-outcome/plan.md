# happy-server push 결과 보고(PushOutcome) Plan

> 작성일: 2026-11-07 / 상태: 승인됨(정본 R3)
> 근거 문서: [spec.md](./spec.md)

## 아키텍처 영향

| 항목 | 내용 |
|------|------|
| 관련 모듈 | `packages/happy-server/sources/app/push/{pushDispatch,pushSend}.ts`, `sources/app/api/routes/pushRoutes.ts`, `sources/app/monitoring/metrics2.ts` |
| 새 외부 의존성 | 없음 |
| 공개 API 변경 | `/v1/sessions/:id/push-event` 200 응답에 `push` 필드 **추가만**(구버전 클라이언트는 무시) |
| 데이터 스키마 변경 | 없음 |
| Core/Extension | Core — 서버 알림 전송 경로 자체 |

## 접근 방식

1. `pushDispatch.spec.ts`(신규)로 결과 5종 실패 테스트 → `PushOutcome` 반환 구현.
2. `pushRoutes.spec.ts`에 응답 `push` 필드 테스트 → 핸들러가 결과를 기다려 응답.
3. `pushSend.ts`에 8초 공용 마감 — 핸들러 대기 상한.
4. `metrics2.ts`에 `push_outcomes_total{status}` 카운터, dispatch에서 증가.

## 대안

- 응답만 즉시 하고 결과를 버리기(현행) — R3 미충족.
- upstream처럼 결과를 응답 최상위에 펼치기 — 기존 `success`와 키 충돌 위험, 정본이 `push` 하위 필드를 지정.

## 검증·복구

- 관련 vitest, `pnpm typecheck`, happy CI.
- 되돌리기: 커밋 revert. 응답 필드 추가만이라 클라이언트 영향 없음.
