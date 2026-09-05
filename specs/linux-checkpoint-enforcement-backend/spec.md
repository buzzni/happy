# 체크포인트 보호 — Linux daemon 머신 지원 Spec

> 작성일: 2026-09-05 / 상태: **승인됨** (v4, 2026-09-05. Codex gpt-6-astra medium 리뷰 2라운드 반영. MCP `bash_stream` 경계는 사용자 결정으로 **선택지 (1): 별도 스펙**, Linux는 macOS와 같은 기준으로 개방)
> ⚠️ 승인 후에는 사용자 지시 없이 수정 금지

## 목표

daemon이 관리하는 **Linux 머신**(원격 서버 또는 로컬 워크스테이션)에서 실행되는
Claude remote/Codex 세션에도 기존 macOS 전용 체크포인트 보호(`protected`, ADR-059)를
제공한다. **provider sandbox 안에서 실행되는 writer에 대한 원본 프로젝트 무오염 보장**은
macOS와 동일하게 유지하고, macOS와 달라지는 것은 "glob 전용 secret 경로의 차단 시점"뿐임을
테스트로 못 박는다. Desktop 앱 자체는 계속 macOS 전용(`build:mac`)이며 스코프 밖이다.

## 배경 — 코드 실측

| 지점 | 실측 |
|---|---|
| 게이트 | `checkpoint/checkpointExclusionPolicy.ts:47` `resolveCheckpointProtectionCapability` — `platform !== 'darwin'`이면 무조건 `unsupported-platform`. 호출부 `checkpointRuntime.ts:58`, `daemon/checkpointSessionAuthority.ts:48`(**RPC마다 재resolve**, `checkpointRpc.ts:117`) |
| OS 강제 경로 | `checkpointSessionComposition.ts:93-104` `sandboxConfigFor(workspacePath)` → `sandbox/config.ts#buildSandboxRuntimeConfig` → `@anthropic-ai/sandbox-runtime`(srt; macOS `sandbox-exec` / Linux `bubblewrap`). Happy 코드의 플랫폼 분기는 게이트 한 줄뿐 |
| 격리 workspace | provider는 turn별 workspace에서 실행. `customWritePaths=[workspace]`이나 실제 allowWrite에는 `extraWritePaths`·`~/.codex`·`~/.claude`·srt 기본 writable 경로도 포함(`config.ts:90`). 원본 경로는 allowWrite 밖이라 Linux에서는 `--ro-bind / /`로 read-only. secret before-image는 workspace에 복제되지 않음 |
| 매니페스트 | `buildCheckpointExclusionManifest`가 프로젝트 트리를 스캔(루트 `.git` 생략, ignored 디렉터리는 디렉터리 항목 하나로 기록)해 secret glob 매칭 **실재 파일을 리터럴 경로로 열거**. srt에는 리터럴 + glob 둘 다 넘김 |
| srt Linux literal deny | writable 영역의 **미존재 리터럴 deny 경로**도 leaf면 `/dev/null`, 중간 컴포넌트면 빈 ro 디렉터리를 bind해 생성까지 차단(`linux-sandbox-utils.js:525-572`). 예외: `/dev/*`, `hasFileAncestor`(git worktree의 `.git` 파일 등)면 생략. README의 "존재하는 파일만 차단"은 설치된 구현과 다르다 — **판단 기준은 dist 코드** |
| srt Linux glob deny | 말단 `/**`를 떼고도 glob 문자가 남는 `denyWrite` 항목은 Linux에서 확장 없이 생략(debug 로그만, `sandbox-manager.js:303-312`). `join(ws, '**/.env')` 류는 무효 |
| **srt Linux allowWrite (신규)** | **존재하지 않는 allowWrite 경로는 bind 없이 건너뛴다**(`linux-sandbox-utils.js:497-500`). macOS Seatbelt는 경로 문자열 기반이라 존재 여부 무관 |
| **Codex 시작 순서 (신규)** | `codexAppServerClient.ts:751` `connect`에서 `initializeSandbox` + `wrapForMcpTransport`로 bwrap 인자를 **먼저** 만들고, workspace 디렉터리는 그 뒤 `sendTurnAndWait`(:1551)의 `beforeTurn → prepare`에서 생성. 후속 턴도 `completeTurn → disconnectInternal → reconnect(connect)` 후 `beforeTurn`이라 같은 순서. → Linux에서는 **workspace가 writable bind에 안 들어가** 모든 쓰기가 실패할 것으로 예상 |
| apply 게이트 | `checkpointTurnApply.ts:326-332` `createExcludedPathMatcher`가 리터럴 `excludedPaths`와 glob `excludedPatterns`를 동적 매칭 → plan `reason: 'excluded-path'`, 실행 결과 `action/outcome: 'conflict'`, composition이 `reportPending(source: 'turn-apply')`. 단 신규 파일 후보는 `git ls-files --others --exclude-standard`(:278)라 **`.gitignore`로 제외된 신규 secret은 후보에 없음**(원본 미반영이지만 pending도 없음). 턴 중 생성 후 삭제된 파일도 최종 diff만 봄 |
| workspace 잔존 | apply `status`는 `failed` 항목이 있을 때만 `partial`, **conflict만 있으면 `completed`**(`checkpointTurnApply.ts:180`). composition은 pending 기록 후 `completed`면 workspace를 삭제(`checkpointSessionComposition.ts:217-226`). 즉 glob 전용 신규 secret 내용은 **턴 종료 시 삭제**되고, `partial`(mutation 실패)일 때만 frozen workspace가 남는다 |
| 의존성 프로브 | `SandboxManager.checkDependencies()`(공개 API) — Linux는 `bwrap`·`socat`·`rg` 부재를 error, seccomp 필터 부재를 warning. **warning이면 Unix socket 차단만 끄고 계속 실행**(`linux-sandbox-utils.js:684`). WSL1은 `isSupportedPlatform` 거부. `sandbox/dependencyPreflight.ts`가 daemon 기동 시 호출 선례이나 **프로브가 throw하면 true(사용 가능)로 fail-open**하고 `error.message`·errors 배열을 그대로 로그에 찍는다(`:30`) |
| 초기화 실패 fail-closed | Codex: `codexAppServerClient.ts:761` — 보호 모드(`beforeTurn` 존재)면 sandbox init 실패 시 throw. Claude: `claudeSandbox.failIfUnavailable: true`. 둘 다 이미 fail-closed |
| bwrap mount-point | 미존재 deny 경로용 0바이트 파일/빈 디렉터리를 호스트 workspace 안에 생성(`bwrapMountPoints`). **정상 Codex 턴은 `completeTurn → quiesce → disconnectInternal → sandboxCleanup → SandboxManager.reset → cleanupAfterCommand`가 freeze 전에 실행**(`codexAppServerClient.ts:1579-1586`, `:931`, `sandbox-manager.js:516`). 잔여물이 "정상적으로 매 턴 남는다"는 v2 주장은 **틀렸다**. 남을 수 있는 경우: cleanup 오류(삼킴), 빈 파일/빈 dir이 아닌 상태, 비정상 종료. `cleanupAfterCommand`는 srt 공개 namespace에 있음(`sandbox-manager.js:738`) |
| **Happy MCP `bash_stream` (신규, 플랫폼 공통)** | `startHappyServer.ts:140`이 `cwd=protectedBashCwd`, `detached`, writer 추적까지는 하지만 명령 자체는 **daemon 호스트에서 `spawn('bash', ['-c'])`로 sandbox 없이 실행**(`bashStream.ts:95`). 절대 경로나 passthrough symlink로 원본에 쓸 수 있다. **macOS에도 동일**하게 존재하는 ADR-059 경계 누락. 이 스펙의 범위 밖이지만 "원본 무오염" 주장의 조건이 된다 |
| Desktop 파서 | `src/domain/checkpointTimeline.ts:122` `parseProtectionState`가 `status==='protected' && Object.keys(protection).length === 1`을 요구 → **`protection` 객체 안의 additive 필드는 구버전 Desktop이 거부**. `UNAVAILABLE_REASONS`도 닫힌 집합. 반면 status DTO **최상위**의 미지 키는 검사하지 않아 무시된다(`:174-190`). 원격 daemon은 버전 미고정 `npm i -g @buzzni/happy-cli`(`machineSetupCommands.ts:4`)라 스큐 전제 |
| CI | `typecheck.yml`·`cli-smoke-test.yml`의 주 job은 `ubuntu-latest`(smoke에 windows job도 있음). `checkpointSandbox.integration.test.ts`는 `skipIf(platform !== 'darwin')`이고 **셸 write만** 검증(native Write/MCP/worker는 미검증) |

### 실제 격차

provider sandbox 안의 writer(Claude/Codex 본체, 그 안의 built-in shell)에 한해:

| 상황 | macOS | Linux |
|---|---|---|
| 열거된 제외 경로(secret·ignored·too-large 등, 턴 시작 시 존재) 수정·재생성 | OS write-time 차단 | OS write-time 차단 (`/dev/null`·빈 dir bind) |
| **열거되지 않은 경로**에 glob 매칭 secret 신규 생성 | OS write-time 차단 (Seatbelt regex) | workspace에 써짐 → apply-time `excluded-path` conflict로 원본 미반영 + pending decision (단 gitignore된 경로는 pending 없음) |
| workspace 디렉터리가 sandbox 인자 생성 시점에 없을 때 | 무관 | **allowWrite bind 누락 → 쓰기 전부 실패** (Codex 순서 문제) |
| seccomp 필터 부재 | 해당 없음 | Unix socket 차단만 해제, 파일시스템 보장은 동일 |

Linux의 잔여 위험: (a) glob 전용 신규 secret 내용이 daemon 소유 workspace(`checkpointRoot`, 0700)에 턴 종료(정상 apply 후 삭제)까지, `partial`이면 그 이후까지 존재, (b) provider가 중단되지 않고 성공한 줄 알고 턴을 이어감, (c) 재확인이 턴 끝에 옴. **secret 내용을 읽어 비제외 이름으로 쓰는 정보 흐름**은 원본 read가 양 플랫폼 모두 허용이라 플랫폼 공통 한계다(apply는 최종 경로만 본다).

## 요구사항

### R1. Linux + 지원 provider + srt 의존성 충족 시 `protected`를 허용한다

- `resolveCheckpointProtectionCapability`가 `platform === 'linux'`이고 provider가
  `claude-remote`/`codex`이면 `unsupported-platform`으로 즉시 거부하지 않는다. `win32`는 불변.

### R2. srt 의존성 부재는 기존 프로브를 재사용해 fail-closed 한다

- capability 판정에 `checkDependencies` 결과를 주입받아 `errors`가 있으면 `unavailable`.
  **프로브가 throw해도 `unavailable`**(기존 preflight의 fail-open을 따르지 않는다). 결과는
  daemon 프로세스 수명 동안 캐시한다(authority가 RPC마다 재resolve되므로).
- `warnings`(seccomp 부재)는 차단하지 않고 daemon 로그에 남긴다. 파일시스템 write 보장과는
  무관하지만 Unix socket 차단이 빠지므로 macOS와 완전히 같은 경계는 아니다 — 알려진 차이로
  문서화한다.
- reason 값은 **기존 `unsupported-platform`을 재사용**한다(R6 참조). 새 값은 Desktop 파서
  관용화가 배포·전파된 뒤에만 별도 스펙으로.
- unprivileged userns 비활성 등 spawn 시점 실패는 기존 fail-closed 경로에 맡긴다. Phase 0에서
  그 오류 메시지가 원인을 말하는지 확인하고, 아니면 메시지만 보강한다.

### R3. 매니페스트 사전 스캔·apply 게이트·workspace deny 목록은 변경하지 않는다

- `buildCheckpointExclusionManifest`, `createExcludedPathMatcher`, `sandboxConfigFor`의
  deny 항목 구성은 플랫폼 무관이며 그대로 둔다. v2의 R5-a(Linux에서 workspace 내부 deny
  항목 생략)는 **폐기** — secret뿐 아니라 ignored·용량 제한·passthrough의 write-time 차단까지
  낮추는 ADR-059 보장 축소였다.

### R4. Codex Linux는 workspace가 존재한 뒤에 bwrap 인자를 만들어야 한다 (신규)

- Given Linux Codex 보호 세션, When `connect`가 sandbox를 초기화하고 wrap할 때, Then 그
  턴의 workspace 디렉터리가 이미 존재해 allowWrite bind에 포함된다. 최초 턴과 rotate 후
  후속 턴 모두.
- 구현 방식(Phase 0에서 택일): (a) `rotateProviderPath`/composition 생성 시 workspace
  디렉터리를 미리 만들고 `prepare`의 `mkdir(recursive: false)`(`checkpointTurnWorkspace.ts:86`)를
  기존 빈 디렉터리 허용으로 바꿈 — composition + turnWorkspace 두 파일 수정, (b) Codex
  `connect`를 `beforeTurn` 뒤로 옮김 — client 한 파일 수정. macOS 동작을 바꾸지 않는 쪽을 택한다.
- Phase 0 Linux 테스트는 운영과 같은 **wrap → beforeTurn 순서**를 보존해야 이 결함이 잡힌다
  (기존 macOS 테스트 `checkpointSandbox.integration.test.ts:113`이 같은 순서).

### R5. glob 전용 secret 신규 생성은 apply-time에 차단된다 (실행 가능한 계약)

- Given Linux protected 턴, When provider가 매니페스트에 없고 gitignore되지 않은 경로에
  `secretPatterns` 매칭 파일을 새로 만들면, Then 원본에 반영되지 않고 plan은
  `reason: 'excluded-path'`, 실행 결과는 `action/outcome: 'conflict'`, composition은
  `pendingDecision.source: 'turn-apply'`를 기록한 뒤 (`failed` 항목이 없으면 `completed`로)
  workspace를 삭제한다.
- gitignore된 신규 secret과 턴 중 생성 후 삭제된 파일은 원본 미반영은 같지만 pending을
  보장하지 않는다 — 이를 spec의 알려진 한계로 명시한다(macOS는 OS 차단이라 해당 없음).
- 이 요구는 `checkpointSandbox.integration.test.ts`의 Linux 쌍둥이 테스트로 표현한다.
  macOS가 `ENOENT`를 기대하는 자리에서 Linux는 "workspace에는 있고 apply 결과는 conflict"를
  기대한다.

### R6. 공개 계약은 바꾸지 않는다 (호환성 강제)

- Desktop 파서가 `protection` 객체의 키 개수와 reason enum을 닫힌 집합으로 검사하고, 원격
  daemon은 버전 미고정 설치라 daemon-first 배포에서 **그 두 곳의 additive 변경은 구버전
  Desktop을 깬다**. status DTO 최상위 키 추가는 현재 파서가 무시하므로 기술적으로는 가능하나,
  v1에서 그것으로 표현할 사용자 가시 차이가 없어 하지 않는다. 즉 v1은 `protection`·reason
  enum·event envelope·최상위 DTO를 모두 바꾸지 않는다.
- 사용자 가시 차이("pending이 턴 끝에 온다")는 기존 `pendingDecision.source: 'turn-apply'`로
  표현된다. Linux 전용 UI 신호가 필요하다고 판단되면 Desktop 파서 관용화 → 전파 → daemon
  변경 순의 별도 스펙으로 한다.

### R7. bwrap mount-point 잔여물이 정상 경로에서 판정에 섞이지 않음을 검증한다

- Given Linux protected Codex 턴, When 정상 `completeTurn`이 끝나면, Then freeze 전에
  cleanup이 실행돼 apply의 changed paths에 mount-point 경로가 없고 fingerprint 3회 시도가
  성공한다 — **현재 코드 순서상 성립할 것으로 예상, Phase 0에서 확인만**.
- cleanup 오류(삼킴)·비정상 종료·writer 종료 경합에서 잔여물이 남는 경우는 관찰 결과를
  기록하되, 추가 cleanup 호출은 **재현 근거가 있을 때만** 도입한다.

### R8. read-only passthrough가 Linux bwrap에서 유지된다

- Given workspace 안의 passthrough symlink(→ 원본의 ignored 디렉터리), When provider가
  그 경로를 읽고 쓰려 하면, Then 읽기는 성공하고 쓰기는 실패한다. 또한 provider가 symlink를
  지우고 같은 이름의 실제 디렉터리를 만들어도 원본 ignored 디렉터리는 불변이고 apply는 그
  경로를 `excluded-path`로 처리한다. 실제 bwrap 실행으로만 확인 가능(UNCERTAIN) — Phase 0 케이스.
- `extraWritePaths`나 `workspaceRoot`가 원본 프로젝트를 포함하더라도 `canonicalProjectPath`
  리터럴 deny(존재하는 경로 → `--ro-bind` 자기 자신)로 원본이 계속 read-only인지 Phase 0에서
  경로 중첩 케이스로 확인한다.

### R9. observability는 기존 형식을 재사용한다

- `[checkpoint-operation]` v1은 snapshot·plan·restore·GC만 다루므로 Linux capability 프로브
  실패는 새 operation을 만들지 않는다. daemon 로그에는 부재한 바이너리 **이름만**(`bwrap`,
  `socat`, `rg`) 남기고 srt가 돌려준 원문 메시지는 찍지 않는다 — 기존 `dependencyPreflight`는
  `error.message`를 그대로 출력하므로 그 함수를 그대로 재사용하지 않고 `checkDependencies`
  결과만 받아 정제한다. 경로·파일명·오류 원문 금지 원칙은 `[checkpoint-operation]` 레코드와
  이 로그 양쪽에 적용한다.

## 비목표 (Non-Goals)

- **glob 전용 secret 신규 생성의 write-time OS 차단** — srt Linux 백엔드 한계. v1에서 Landlock
  자체 구현·업스트림 기여를 하지 않는다(별도 스펙 후보).
- **Happy MCP `bash_stream`의 호스트 실행 경계** — macOS에도 있는 플랫폼 공통 누락. Linux를
  열어도 이 위험은 **늘지 않는다**(동일). **단, 사용자 결정 필요**: Codex 리뷰는 이 구멍을
  닫기 전에는 어느 플랫폼에도 `protected`를 광고하면 안 된다(ADR-059 line 15)고 본다.
  선택지는 (1) 이 스펙과 무관하게 별도 스펙으로 먼저/병행 처리하고 Linux는 macOS와 같은
  기준으로 개방, (2) MCP 경계 수정을 이 스펙의 선행 Phase로 편입. **→ 2026-09-05 사용자
  결정: (1).** MCP 경계는 별도 스펙(context.md 발견된 문제)으로 남긴다.
- **Windows** — ADR-059 그대로.
- **공개 계약·Desktop UI 변경** — R6.
- **srt 자체 개선**, **일반(비보호) 세션 sandbox의 Linux 동작 변경**.
- **Claude native Write/Edit·worker의 tool별 enforcement를 코드 수준으로 증명** — SDK/Claude
  Code 내부. 대신 macOS가 `protected`를 광고할 때 쓴 것과 같은 기준, 즉 **실제 provider
  file-edit smoke**(`checkpointProvider.integration.test.ts`)를 Linux에서 통과시키는 것을
  Linux 광고의 필수 조건(DoD)으로 삼는다. "가능할 때"가 아니라 필수다.

## 제약

- 성능: capability 프로브는 daemon 수명당 1회 캐시. 턴마다 재프로브 금지.
- 호환성: 공개 계약 불변(R6). 원격 daemon ↔ Desktop 버전 스큐 전제.
- 보안: provider sandbox 안 writer의 원본 무오염은 macOS와 동일. "protected"가 실제보다
  과장되지 않도록 R5의 시점 차이와 gitignore 예외를 문서·테스트에 드러낸다.

## 완료 기준 (Definition of Done)

- [ ] R1~R9 대응 테스트 통과 — R4·R5·R7·R8은 실제 bwrap(Ubuntu 컨테이너 또는 CI ubuntu job)
- [ ] Claude/Codex **provider smoke**(`checkpointProvider.integration.test.ts`)가 Linux에서
      실제 계정으로 통과 — 셸 write만으로는 native/worker 경로를 증명하지 못하므로 **필수**.
      계정·환경 때문에 못 돌면 Linux `protected` 광고를 하지 않는다(ADR-059 line 15)
- [ ] `checkpointExclusionPolicy.test.ts` 플랫폼 매트릭스(darwin / linux-ok / linux-missing-dep / win32) 통과
- [ ] `tsc --noEmit` 통과
- [ ] R4 순서 변경이 macOS integration 테스트를 깨지 않음
- [ ] Desktop ADR-059 line 37/59 갱신과 MCP `bash_stream` 경계 누락을 후속 항목으로 기록
