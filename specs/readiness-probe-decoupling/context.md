# Context

## 2026-08-05 — 구현 완료

### 변경

`packages/happy-server/sources/app/api/utils/enableMonitoring.ts`

- `sendReadiness` → `sendHealth` 로 이름 변경 (DB 점검은 `/health` 전용)
- `sendProcessStatus` 추출 — DB 무관 성공 응답
- `/live`, `/ready` → `sendProcessStatus` (DB 조회 없음)
- `/health` → `sendHealth` (DB 조회, 실패 시 503)

`enableMonitoring.test.ts` — 5개 테스트로 새 계약 고정. 핵심은
`stays ready while the database is unreachable` (장애 재현 회귀 테스트).

### 검증

- 해당 파일 테스트 5/5 통과
- happy-server 전체 스위트 481/481 통과 (40 파일)
- `tsc --noEmit` exit 0

### 배포 경로

- k8s readinessProbe 는 계속 `/ready` 를 보므로 **매니페스트 변경 불필요**
- 코드 반영에는 happy-server 이미지 릴리스 필요
- `/ready` 는 이 저장소 안에서 k8s probe 외 사용처가 없음 (grep 확인)

### 남은 별건

- `/health` 기반 DB 헬스 알림 추가 (k8s-manifests) — 현재는 Prisma 풀
  메트릭 알림이 그 역할을 대신하고 있어 필수는 아님
- `socket_timeout=10`, replicas 2 + PDB
