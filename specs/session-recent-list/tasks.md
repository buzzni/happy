# 최근 활동 순 세션 목록 API Tasks

> 번호는 원본 Desktop `specs/cli-agent-session-search/tasks.md` Phase A(T3~T7)와 같다.

## 실행 순서 근거 (한 줄)

문서 → 실제 SQL로 동작을 고정하는 Red 테스트 → 최소 구현 → 기존 라우트 회귀 → 인덱스·문서 순서다.

## Phase A

- [ ] T3. 문서 세트(spec·plan·tasks·context) → 검증: 원본 S1~S9 대조
- [ ] T4. `GET /v2/sessions/recent` 테스트(Red): 정렬(updatedAt desc, 동률 id desc)·keyset 커서 연속 페이지 중복·누락 없음·`since` 경계(같음 포함)·잘못된 커서·`limit` 0/201 → 400·계정 격리(다른 계정 커서 포함)·managed scoped 토큰 401·`agentState` 미포함·archived 포함 → 최소 구현 → 검증: `vitest run sources/app/api/routes/sessionRoutes.pglite.spec.ts`
- [ ] T5. 기존 `/v1/sessions`·`/v2/sessions`·`/v2/sessions/active`·`/v2/sessions/lookup` 응답 불변 회귀(S8) → 검증: 같은 테스트 파일 + 기존 `sessionRoutes.spec.ts`
- [ ] T6. EXPLAIN으로 `[accountId, updatedAt desc]` 인덱스 범위 스캔 확인, `docs/api.md` 갱신 → 검증: 측정 기록을 context에
- [ ] T7. PR (2단계 — 오케스트레이터 지시 후. 머지·배포는 사용자/오케스트레이터 몫)
