# happy-server push 결과 보고(PushOutcome) Tasks

## 실행 순서 근거

dispatch 반환값(T1)이 있어야 라우트(T2)가 응답에 담을 수 있다. 마감(T3)·메트릭(T4)은 독립.

- [x] T1. `PushOutcome` 타입·`fetchTokensAndSend` 집계·`dispatchSessionEventPush` 반환 (R3-a, R3-b, R3-d 로그) — `pushDispatch.spec.ts`
- [x] T2. `/v1/sessions/:id/push-event`가 결과를 기다려 `push` 필드로 응답, SILENT 경로 포함 (R3-c) — `pushRoutes.spec.ts`
- [x] T3. `pushSend.ts` 8초 공용 마감 (R3-c 대기 상한) — `pushSend.spec.ts`
- [x] T4. `push_outcomes_total{status}` 카운터 (R3-d)
- [ ] T5. typecheck·관련 테스트·셀프 리뷰·교차 리뷰·PR·CI
