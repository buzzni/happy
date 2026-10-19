# 최근 활동 순 세션 목록 API Context

> 마지막 갱신: 2026-10-19 / 상태: 진행중 — T3~T6 구현·검증·교차 리뷰 반영 완료, T7 PR #884 리뷰 대기

## 현재 상태 (3~5문장)

Desktop `specs/cli-agent-session-search` Phase A를 이 저장소에서 구현했다(Orca 2차 D3A).
`GET /v2/sessions/recent`를 `sessionRoutes.ts`에 추가했고, PGlite 실제 스키마 테스트와 실제 PostgreSQL managed 스위트로 S1~S9를 검증했다.
브랜치 `orca-d3a-sessions-recent`, base origin/main `135bf5b2f`. PR https://github.com/buzzni/happy/pull/884 (머지·배포 전).

## 핵심 결정 로그 (누적, 최신이 위)

- [2026-10-19] 교차 리뷰(codex) low 1건 반영: 커서 id에 NUL(`%00`)이 있으면 PostgreSQL이 `22021`로 질의를 거부해 500이 났다. 파서 정규식을 `([^\0]+)`로 바꿔 400으로 막는다(테스트로 500 재현 후 수정). 같은 원인 점검: `since`·`limit`은 zod 숫자 변환이라 NUL이 400으로 이미 막힌다(테스트 추가), UTF-8이 아닌 바이트(`%FF`·`%ED%A0%80`·`%C0%80`)는 500을 내지 않는다(테스트 추가). 기존 `GET /v2/sessions`의 `cursor_v1_<id>`도 NUL이면 500이지만 기존 라우트 불변 범위라 고치지 않았다(아래 열린 문제).
- [2026-10-19] 셀프 리뷰(`/code-review high`) 7건 처리:
  반영 ① `since`·커서 시각 상한을 JS Date 한계(8.64e15)에서 9999년 마지막 ms(253402300799999)로 낮춤 — Prisma가 다섯 자리 연도를 보내지 못해 500이 났다(테스트로 재현 후 수정, 경계값 수용 테스트 추가).
  반영 ② `docs/api.md`: 페이지 중 갱신된 세션은 "중복"이 아니라 "누락"된다고 정정, `updatedAt`이 presence timeout·archive 같은 서버 쓰기에도 움직인다고 명시.
  반영 ③ 라우트 주석·`docs/api.md`에 구 self-host 서버의 SPA fallback `200 text/html`(`api.ts` notFound가 `/v2`를 예약하지 않음)을 명시.
  미반영 ④ "recent activity"가 서버 housekeeping 쓰기(presence timeout 등)에도 움직임 — 원본 spec S3가 `updatedAt` 정렬을 정했고 S9가 누락을 알려진 제한으로 둔다. 문서에 명시만 했다(아래 열린 문제).
  미반영 ⑤ 세션 행 `select`·매핑 중복(이 파일 5곳) — 공통화는 기존 4개 라우트를 건드리는 구조 변경이라 이번 범위(기존 라우트 불변) 밖. 기록만.
  미반영 ⑥ `*.pglite.spec.ts` 파일명 — `v3SessionRoutes.pglite.spec.ts` 선례를 따름.
  미반영 ⑦ `limit = 100` 구조분해 기본값·`hasNext && last` — 옆 `GET /v2/sessions`와 같은 모양이고 `last`는 타입 좁히기에 쓰인다.
- [2026-10-19] 셀프 리뷰 체크리스트: 최악 입력 시간 — 커서 정규식(`^cursor_v2_(\d{1,15})_(.+)$`)은 1MB 입력에서 0.41ms 이하(선형, Node URL 길이 상한 약 16KB). 프로토타입 키 — 사용자 입력을 객체 키로 쓰지 않음(zod가 모르는 키 제거). DOM·포커스·스트리밍·분할 화면 — 해당 없음(서버 라우트).
- [2026-10-19] 커서 페이지에 `updatedAt <= 커서 시각` 조건을 중복으로 하나 더 건다.
  이유: keyset `OR`(`updatedAt < c OR (updatedAt = c AND id < cid)`)만 있으면 PostgreSQL이 인덱스 상한을 만들지 않아 `Filter`로 처리한다 — 페이지마다 계정의 더 최신 행을 전부 다시 읽는다(아래 측정에서 833행 제거, 버퍼 1037).
  중복 조건을 더하면 `Index Cond`에 상한이 들어가 커서 위치부터 읽는다(버퍼 208, 제거 0). 의미는 같다(OR의 두 갈래 모두 `<=`를 함축).
  회귀 방지: `sessionRoutes.pglite.spec.ts` "bounds a cursor page by the index on both sides" — Prisma가 실제로 보낸 SQL을 EXPLAIN해 `Index Cond`에 `updatedAt <=`가 있는지 본다. 조건을 빼면 실패함을 확인했다.
- [2026-10-19] 테스트는 PGlite에 실제 스키마를 올려 검증한다(`v3SessionRoutes.pglite.spec.ts` 관례). keyset 조건의 의미는 mock으로 검증되지 않는다. 인증은 실제 `enableAuthentication`과 실제 서명 토큰을 쓴다(managed 401이 운영과 같은 경로).
- [2026-10-19] `since`·커서 시각은 9999년 마지막 ms(253402300799999) 이하만 받는다(위 리뷰 ①). 넘으면 Prisma 직렬화 실패·Invalid Date로 500이 나므로 400으로 막는다. 빈 `cursor=`도 형식 오류(400)다.

## EXPLAIN 측정 (T6, 2026-10-19)

- 환경: 로컬 임시 컨테이너 `postgres:16-alpine`, `prisma migrate deploy`, 계정 40개 × 세션 2,500개(90일에 무작위 `updatedAt`), `ANALYZE` 후 Prisma `log: query`로 실제 SQL을 받아 `EXPLAIN (ANALYZE, BUFFERS)`.
- 첫 페이지(`since` 있음/없음, `take 201`): `Index Scan using "Session_accountId_updatedAt_idx"` + `Incremental Sort (Presorted Key: updatedAt)`, 0.12~0.13 ms, 버퍼 205.
- 커서 페이지: 수정 전 `Index Cond`는 `accountId`·`since`뿐, keyset은 `Filter`(833행 제거, 버퍼 1037, 0.25 ms) → 수정 후 `Index Cond`에 `updatedAt <= 커서`(제거 0, 버퍼 208, 0.18 ms).
- 모든 경우 요청당 SQL 1개. 동률(`updatedAt` 같은 ms) 행만 incremental sort로 `id` 정렬 — 새 복합 인덱스는 필요 없다고 판단.

## 발견된 문제 / 열린 질문

- 기존 `GET /v2/sessions?cursor=cursor_v1_s%00x`도 500을 낸다(2026-10-19 실측, PGlite). 이 작업은 기존 라우트 동작을 바꾸지 않으므로 고치지 않았다 — 별도 작은 수정 후보.
- `Session.updatedAt`은 새 메시지뿐 아니라 presence timeout(`active=false`)·archive·rewrap 같은 서버 쓰기에도 갱신된다(`@updatedAt`). 그래서 "최근 활동"에는 이런 세션도 포함되고, 훑는 도중 갱신된 세션은 그 훑기에서 빠진다(S9). 소비자(Desktop CLI search)는 이를 알고 `meta`를 해석해야 한다 — 원본 spec Phase B에 전달할 사항.
- `managedSessionDataRoutes.spec.ts`는 `HAPPY_MANAGED_TEST_DATABASE_URL`이 있을 때만 돈다(CI 워크플로에 설정 없음). 이번에는 로컬 임시 PostgreSQL로 실행해 46개 통과를 확인했다. 새 라우트의 managed 401은 CI에서 도는 `sessionRoutes.pglite.spec.ts`에도 있다.

## 다음 세션 시작점

1. PR #884 CI·리뷰 확인. 머지·서버 배포는 사용자/오케스트레이터 몫.
2. 소비자: Desktop `cli/`의 `saycode agent search`(원본 spec Phase B, R10-b 구 서버 판별).

## 검증·승인 상태

- 실행한 검증: 임시 PostgreSQL(`HAPPY_MANAGED_TEST_DATABASE_URL`)로 `sessionRoutes.pglite.spec.ts`(34개)·`sessionRoutes.spec.ts`·`managedSessionDataRoutes.spec.ts`·`sources/app/managed`·`browserSyncRestAccess.spec.ts`·`sources/app/api/utils` — 18파일 중 17 통과·1 건너뜀, 428개 통과·8개 건너뜀. `tsc --noEmit` 통과.
- 승인된 범위: 원본 spec 승인(2026-10-19 "추천대로") — 라우트 추가, 배포 제외.
- 금지: 스키마·마이그레이션, 서버 배포·태그·버전 변경, 기존 라우트 동작 변경.
