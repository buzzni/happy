# Agent 명령 direct-entry provider 격리 Tasks

> 상태: 승인됨 / 한 작업은 Red → Green → 검증 가능한 단위로 완료한다.

## Phase 1: 재현과 경계 확정

- [x] **T1.** 사고 로그에서 같은 Happy session id에 Codex와 accidental Claude process가 동시에
  등록되고 이후 `claude-sonnet-5`가 Codex로 전달된 순서를 확인한다.
- [x] **T2.** 설치형 `bin/happy.mjs`에는 `agent` 분기가 있지만 source `index.ts`에는 없음을 확인한다.

## Phase 2: TDD 구현

- [x] **T3.** direct-entry 위임 handler가 없어서 실패하는 단위 테스트를 먼저 실행한다.
- [x] **T4.** bundled manifest의 `bin.saycode`를 실행하고 인자·environment·status를 전달하는 최소
  `handleAgentCommand`를 구현한다.
- [x] **T5.** `src/index.ts`가 provider 기본 분기 전에 `agent`를 handler로 전달하게 한다.

## Phase 3: 검증

- [x] **T6.** 관련 테스트와 typecheck를 실행한다.
- [x] **T7.** build 산출물의 `agent whoami` 성공과 unsupported `--json` 실패가 provider를 시작하지
  않는지 확인한다.
- [x] **T8.** 전체 Happy CLI unit suite와 diff check를 통과시킨다(214파일/2,236테스트).

## Phase 4: 전달

- [x] **T9.** spec/context 완료 상태와 실제 검증 수치를 동기화한다.
- [x] **T10.** behavioral 구현 commit을 push하고 `origin/main` 대상 PR #241을 생성한다.

## Phase 5: 셀프 리뷰 1/4

- [x] **T11.** handler 단위 테스트만으로는 `index.ts` dispatch 누락을 탐지하지 못하는 회귀를 build된
  direct entrypoint subprocess 테스트로 고정한다.
- [x] **T12.** bundled command spawn 실패의 `result.error`가 묻히지 않도록 handler에서 전파하고
  entrypoint에서 사용자 친화적인 오류로 종료한다.
- [x] **T13.** 지원하지 않는 `--json`을 성공으로 가정한 unit fixture를 실제 `whoami` 계약으로 정정한다.
- [x] **T14.** direct-entry 테스트의 provider 부재 assertion을 대소문자 비구분으로 고정해 실제 로그의
  `[CLAUDE]` 같은 표기도 놓치지 않게 한다.
  → 검증: 관련 7개, typecheck, build, 전체 214파일/2,238테스트 통과
