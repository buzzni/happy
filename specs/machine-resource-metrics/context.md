# context — machine-resource-metrics

> 마지막 갱신: 2026-09-20 / 상태: daemon 구현 완료, 검증 제한을 명시한 초안 PR 준비

## 현재 상태

`packages/happy-cli` 안의 daemon sampler·RPC·shutdown 정리와 malformed OS 입력
검증, 실패 시 stale cache 은닉이 구현되고 지정 단위 테스트를 통과했다.
Desktop(`aplus-dev-studio-desktop`)의 coordinator/store/UI도 별도 worktree에서 구현·리뷰됐다.
사용자가 커밋·PR을 요청하여 사용자 기존 변경과 분리된 `central-machine-metrics` worktree에서
이 기능의 변경만 커밋 대상으로 준비했다. 패키지 발행·runtime pin 변경·배포는 포함하지 않는다.

## 변경 파일

| 파일 | 성격 | 내용 |
|---|---|---|
| `src/daemon/machineResourceSampler.ts` | 신규 | `os.cpus()` 누적시간 delta·메모리·loadavg. probe 주입 |
| `src/daemon/machineResourceSampler.test.ts` | 신규 | 측정 규칙·숫자 validation·실패 후 baseline 회복 |
| `src/daemon/machineResourceService.ts` | 신규 | lease 원장·단일 timer·wire v1 요청 처리 |
| `src/daemon/machineResourceService.test.ts` | 신규 | 수명·race·상한·검증·실패/stale·snapshot identity |
| `src/api/apiMachine.ts` | 동작 | 서비스 필드 1개, RPC 등록 1건, `shutdown()` 정리 1줄, import |

## 판단 근거

- **서버 무변경이 가능한 이유**: `rpc-register` 는 메서드 이름을 검증하지 않고
  `rpc:{userId}:{machineId}:{method}` 방으로만 라우팅하며, `rpc-call` 은
  params/result 를 열지 않는다. 새 메서드는 daemon 과 클라이언트만의 계약이다.
- **push 를 쓰지 않은 이유**: ephemeral 이벤트 타입이 happy-server 의 닫힌 union
  이라 새 타입은 서버 변경이다. poll 로도 "요청은 측정을 유발하지 않는다" 는
  목적은 그대로 달성된다.
- **`sampledAt` 만 wall clock 인 이유**: 클라이언트가 렌더하므로 wall clock 이어야
  하지만, 같은 시계로 lease 만료를 판정하면 NTP 보정 한 번에 버려진 sampler 가
  영구히 돈다. 만료는 monotonic clock 으로 판정한다.
- **timer 시작 조건이 `timer === null` 인 이유**: 아래 "발견한 결함" 참조.

## 구현 중 발견하고 고친 결함

1. **interval 유실** — 시작 조건을 "구독 표가 비었는가" 로 두면, 마지막 lease 가
   만료된 뒤 tick 이전에 도착한 `read` 가 두 번째 interval 을 만들고 첫 번째
   handle 을 덮어쓴다. 유실된 interval 은 아무도 멈출 수 없어 영구 측정이 된다.
   → sweep 이 비었을 때 즉시 정지하고, 시작은 `timer === null` 로 판정.
2. **wall clock 만료** — 시계 역행 시 lease 가 만료되지 않는다. → monotonic 분리.
3. **release 추월** — `release` 가 자기 `read` 보다 먼저 도착하면 tombstone 이
   남지 않아 그 `read` 가 구독을 되살린다. → lease 보유 여부와 무관하게 tombstone.
4. **shutdown 이후 재시작** — `stop()` 후 요청이 sampler 를 되살릴 수 있었다.
   → terminal 플래그.
5. **잘못된 OS 숫자와 stale cache** — CPU/memory의 NaN·음수·누락 필드가 정상
   snapshot으로 publish될 수 있었고, 후속 측정 실패가 이전 cache를 `ok`로 계속
   노출했다. → 필수 읽기 invalid 시 null/reset, 최신 시도 실패 시
   `sample-unavailable`/`snapshot:null`.

이 넷은 모두 회귀 테스트로 고정했고, 1·3 은 변이(guard 제거)로 실제 실패를 확인했다.

## 검증

이 환경(`/Users/justin/workspace/happy`, `main`)에서 실행:

- `corepack pnpm --filter @buzzni/happy-cli exec vitest run --project unit src/daemon/machineResourceSampler.test.ts src/daemon/machineResourceService.test.ts`
  — 보강 후 41 passed.
- `corepack pnpm --filter @buzzni/happy-cli exec tsc --noEmit` — 통과.
- `./node_modules/.bin/vitest run --project unit src/api src/daemon`
  — 172 files, 3009 passed / 22 skipped, 실패 0.
- PR 준비용 독립 worktree에서 CLI tsc 통과. 전체 unit은 434 files passed / 27 failed /
  4 skipped, 6925 tests passed / 263 failed / 26 skipped였다. 변경 대상 sampler 19,
  service 22, apiMachine 39 tests는 모두 통과했다. 실패에는 `/private/tmp`의 쓰기 권한을
  거부하는 launcher 보안 검사, checkpoint 저장소의 누락된 info/exclude, 외부 바이너리·
  프로세스 시작 시각 조회가 포함된다. 전체 통과로 표시하지 않는다.

## 미검증 — 다음 세션이 알아야 할 것

- 부모가 실제 macOS OS API로 10초 delta 및 두 구독의 동일 snapshot, 마지막 release를
  확인했다. 설치 daemon의 server socket E2E는 미검증이며 daemon 재시작·설치 runtime
  갱신은 범위 밖이다.
- **Windows 미검증.** `loadAverage: null` 경로는 `process.platform` 분기로만 확인했다.
- 실제 RpcHandlerManager의 legacy/dataKey read/release와 managed allowlist 거절은
  in-process로 확인했다. 배포된 managed runtime E2E는 미검증이다.
- 통합·e2e 테스트(`test:integration`)는 실행하지 않았다.

## 다음 시작점

### PR 후속 검증 (2026-09-20)

- 최신 main(`420f1273`)을 병합하고 ApiMachineClient의 두 import를 모두 보존해 충돌을 해결했다.
- 격리 worktree의 최신 happy-wire를 빌드해 사용했다. CLI 빌드(typecheck 포함)와 자원 수집 관련 80 tests가 통과했다.
- 번들 도구 unpack, 신뢰 가능한 테스트 임시 경로, 최소 Git template을 준비한 전체 unit 재검증: 460 files / 7388 tests passed, 6 files / 23 tests failed, 26 tests skipped.
- 남은 실패는 managed boot/supervisor 소켓, npm cache 접근, setuid 모드, 프로세스 조회 경계에서 관측됐다. 전체 통과로 표시하지 않는다. 로그: `/tmp/swift-finch-happy-recheck.log`.
- 짧은 테스트 임시 경로와 전용 npm cache로 실패한 3 suites를 재실행해 146 passed / 1 skipped를 확인했다. 소켓 경로와 cache 접근으로 발생했던 19개 실패가 해소됐다. 미해결은 setuid 모드 1개와 프로세스 조회 3개이며 전체 suite를 재반복한 결과는 아니다. 로그: `/tmp/swift-finch-happy-env-recheck.log`.

정상 실행 환경에서 전체 실패를 재검증한 뒤 이 PR과 Desktop 연동 PR을 함께 검토한다.
wire 계약은 spec.md가 원본이며 status enum은 6종이다. 제품 적용에는 별도 승인된 CLI
릴리스 후 Desktop runtime pin 갱신이 필요하다.

## 주의 — 이 저장소의 기존 미커밋 변경

`packages/happy-cli/src/claude/claudeRemoteLauncher.ts`(수정)와
`claudeRemoteLauncher.test.ts`(untracked)는 **사용자의 별개 작업**이다.
이번 작업과 무관하며 건드리지 않았다. 커밋 시 함께 스테이징하지 말 것.
