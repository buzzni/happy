# Plan

## Phase 1 — 계약을 테스트로 고정 (Red)

`enableMonitoring.test.ts` 를 새 계약으로 재작성한다.

- (유지) `/live` 는 DB 를 조회하지 않는다
- (신규) `/ready` 는 DB 를 조회하지 않는다
- (신규, 회귀) **DB 가 죽어도 `/ready` 는 200** — 이번 장애 재현 테스트
- (이동) `/health` 는 DB 를 조회한다
- (이동) `/health` 는 DB 실패 시 503 + 기존 에러 바디

검증: 테스트 실행 → `/ready` 관련 신규 2건이 실패해야 한다.

## Phase 2 — 구현 (Green)

`enableMonitoring.ts` 에서 `/ready` 를 `sendReadiness` 대신 프로세스 상태
응답으로 바꾸고, DB 점검은 `/health` 에만 남긴다.

검증: 전체 테스트 통과.

## Phase 3 — 배포 경로 확인

- happy-server 이미지 릴리스 필요 여부 확인
- k8s readinessProbe 는 계속 `/ready` 를 보므로 매니페스트 변경 불필요
- `/health` 를 쓰는 알림이 필요한지는 별건(k8s-manifests)으로 남긴다

## 상태

- [x] Phase 1
- [x] Phase 2
- [x] Phase 3
