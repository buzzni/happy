# context

## 상태: 구현 및 릴리스 완료, 사후 추적 문서 보완

PR #293 (`5dbd3a98`)에서 runtime activity heartbeat와 busy handoff 차단이
`main`에 병합되었다. 구현 브랜치의 두 번째 커밋은 `spec/tasks T14`를 참조했지만
해당 feature 문서가 포함되지 않아, 이 폴더가 병합된 요구사항과 검증 근거를
사후 복원한다. 새로운 제품 동작은 추가하지 않는다.

## 변경 범위

- `packages/happy-cli/src/api/types.ts` — optional activity schema
- `packages/happy-cli/src/api/apiMachine.ts` — encrypted daemon state heartbeat producer
- `packages/happy-cli/src/daemon/daemonTerminalSessions.ts` — terminal count
- `packages/happy-cli/src/daemon/run.ts` — session/automation activity 집계 및 handoff 연결
- `packages/happy-cli/src/daemon/daemonHandoffAutomationGate.ts` — busy session gate
- `packages/happy-cli/src/daemon/handoff.ts` — preflight 이후 activity 재검증
- 위 동작의 관련 unit test 4개 파일

## 검증 기록

- PR #293 CLI Smoke Test: Linux Node 20/24, Windows Node 20/24 모두 성공
- 독립 focused unit: 4 files, 45 tests 통과
- `packages/happy-cli` typecheck 통과
- `git diff --check` 통과
- focused Vitest 실행 중 병렬 build의 `dist` 정리에서 일시적인 ENOENT 로그가 한 번
  관찰됐지만, 최종 test runner와 후속 typecheck는 성공했다. 소스 회귀로 재현되지는
  않았으며 build concurrency의 잔여 관찰 항목이다.

## rollout 기록

- PR #294에서 `1.1.10-aplus.156` version bump가 병합되었다.
- `happy-cli-v1.1.10-aplus.156` 태그의 `Publish @buzzni/happy-cli` workflow가
  2026-08-28에 성공했다.
- 문서 작성 시점의 `main` package version은 후속 릴리스인
  `1.1.10-aplus.157`이다.

## 남은 위험

- 이 CLI 계약을 소비하는 Web scheduler의 absent/stale activity 정책은 별도
  저장소·기능 범위이며 여기서는 검증하지 않았다.
- activity publish 실패는 daemon debug log에 남고 다음 heartbeat에서 재시도된다.
  운영 환경에서 반복 실패를 별도 경보로 승격하는 정책은 이번 범위 밖이다.
