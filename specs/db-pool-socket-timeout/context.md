# Context

## 2026-08-07 — 구현 완료

### 변경

- `sources/storage/databaseUrl.ts` (신규) — `buildAppDatabaseUrl(rawUrl, seconds)`
  순수 함수. 기존 쿼리 파라미터 보존, 명시된 `socket_timeout` 존중,
  URL 미설정/파싱 실패/비정상 값에서는 원본 유지.
- `sources/storage/db.ts` — postgres 경로에서 `new PrismaClient({ datasourceUrl })`
  로 앱 풀에만 주입. pglite 경로는 변경 없음.
- `sources/storage/databaseUrl.spec.ts` (신규) — 6개 테스트로 계약 고정.

### 검증

- 신규 테스트 6/6
- happy-server 전체 스위트 499/499 (43 파일)
- `tsc --noEmit` exit 0

### 운영 메모

- 기본 30초. `DATABASE_SOCKET_TIMEOUT_SECONDS` 로 재정의 가능.
- `prisma migrate deploy` 는 원본 `DATABASE_URL` 을 그대로 쓰므로 영향 없음.
  **매니페스트의 DATABASE_URL 에 `socket_timeout` 을 넣지 말 것** — 그 순간
  마이그레이션에도 적용된다.
- 코드 반영에는 happy-server 이미지 릴리스(서브모듈 포인터 갱신) 필요.
