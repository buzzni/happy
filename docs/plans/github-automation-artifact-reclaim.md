# GitHub 자동화 산출물 회수

## 문제와 결정

자동화가 lockfile·재현 테스트·소스를 변경하면 전체 worktree 삭제가 보류되어 의존성까지 계속 남는다.
dirty 소스의 보존 정책을 유지하면서 재생성 가능한 산출물만 별도로 회수한다.
이는 daemon의 Core 파일 수명주기 책임이며 새 서버 API나 Desktop 화면을 추가하지 않는다.

## 실행과 범위

- 기존 `discardRememberedGithubWorktree`가 dirty 결과를 반환하기 전에 회수 모듈을 호출한다.
  깨끗한 worktree의 기존 삭제·재개용 tombstone은 그대로 유지한다.
- daemon 자동화 원장이 전달한 `happyHomeDir/automation-worktrees/<24자리 해시>`의
  실제 linked worktree만 허용한다. Git 등록과 repository common-dir도 대조한다.
- `node_modules`, `.next`, `.vite`, `.turbo`, `coverage`, `playwright-report`, `test-results`가 후보다.
  Git ignore뿐 아니라 강제 추적 파일·중첩 저장소·실경로·symlink를 독립적으로 확인한다.
- Git HEAD/index/ORIG_HEAD, worktree 및 산출물 내용의 최근 24시간 활동을 보호한다.
  daemon이 추적하는 원래/현재 작업 경로, 하위 프로젝트, 시작·재개 중 요청과 열린 OS 파일을 보호한다.
- 소스·lockfile·untracked 재현 테스트·브랜치·worktree는 회수하지 않는다.
  `/tmp/claude-*` 등 소유/폐기 계약이 없는 임시 프로젝트도 이번 대상이 아니다.

## 재시작·관측·복구

관리 루트의 `.artifact-reclaim/<해시>.json`에 worktree 파일 신원과 마지막 검사 시각,
보호 사유·삭제 건수·논리 용량·파일시스템 가용 공간 전후를 원자적으로 기록한다.
Git 작업 사본 밖에 있어 정리 기록이 새 untracked 변경을 만들지 않는다.
동일 daemon의 동시 요청은 진행 중 Promise를 공유하며, 재시작 뒤에는 영수증으로 일일 검사 간격을 유지한다.
기존 틱은 자동화 목록이 비었어도 원장 정리를 수행하므로 새 예약 타이머는 필요 없다.

POSIX `lsof`가 실패하거나 읽을 수 없는 프로세스 경로를 반환하면 삭제하지 않는다.
Windows에서는 기존 GitHub 자동화 host-command 제한을 유지한다. 불확실한 조회를 빈 목록으로 간주하거나
관리자 권한으로 우회하지 않는다. 이 제약은 보존 결과/오류로 기록되며 기본 자동화 실행은 계속된다.
진단 로그 접두사는 `[github-artifact-reclaim]`이고 실패도 일일 재검사로 제한한다.

롤백은 daemon의 새 `reclaimArtifacts` 연결을 제거하는 것이다. 기존 dirty 보존으로 돌아가며,
이미 회수한 의존성은 사본의 원래 lockfile을 사용해 재설치한다.
다른 자동화·전역 임시 폴더·추가 산출물을 지원하거나 프로세스 관측 방식을 바꿀 때 이 경계를 재검토한다.

## 검증과 출시

실제 Git fixture에서 dirty source/untracked 재현 파일 보존, 여러 산출물 회수, 강제 추적 파일,
중첩 저장소·lock·symlink·프로세스/재개 보호·검사 간격·중복 실행을 검증한다.
원장에 남은 예전 세션이 종료됐어도 같은 폴더의 새 세션을 보호하는 회귀도 포함한다.
대상 테스트는 `githubWorktreeArtifactReclaim`, `githubTriggerWorktree`,
`serverAutomationExecutor`, `githubWorktreeTombstones`, `resumeMissingWorktreeWiring`의 5개 suite다.

2026-10-25 기본 Vitest 설정에서 위 5개 suite의 222개 테스트를 통과했다.
global setup의 CLI 프로덕션 빌드와 타입 검사도 성공했다. macOS 임시 폴더 fixture는 실제 경로로 만들고, 관리 루트의 symlink 별칭은 계속 거부하는 회귀를 포함한다. 현재 PC의 실제 호스트에서 격리 fixture로
기본 OS probe를 실행했을 때는 일부 보호된 시스템 프로세스 때문에 `incomplete process inventory`를
반환했고, 삭제 0건과 dirty 소스 보존을 확인했다. 정상 회수는 실제 Git/파일 fixture와 통제된
프로세스 관측 입력으로 검증했다. 실제 사용자 데이터 삭제나 실행 중 daemon 교체는 수행하지 않았다.

이 변경은 소스 구현이며 자동으로 실행 중 daemon을 교체하지 않는다.
Happy CLI 공식 릴리스와 Desktop runtime pin 반영 후 사용자에게 제공한다.
CLI 게시/태그 push는 AGENTS.md의 별도 외부 실행 승인을 따른다.

출시 안내 초안: **GitHub 자동화가 작업 사본을 보존하더라도 오래된 의존성과 빌드 산출물을
안전하게 정리해 디스크 누적을 줄입니다. 변경된 소스와 사용 중인 작업은 유지합니다.**

English: **GitHub automations reclaim old generated dependencies and build outputs while preserving
changed source and active work. Applied automatically when safe process observation is available.**
