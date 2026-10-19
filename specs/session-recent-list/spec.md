# 최근 활동 순 세션 목록 API (`GET /v2/sessions/recent`) Spec

> 작성일: 2026-10-19 / 상태: **승인됨** (원본 spec의 승인을 따름 — 2026-10-19 사용자 결정 "추천대로", happy-server 목록 API 신설 허용, 배포는 사용자 몫)
> ⚠️ 승인 후에는 사용자 지시 없이 수정 금지
> 원본: `buzzni/aplus-dev-studio-desktop` `specs/cli-agent-session-search/spec.md` "요구사항 — happy-server 목록 API (Phase A)" S1~S9 (main `1f44565a7`).
> 이 문서는 원본 S1~S9를 이 저장소에서 구현하기 위한 사본이다. 요구사항이 다르면 원본이 우선한다.

## 목표

Desktop 저장소의 `saycode agent search`(에이전트용 대화 검색 CLI)가 계정 최신 150개(`GET /v1/sessions`) 밖의 세션까지
**최근 활동 순으로** 훑을 수 있게, 계정 단위 `updatedAt` keyset 커서 목록 라우트를 추가한다.
서버는 metadata를 해석하지 않는다 — 스코프(머신·프로젝트 경로) 판정과 복호화는 CLI가 한다.

## 배경 (origin/main `135bf5b2f`에서 확인)

| # | 사실 | 근거 |
|---|------|------|
| B1 | `GET /v1/sessions`는 `accountId` 기준 `updatedAt desc`로 **150개**에서 끊는다. | `sources/app/api/routes/sessionRoutes.ts` `app.get('/v1/sessions')` |
| B2 | 기존 커서 목록 `GET /v2/sessions`(`cursor_v1_<id>`)은 **id(생성 순) 내림차순**이라, 상한에서 자를 때 오래 전에 만들었지만 최근 활동한 세션이 먼저 잘린다. | 같은 파일 `app.get('/v2/sessions')` |
| B3 | `Session`에는 머신·경로·작성자 평문 컬럼이 없다(암호화된 `metadata` 안에만 있음). 인덱스는 `[accountId, updatedAt desc]`가 있다. | `prisma/schema.prisma` `model Session` |
| B4 | `app.authenticate`는 계정 bearer와 browser-sync 자격만 해석한다. managed session-scoped 토큰은 해석하지 않아 **401**이다(기존 `GET /v2/sessions` 거부 선례). managed 허용 라우트는 정확 일치 allowlist다. | `sources/app/api/utils/enableAuthentication.ts`, `sources/app/managed/managedScopeAllowlist.ts` `ALLOWED_ROUTES`, `managedSessionDataRoutes.spec.ts` "refuses a route no child may reach" |
| B5 | Prisma `DateTime`은 PostgreSQL `timestamp(3)`(밀리초)라 `updatedAt`을 epoch ms로 왕복해도 값이 보존된다. | `prisma/migrations` |

## 요구사항

- S1. **라우트**: `GET /v2/sessions/recent`. 기존 `GET /v2/sessions`에 파라미터를 더하지 않는다(구 서버가 모르는 파라미터를 버리고 id 순으로 답해도 클라이언트가 알아챌 수 없음).
  인증은 `app.authenticate`(계정 bearer·browser-sync 자격).
- S2. **질의 파라미터**(zod 검증): `limit` 정수 1~200(기본 100), `since` epoch ms 양의 정수(선택 — `updatedAt >= since`), `cursor`(선택, 불투명 문자열).
  형식이 틀린 `cursor`·범위 밖 값은 **400**.
- S3. **필터·정렬**: `where accountId = 인증 계정 [AND updatedAt >= since]`, `orderBy [updatedAt desc, id desc]`, `take limit+1`.
  커서는 마지막 행의 `(updatedAt, id)` keyset이며 형식은 `cursor_v2_<updatedAtMs>_<id>`다. 다음 페이지는 `(updatedAt, id) < 커서`인 행이다.
  archived(`active=false`) 세션도 포함한다. 기존 인덱스 `[accountId, updatedAt desc]`를 쓴다(새 인덱스 없음).
- S4. **응답**: `{ sessions: [{ id, seq, createdAt, updatedAt, active, activeAt, metadata, metadataVersion, dataEncryptionKey }], nextCursor, hasNext }`.
  시각은 epoch ms, `metadata`는 암호문 그대로, `dataEncryptionKey`는 base64 또는 null. `agentState`·`agentStateVersion`·`lastMessage`는 싣지 않는다.
  `nextCursor`는 `hasNext`가 참일 때만 문자열, 아니면 null.
- S5. **권한**: 인증 계정 소유 세션만. 다른 계정 세션은 나오지 않는다. managed scoped 토큰은 **401**로 거부한다(allowlist에 추가하지 않음, 새 라우트 전용 403 처리 없음).
  transcript-read grant의 viewer 키 교체는 lookup 전용이라 이 라우트에는 없다.
- S6. **E2EE 불변**: 서버는 metadata를 해석하지 않고, 머신·경로·작성자로 거르지 않으며, 스키마·마이그레이션 변경이 없다.
- S7. **성능 상한**: 한 요청 최대 200행. 쿼리는 인덱스 범위 스캔이어야 하고(EXPLAIN으로 확인), 요청당 DB 질의는 1회다.
- S8. **하위호환**: `/v1/sessions`·`/v2/sessions`·`/v2/sessions/active`·`/v2/sessions/lookup`의 동작·응답은 바꾸지 않는다.
- S9. **일관성**: 페이지를 넘기는 동안 갱신된 세션은 커서보다 앞으로 이동해 그 훑기에서 빠질 수 있다. 서버는 스냅샷을 보장하지 않으며, 클라이언트가 id로 중복을 제거한다(알려진 제한).

## 비목표

- 서버가 스코프(머신·경로·프로젝트)로 거르는 것 — 평문 컬럼이 필요한 E2EE 경계 변경이다.
- 새 인덱스·스키마·마이그레이션.
- rate limit 추가(기존 목록 라우트에도 없음).
- 서버 배포·태그(`happy-server-v*`)·버전 변경 — 사용자 몫.
- CLI 소비(`saycode agent search`) — Desktop 저장소 원본 spec Phase B.

## 완료 기준

- [ ] S1~S9 라우트 테스트 통과: 정렬, keyset 커서 연속 페이지 중복·누락 없음, `since` 경계(같음 포함), 잘못된 커서·`limit` 경계 400, 계정 격리, managed 401, `agentState` 미포함, 기존 4개 라우트 불변.
- [ ] EXPLAIN으로 인덱스 범위 스캔 확인(context에 기록).
- [ ] `docs/api.md` 갱신.
- [ ] typecheck 통과.
