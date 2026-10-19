# context — daemon-handoff-confirm-startup

## 2026-10-19 후속: 온라인 소유 daemon이 띄운 자식의 중복 health 확인

진행 중. 사용자 권한은 수정·관련 검증·main 반영이며 새 Windows Trial 빌드/설치 검증은
이번 범위에서 제외했다. Desktop 설치판의 .342를 직접 바꾸거나, 공개 CLI release/tag를
발행한 것으로 간주하지 않는다. 공개 릴리스는 AGENTS.md의 즉시 승인 지점에 따른다.

- 분류: 기존 Core 프로세스 수명주기 수정. 새 공개 API·환경변수·저장 스키마·권한은 추가하지 않는다.
- 범위: ensureDaemonRunning.ts/test, cli-architecture.md, 이 context의 기존4파일.
- 동작: 같은 CLI 버전의 running/online daemon이 OS 부모이고 lock owner/생존 확인이
  일치하며 control port/credential도 준비돼 있으면 중복 HTTP ping을 생략한다.
- 보호: 플래그/온라인 표시만으로 생략하지 않는다. terminal·다른 부모·죽은/중지/오프라인
  부모·버전/lock 불일치는 기존 확인·자동 시작을 유지한다. session report 인증은 그대로다.
- 근거: Windows Trial58의 live PID16112에서 health 확인 예외로 새 Chat PID616이
  provider/webhook 전 종료했다. 같은 PC의 Node fetch2초 timeout을 재현했고 후속은 정상.
  실제 실패의 세부HTTP 원인은 공통 오류에서 버려지므로 timeout으로 확정하지 않는다.
- TDD: 변경 전18건 중 정당한 부모 자식이 HTTP health 예외로 중단되는1건 실패/17건 통과.
  수정 후 직접 소비자5파일65건 PASS, global setup의 CLI 타입 검사·빌드 PASS.
- 실제 Mac 프로세스: Vitest mock이 없는 새 Node 자식에서 production ensure와 session-started
  보고를 실행했다. OS 부모 PID와 lock owner가 맞으면 응답하지 않는 /list를 호출하지 않고
  인증된 보고를 전달한다. lock owner 불일치에서는 실제2초 health timeout으로 차단하며
  보고0건/state와 lock 원문 보존을 확인했다. 현재 사용자의 daemon/계정에는 접근하지 않았다.
- 배포물 검증: prepare-publish-package와 guard-publish-artifact --install-smoke PASS.
  로컬 검증은 npm11.12.1 및 격리된 npm cache/prefix를 사용했다. 공개 publish/tag,
  설치판 runtime 교체 및 수정판 Windows 수락은 하지 않았다.
- 의존성: worktree root node_modules는 원래 저장소에 symlink. 최신 wire 타입만 이
  worktree에서 빌드/연결해 다른 worktree의 공용 캐시와 생성물을 덮어쓰지 않았다.
- 경계: 다른 사용자 자격의 staged home에 lock이 없거나 중간 launcher가 있으면 기존
  health 검사로 돌아간다. 이 수정으로 모든 원격/격리 spawn의 지연을 해결했다고 하지 않는다.
- 복구: 이4파일 변경을 revert한다. 자격증명/state/lock migration은 없다.

## 기존 작업 완료 이력
Phase 1~5 완료. 브랜치 `fix/handoff-confirm-daemon-started`, base `origin/main@f84be7bd`.

## 변경 파일

| 파일 | 성격 | 내용 |
|---|---|---|
| `src/utils/spawnHappyCLI.ts` | 동작 | `startDetachedHappyCLI` 신설, `captureSpawnOutputStdio` 공용화 |
| `src/utils/spawnHappyCLI.test.ts` | 테스트 | 재현 + 계약 테스트 7건 추가 |
| `src/daemon/run.ts` | 동작 | handoff 가 종료 코드로 확인, 지역 헬퍼 제거 |
| `src/main.ts` | 동작 | `start-sync` 출력 캡처 |
| `src/daemon/ensureDaemonRunning.ts` | 동작 | `start-sync` 출력 캡처 |
| `src/daemon/ensureDaemonRunning.test.ts` | 테스트 | 부분 mock 에 새 export 추가 |

## 이번에 밟은 함정

`vi.mock('@/utils/spawnHappyCLI', () => ({...}))` 는 모듈 전체를 대체하므로,
소비자가 새로 쓰기 시작한 export 를 나열하지 않으면 **런타임에서 터진다.**
새 export 를 모듈에 추가할 때는 그 모듈을 부분 mock 하는 테스트를 반드시 함께
확인할 것. 이번에도 전체 스위트 대조를 안 했으면 놓쳤다.

## 검증 기준선 (이 환경)
`origin/main` detached 워크트리와 1:1 대조.
- tsc: 4 errors (기준선과 동일, 전부 `@slopus/happy-wire` 사전 존재)
- unit: 38 failed / 2216 passed — 실패 목록 완전 동일

## 남은 것 / 후속 판단거리
- `start-sync` 사망 원인 미규명. R4 가 다음 재발 때 `daemon-start-sync.log` 에
  증거를 남긴다. 그 로그가 쌓이면 5초 예산이나 번들 디바운스를 판단할 근거가 생긴다.
- 번들 재설치 빈도(개발 워크트리의 반복 `cli:install`)는 그대로다. 이 handoff
  경로를 계속 반복해서 밟게 만드는 근본 동인이다.
