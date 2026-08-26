# 구현 계획

Tidy First — 구조적 변경과 동작 변경을 분리한다. 각 Phase 는 Red → Green 으로
진행하고 Phase 마다 테스트를 돌린다.

## Phase 1 — 실패 사유에서 명령 에코 제거 (AC6)

**Status: Done**

- `describeQueryFailure` 가 `Command failed: <명령>` 접두사를 걷어내고 stderr 를
  남기도록 실패 테스트로 고정한다.
- 접두사가 없거나 stderr 가 비면 기존 동작을 유지한다.
- 200자 예산이 stderr 에 쓰이는지 확인한다.

## Phase 2 — 로그 접두사 중복 제거 (AC5)

**Status: Done**

- `serverAutomationExecutor` 의 두 로그가 자기 서술적 `query.error` 를 그대로
  쓰도록 바꾼다.
- executor 테스트로 `GitHub query failed:` 가 한 번만 나타남을 고정한다.

## Phase 3 — paths 필터가 없으면 파일 목록 미요청 (AC1~AC3)

**Status: Done**

- 스키마의 `changedFiles`/`files` 를 optional + default 로 바꿔 파일 없는 출력도
  파싱되게 한다 (AC3).
- `queryGithubPullRequests` 가 `includeChangedFiles` 를 받아 명령을 구성한다.
  생략 시 기존처럼 포함해 하위 호환을 유지한다.
- `serverAutomationExecutor` 가 `filter.paths.length > 0` 을 전달한다.
- 경로 필터가 있는 트리거의 동작이 변하지 않음을 회귀 테스트로 확인한다 (AC2).

## Phase 4 — baseline 관측 수 로깅 (AC4)

**Status: Done**

- `githubTriggerDomain` 에 baseline 알림 문자열을 만드는 순수 함수를 추가하고
  테스트한다. 첫 관측이 아니면 `null` 을 돌려준다.
- 관측 0건이면 실행 계정 권한 가능성을 문장에 포함한다.
- executor 가 baseline 을 기록할 때 이 줄을 로깅한다.

## Phase 5 — 검증과 릴리스

**Status: Done**

- `daemon/automations` 전체 + typecheck.
- 실제 `gh` 로 AC1 효과를 실측한다 (파일 필드 유무에 따른 소요 시간·응답 크기).
- PR → 머지 → `1.1.10-aplus.138` 범프 → 태그 push → CI publish.
- `vendor/happy` 포인터 PR, 데몬 업데이트 후 로그로 최종 확인.

## 구현 결과

Phase 1~4 완료. 실행 순서는 계획과 동일하되, Phase 1 이 기존 테스트가 고정하던
"명령 에코 보존" 계약을 의도적으로 바꾸므로 그 테스트를 새 계약으로 교체했다.

### AC1 실측 (Phase 5)

같은 `gh pr list` 를 파일 필드 유무로 나눠 측정했다.

| 저장소 | files 포함(기존) | files 제외(수정) |
|---|---|---|
| `buzzni/aplus-dev-studio` | 3,574ms / 183KB | **1,021ms / 38KB** |
| `buzzni/hsmoa_backend` | 6,483ms / 250KB | **983ms / 44KB** |

경로 필터가 없는 트리거의 쿼리 비용이 3.5~6.5배 줄었다. 504 가 나던
`aplus-dev-studio` 트리거가 이 경로를 탄다.

### 검증

- `daemon/automations` 18파일 **231건** 통과 (신규 13건)
- `pnpm --filter @buzzni/happy-cli run typecheck` 통과

## Phase 6 — 경로 필터 트리거의 지연 파일 조회 (AC9, AC10)

**Status: Done**

- `selectPathFilterCandidates` (순수 함수) 가 파일이 실제로 필요한 PR 번호를
  고른다. `planGithubTrigger` 와 동일한 판정 순서(processed → derivesEvent →
  경로 외 필터)를 쓰고, 경로 필터가 없거나 첫 관측이면 빈 배열이다.
- `queryGithubPullRequestFiles` 가 후보 PR 만 `gh pr view` 로 받고,
  `mergePullRequestFiles` 가 원본 목록에 채운다.
- executor 는 목록을 항상 가볍게 받고(`includeChangedFiles: false`) 후보가 있을
  때만 추가 조회한다.

### 실측 (buzzni/hsmoa_backend, 후보 2건 기준)

| 방식 | 소요 | 응답 |
|---|---|---|
| 기존 — 목록에 `files` 포함 | 3,545ms | 250KB |
| **신규 — 가벼운 목록 + 후보 2건** | **2,025ms** | **49KB** |

실제 폴링에서 후보는 보통 0~1건이라 대개 1초 안쪽이다. 후보가 0건이면 추가
조회 자체를 하지 않는다.

### 계약 변경

`.138` 의 "경로 필터가 있으면 목록에 `files` 를 포함한다" 테스트는 AC9 가
대체하므로 새 계약으로 갱신했다.

### 검증

- `daemon/automations` 19파일 **249건** 통과 (신규 11건)
- `typecheck` 통과 — `run.ts` 배선 누락을 여기서 잡았다
- 실제 `gh` 로 2단계 조회 실측 (위 표)
