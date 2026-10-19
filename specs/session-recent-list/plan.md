# 최근 활동 순 세션 목록 API Plan

> 작성일: 2026-10-19 / 상태: 승인됨(원본 Desktop `specs/cli-agent-session-search/plan.md` Phase A)
> 근거 문서: [spec.md](./spec.md)

## 아키텍처 영향

| 항목 | 내용 |
|------|------|
| Core / Extension | Core — 세션 authoritative state의 목록 API(원본 plan 분류를 따름). |
| 관련 모듈 | `packages/happy-server/sources/app/api/routes/sessionRoutes.ts`(라우트 추가), 새 테스트 `sessionRoutes.pglite.spec.ts`, `managedSessionDataRoutes.spec.ts`(거부 목록에 한 줄), `docs/api.md` |
| 공개 API 변경 | 추가만 — `GET /v2/sessions/recent`. 기존 라우트 불변(S8). |
| 데이터 스키마 | 변경 없음. 기존 인덱스 `[accountId, updatedAt desc]` 사용. |
| 새 의존성 | 없음 |

## 접근 방식

기존 `GET /v2/sessions` 핸들러를 선례로 같은 파일에 라우트를 하나 추가한다.
keyset 조건은 `updatedAt < c.updatedAt OR (updatedAt = c.updatedAt AND id < c.id)`이고, `since`는 같은 `where`에 `AND updatedAt >= since`로 붙는다.
`updatedAt`은 밀리초 정밀도(`timestamp(3)`)라 커서의 epoch ms가 행 값과 정확히 같다(spec B5) — 동률 행이 경계에서 빠지거나 반복되지 않는다.
커서는 `^cursor_v2_(\d+)_(.+)$`로 해석하고, 시각이 JS Date 범위(±8.64e15) 밖이면 400이다. `since`·커서 시각 상한도 같다(Invalid Date가 500이 되지 않게).

## 결정과 기각한 대안

| 안 | 판정 |
|----|------|
| `GET /v2/sessions`에 `sort=updatedAt` 추가 | 기각 — 구 서버가 파라미터를 버리고 id 순으로 답해도 클라이언트가 구분할 수 없다(원본 S1). |
| `(updatedAt, id)` 튜플 비교 raw SQL | 기각 — Prisma `where`의 OR 조건으로 같은 의미를 표현할 수 있고, raw SQL은 이 파일 관례가 아니다. 인덱스 사용은 EXPLAIN으로 확인. |
| 새 복합 인덱스 `[accountId, updatedAt desc, id desc]` | 보류 — 스키마 변경 금지 범위. 동률(`updatedAt` 같은 ms) 행만 추가 정렬하므로 기존 인덱스로 충분. 실측에서 필요하면 별도 제안. |
| 테스트를 mock db로 | 기각(정렬·커서 부분) — keyset 조건의 의미는 실제 SQL로만 검증된다. 기존 `*.pglite.spec.ts` 관례로 PGlite에 실제 스키마를 올려 검증한다. |

## 단계

- [ ] Phase A-1: 문서 세트(T3)
- [ ] Phase A-2: Red 테스트 → 최소 구현(T4), 기존 라우트 불변 회귀(T5)
- [ ] Phase A-3: EXPLAIN 확인, `docs/api.md`(T6)
- [ ] Phase A-4: PR(T7 — 2단계, 오케스트레이터 지시 후)

## 리스크와 대응

- managed 토큰이 새 라우트에 닿음 → `app.authenticate`만 쓰고 allowlist는 정확 일치라 추가하지 않는다. 실제 `enableAuthentication` + 실제 서명 토큰으로 401 테스트.
- 커서 위조로 다른 계정 행 노출 → `accountId` 조건이 항상 붙는다. 커서는 정렬 위치일 뿐 권한이 아니다. 다른 계정 행의 커서를 넣어도 자기 계정 행만 나오는지 테스트.
- 행 크기 → `agentState` 제외, 최대 200행.

## 복구

라우트 추가만이므로 revert로 제거한다. 스키마 변경이 없고, CLI는 구 서버 폴백(404·405·SPA fallback HTML 200 → `/v1/sessions`)이 있어 서버를 되돌려도 깨지지 않는다.
