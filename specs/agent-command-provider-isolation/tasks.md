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

## Phase 6: 셀프 리뷰 1/3

- [x] **T15.** build된 direct entrypoint가 provider dispatch 전 Happy log를 만들고 Claude settings를
  읽는 import-time side effect를 isolated HOME 회귀 테스트로 재현한다.
- [x] **T16.** 경량 `index.ts` bootstrap과 기존 runtime command 구현을 분리해 `agent`가 runtime
  module graph를 로드하기 전에 bundled Saycode로 위임되게 한다.
- [x] **T17.** `bin/happy.mjs`의 중복 agent dispatch를 제거하고 wrapper/direct entrypoint가 같은
  bootstrap 계약을 통과하는지 각각 검증한다.
- [x] **T18.** 전체 CLI unit suite, build/typecheck, diff check를 다시 통과시킨다.
  → 검증: 관련 8개, build/typecheck, 전체 214파일/2,239테스트 통과

## Phase 7: 셀프 리뷰 2/3

- [x] **T19.** package가 공식 노출하는 CommonJS direct entrypoint도 provider runtime을 로드하지 않고
  agent 명령을 위임하는지 isolated HOME 회귀 행렬에 추가한다.
- [x] **T20.** source/ESM/CJS/wrapper와 Bun 실행을 점검하고 baseline 대조 후 전체 검증을 반복한다.
  → 검증: 관련 9개, build/typecheck, 전체 214파일/2,240테스트 통과
