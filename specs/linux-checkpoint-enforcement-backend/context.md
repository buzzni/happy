# 진행 상태

> 갱신: 2026-09-05 / 상태: 구현 완료 · provider smoke(실머신) 대기 / 브랜치 `feat/linux-checkpoint-protection` (worktree `.aplus/worktrees/linux-checkpoint-protection`, 커밋 6개, push·PR 미실행)

## 현재 상태

Phase 0~4 완료. 커밋 6개: R4 `reserve()`(d63f5e89) → 게이트+프로브(136ed6f3) → Linux integration
테스트+컨테이너 하네스(38b53564) → 문서·ADR(b586ca55) → **R8 필터**(f3c16a99, 사용자 승인) → 문서.
최종 검증: Linux 컨테이너(실제 게이트·프로브, 커밋된 하네스 스크립트) 5/5, macOS integration 3/3,
checkpoint+sandbox 단위 182/182, tsc 0. 남은 것은 (1) provider smoke를 실제 Linux 머신+계정으로 —
통과 전 실사용 광고 금지, (2) push/PR(사용자 지시 대기), (3) Desktop ADR-059 갱신, (4) MCP
`bash_stream` 별도 스펙.

## 핵심 결정 로그 (최신이 위)

- [2026-09-05] 결정(사용자 승인): Linux에서 srt deny 목록의 glob 항목·passthrough symlink 항목만
  제외(R3 개정) / 이유: glob은 미강제+잔여물, symlink는 bwrap 기동 실패, 대상은 `/` ro-bind로
  이미 read-only / 실측: Linux R8 통과(읽기 OK·쓰기 거부·symlink 교체 시 원본 불변·`**` 없음)

- [2026-09-05] 결정(최종): R4는 (a) `reserve()`와 (b) 순서 변경을 **둘 다** 한다 —
  `CheckpointTurnWorkspace.reserve()`로 경로를 빈 dir로 예약하고, `prepareProtectedTurn()`이
  실행 중인 codex를 끊고 **종료를 확인한 뒤** gate를 돌리고 그 다음 wrap·spawn 한다 /
  이유: (a)만으로는 부족했다. 살아 있는 bwrap이 예약 dir에 만든 mount-point는 EBUSY로 지울 수
  없어 `prepare()`가 "not empty"로 실패했다(Ubuntu 22.04 실측) / 처음엔 (b)를 "재접속 흐름을
  건드려 위험"으로 기각했으나 실측이 그 판단을 뒤집었다. 보호 턴은 이미 매번
  disconnect→reconnect 하므로 그 경로를 재사용하는 작은 변경이었다 (커밋 `c3a3c931`)
- [2026-09-05] 결정: CI job 추가 대신 컨테이너 스크립트 커밋 / 이유: happy 저장소 CI는 happy-cli
  vitest를 아예 돌리지 않아(unit도) integration job 하나를 새로 세우는 건 이 스펙 범위 밖
- [2026-09-05] 결정: `unsupported-platform` 재사용, 프로브 결과 로그는 바이너리 이름만 / 이유: spec R2·R9

- [2026-09-05] 결정(사용자): MCP `bash_stream` 호스트 실행 경계는 별도 스펙으로 두고 Linux는
  macOS와 같은 기준으로 개방 / 이유: 플랫폼 공통 누락이라 Linux 개방이 위험을 늘리지 않음 /
  기각: 이 스펙의 선행 Phase로 편입(Codex 권고)

- [2026-09-05] 결정: R5-a(Linux에서 workspace deny 생략) 폐기 / 이유: deny 목록에 secret뿐
  아니라 ignored·용량 제한·passthrough가 들어 있어 write-time 차단을 통째로 잃는 ADR-059
  보장 축소. mount-point 잔여물 전제도 틀렸음(아래) / 출처: Codex 리뷰 #4, 코드 재확인
- [2026-09-05] 결정: 공개 계약 불변을 "기본"이 아니라 "강제"로 / 이유: Desktop
  `parseProtectionState`가 `protected` 객체 키 개수 1을 요구해 additive 필드도 구버전을
  깨고, 원격 daemon은 `npm i -g` 버전 미고정 / 출처: Codex #9, `checkpointTimeline.ts:122` 확인
- [2026-09-05] 결정: R4(Codex workspace 생성 순서)를 신규 요구로 추가하고 Phase 1로 / 이유:
  Linux srt는 미존재 allowWrite를 bind하지 않는데 Codex는 connect에서 wrap 후 beforeTurn에서
  workspace를 만든다 / 출처: Codex #2, `linux-sandbox-utils.js:497`·`codexAppServerClient.ts:751,1551` 확인

- [2026-09-05] 결정: Phase 순서를 "실기 스파이크 → 계약 → 구현"으로 뒤집음 / 이유:
  glob 전용 secret의 apply-time 차단과 bwrap mount-point 오염은 문서로 판단 불가,
  실제 bwrap 실행만이 답 / 기각: v1의 "설계·ADR 먼저" 순서
- [2026-09-05] 결정: 공개 계약(`protection.status`)은 기본 변경 없음(R6) / 이유:
  원본 보호 보장이 macOS와 동일하고 사용자 가시 차이는 `pendingDecision.source:
  'turn-apply'`로 이미 표현됨 / 재검토: Phase 0에서 그 외 가시 차이가 발견되면
- [2026-09-05] 결정: Linux에서 workspace 내부 deny 항목을 srt에 넘기지 않는 R5-a를
  기본안으로 / 이유: mount-point 잔여물 자체를 안 만들고 apply 게이트가 이미 같은
  경로를 막음 / 기각 후보: freeze 직전 srt cleanup 호출(R5-b, 타이밍 의존)
- [2026-09-05] 결정: 이 기능의 "Linux"는 daemon이 붙는 원격/로컬 머신 / 이유: Desktop은
  macOS 전용 배포, ADR-059의 "macOS Claude remote/Codex"는 provider 실행 머신을 가리킴
- [2026-09-05] 결정: Landlock 자체 구현·srt 업스트림 기여는 별도 스펙 / 이유: 원본
  보호가 apply-time 게이트로 성립해 v1 가치 대비 과잉

## Phase 0 실측 (Ubuntu 22.04.5 arm64, Docker `--privileged`, bwrap 0.6.1, srt 0.0.37)

컨테이너: `happy-linux-spike:ubuntu22`(nodesource node 22 + bubblewrap/socat/ripgrep/python3),
worktree를 `/src:ro`로 마운트해 `/work`에 복사 후 `pnpm install`. 테스트는
`packages/happy-cli/src/checkpoint/checkpointSandbox.linux.integration.test.ts`를
`vitest.linux-spike.config.ts`(globalSetup 없음, 미커밋)로 실행. 게이트 우회는 테스트에서
`platform: 'darwin'` 주입.

| # | 케이스 | 결과 (2026-09-05, 4차 실행 기준) |
|---|---|---|
| 0 | `SandboxManager.checkDependencies()` | `{errors:[],warnings:[]}` — arm64 seccomp 필터 vendored, userns OK(privileged) |
| 1 | R4 운영 순서(wrap → beforeTurn) 일반 쓰기 | 🔴 실패 재현(`Read-only file system`, srt 로그 `Skipping non-existent write path: WS`) → Phase 1 `reserve()` 후 **✅ Green**(6차 실행, 실제 게이트+프로브) |
| 2 | R3 열거된 제외(`large.bin`) 재생성 / 원본 절대경로 쓰기 | ✅ 둘 다 거부 (`--ro-bind /dev/null WS/large.bin`, 원본은 `/` ro-bind) |
| 3 | R5 glob 전용 신규 secret `nested/.env.future` | ✅ **workspace에 써짐** → completeTurn `status: completed`, entries `[nested/.env.future conflict, source.txt written]`, 원본에 없음, `pendingDecision.source: 'turn-apply'` + `excluded [{nested/.env.future, secret}]`, workspace 삭제됨. gitignore된 `ignored-secrets/.env.x`는 entries·pending 없이 원본 미반영 |
| 4 | R7 정상 cleanup(=Codex disconnect 순서) 후 잔여물 | ✅ entries에 mount-point 없음, fingerprint 성공 |
| 4b | R7 비정상(cleanup 생략) | ⚠️ workspace에 `**`, `.env`, `dependencies`, `large.bin` 0바이트 mount-point 잔존 → apply가 전부 `excluded-path` conflict로 보고(가짜 pending). cleanup이 빠지면 매 턴 오탐 확정 |
| 5a | R8 passthrough symlink (현재 코드 그대로) | **bwrap 기동 실패**: srt `findSymlinkInPath`(linux-sandbox-utils.js:21)가 allowWrite 안의 symlink deny 경로에 `--ro-bind /dev/null <symlink>`를 넣고 bwrap이 `Can't create file at .../dependencies`로 죽음. **readOnlyPassthroughPaths가 하나라도 있으면 Linux protected 턴이 시작조차 못 함**(fail-closed) |
| 5b | R8b 제안 필터(Linux에서 passthrough symlink 항목 + glob 항목을 deny에서 제외) | ✅ passthrough 읽기 OK, `package.txt`·`new.txt` 쓰기 거부(대상이 `/` ro-bind), `large.bin` 여전히 거부, `**` 잔여물 없음. agent가 symlink를 지우고 실제 dir로 교체하는 것은 **성공**(REPLACED)하지만 apply entries `[]`, 원본 `dependencies/` 불변 |
| 5c | R8c `extraWritePaths=[project]` 중첩 | ✅ 원본 절대경로 쓰기·신규 파일 생성 거부 |
| 6 | R2 의존성 제거/userns 비활성 | 미실행 (Phase 2 unit 매트릭스로 대체, spawn 실패 메시지는 실머신에서) |
| 7 | provider smoke | 미실행 — 컨테이너에 Claude/Codex 계정 없음. **Linux 광고 전 필수**(DoD) |

추가 발견:
- srt wrap 경로(`sandbox-manager.js:400`)는 `denyWrite`를 **glob 필터 없이** 그대로 쓴다(필터는
  `getFsWriteConfig`에만 있음). 그래서 `join(ws, '**/.env*')`가 실행마다 다르게 `ws/**` 빈 dir,
  `ws/.env` 0바이트, 또는 `ws/**/.env*` mount-point를 만든다(SRT_DEBUG 로그로 확인). spec 표의
  "glob은 생략된다"는 wrap 경로에는 틀림 — **Linux에서 glob 항목은 무효이면서 잔여물을 남긴다**.
  (부수 효과로 workspace 루트의 리터럴 `.env`만 우연히 차단됨.)
- 결론(Phase 1·3 입력): Linux에서 srt에 넘기는 workspace deny 목록에서 **(i) glob 항목, (ii)
  passthrough symlink 항목**만 제외해야 한다. (i)는 원래 무효, (ii)는 대상이 `/` ro-bind로 이미
  read-only. 그 외 열거된 리터럴 deny(secret·too-large·ignored 파일)는 그대로 유지 — v2의 R5-a
  (전부 제거)와 다르다. **spec R3 문구("deny 목록 불변")와 충돌하므로 사용자 승인 필요.**
- `npx tsc`가 worktree에서 typescript가 아닌 squatter 패키지("This is not the tsc command you are
  looking for")를 실행해 종료코드 0으로 통과한 척했다. `./node_modules/.bin/tsc`를 쓸 것.

## 시도했으나 실패한 접근 ⚠️

- **v3의 "conflict면 workspace가 사용자 결정까지 남는다"** → 틀림. `status`는 `failed`가
  있을 때만 `partial`(`checkpointTurnApply.ts:180`), conflict만 있으면 `completed`라
  pending 기록 후 workspace 삭제(`checkpointSessionComposition.ts:217-226`).
- **v3의 "어떤 additive 변경도 구버전 Desktop을 깬다"** → 과장. `protection` 객체 내부와
  reason enum만 닫혀 있고 status DTO 최상위 키는 무시됨(`checkpointTimeline.ts:174-190`).

- **v2의 전제 "Codex는 mount-point 잔여물이 프로세스 수명 내내 남아 freeze/apply를
  오염시킨다"** → 틀림. 정상 completeTurn은 quiesce → disconnectInternal → sandboxCleanup →
  reset → cleanupAfterCommand를 **freeze 전에** 실행한다(`codexAppServerClient.ts:1579-1586,
  931`). 잔여물은 cleanup 실패·비정상 종료에서만 가능. R7은 "확인" 항목으로 격하.

- **v1 계획의 전제 "srt Linux는 존재하는 파일만 차단"** → 틀림. srt
  `linux-sandbox-utils.js:525-572`는 미존재 리터럴 경로에 `/dev/null`/빈 dir을 bind해
  생성까지 막는다. README의 해당 문장은 srt 내장 mandatory deny 목록 한정. 사용자
  `denyWrite`에서 Linux가 못 하는 건 **glob**뿐(`sandbox-manager.js:303-312`에서 skip).
- **v1 계획의 전제 "Linux는 새 secret 파일이 원본에 들어갈 수 있다"** → 틀림.
  `checkpointTurnApply.ts#createExcludedPathMatcher`가 glob을 동적으로 매칭해
  `excluded-path` conflict로 막는다. 차이는 차단 시점(write-time vs apply-time)뿐.

## 발견된 문제 / 열린 질문

- **[플랫폼 공통, 범위 밖] Happy MCP `bash_stream`이 호스트에서 sandbox 없이 실행됨**:
  `startHappyServer.ts:140`은 cwd·detached·writer 추적만 하고 `bashStream.ts:95`는
  `spawn('bash', ['-c'])`. 절대 경로/passthrough symlink로 원본에 쓸 수 있다. ADR-059의
  "모든 writer의 writable cwd 고정 + 원본 write-deny"가 MCP 셸에는 OS 수준으로 적용되지
  않는다. macOS도 동일. **별도 스펙 필요** — Linux 개방이 이 위험을 늘리지는 않는다.
- Codex 리뷰 중 코드로 재확인하지 않고 받아들인 항목: #7(passthrough symlink under
  bwrap, UNCERTAIN → R8), #8(Claude native tool enforcement, UNCERTAIN → 비목표+smoke),
  #11(allowWrite 구성·manifest 스캔 세부, 표에 반영), #13(observability v1 범위 → R9).

- bwrap mount-point 잔여물: 정상 경로는 freeze 전 cleanup 확인(위). 비정상 경로만 Phase 0 관찰.
- **[범위 밖] `SandboxConfig` 기본 `denyWritePaths`의 상대 경로 `.env`**가 `resolvePaths`로 sessionPath
  (=workspace) 기준 `WS/.env`가 되어, Linux에서 srt가 workspace 루트에 0바이트 `.env` mount-point를
  만든다(SRT_DEBUG 실측, R8 필터와 무관). 정상 cleanup 뒤 사라지지만 일반(비보호) Codex sandbox에서는
  프로젝트 cwd에 프로세스 수명 동안 ghost `.env`가 생긴다 — 체크포인트가 아닌 일반 sandbox 이슈.
- Desktop `src/domain/checkpointTimeline.ts` `UNAVAILABLE_REASONS`가 닫힌 집합. 새
  reason은 Desktop 선배포 필요. 원격 daemon은 `npm i -g` 별도 설치라 버전 스큐 전제.
- 기존 `checkpointSandbox.integration.test.ts`가 셸 write만 검증하는지, Claude native
  Write까지 검증하는지 Phase 0에서 확인해 Linux 쌍둥이의 커버리지를 맞출 것.
- Desktop ADR-059 line 37/59("Linux는 unavailable")는 이 스펙 완료 시 갱신(별도 저장소).

## 다음 세션 시작점

1. 사용자의 R8 필터 승인 여부 확인(plan.md "승인 대기"). 승인되면 spec R3 문구 갱신 →
   `checkpointSessionComposition.ts#sandboxConfigFor`에 platform 기반 필터(glob 항목 + passthrough
   symlink 항목 제외) → 단위 테스트 → Linux 테스트의 R8a/R8b를 "필터 적용 후 passthrough 동작"
   하나로 정리 → 컨테이너 재실행(`packages/happy-cli/scripts/checkpoint-linux-sandbox-check/`).
2. 컨테이너 실행은 arm64 네이티브(`ubuntu:22.04`, `--privileged`)로 했다. 대상 클라우드가 amd64면
   `--platform linux/amd64`로 한 번 더 돌릴 것(srt seccomp 필터는 x64/arm64 둘 다 vendored).
3. provider smoke(`checkpointProvider.integration.test.ts`)는 실제 Linux 머신 + Claude/Codex 계정이
   필요. 통과 전에는 Linux `protected`를 실사용에 광고하지 않는다.
4. 테스트 실행은 `./node_modules/.bin/vitest`/`tsc`를 직접 부를 것 — worktree에서 `npx tsc`는
   squatter 패키지를 실행해 조용히 통과한다. `integration-empty` 프로젝트는 로컬에서
   `Migration failed`로 setup이 깨지므로 단일 파일은 임시 vitest config로 돌렸다.

## 파일 맵

- `packages/happy-cli/src/checkpoint/checkpointExclusionPolicy.ts` — 플랫폼 게이트(47행), 매니페스트 빌더(변경 없음)
- `packages/happy-cli/src/checkpoint/checkpointSessionComposition.ts` — `sandboxConfigFor`(93행), `rotateProviderPath`(116행). R4 (a) 후보 지점
- `packages/happy-cli/src/codex/codexAppServerClient.ts` — `connect`(751행) sandbox init, `sendTurnAndWait`(1551행) beforeTurn, `completeTurn`(1579행). R4 (b) 후보 지점
- `packages/happy-cli/src/claude/utils/startHappyServer.ts:140`, `bashStream.ts:95` — MCP bash_stream 호스트 실행(범위 밖, 기록)
- `packages/happy-cli/src/checkpoint/checkpointTurnApply.ts` — `createExcludedPathMatcher`(326행) apply-time glob 게이트(변경 없음)
- `packages/happy-cli/src/checkpoint/checkpointTurnWorkspace.ts` — `freeze`/`fingerprintTree`(41행). mount-point 오염 관찰 지점
- `packages/happy-cli/src/sandbox/dependencyPreflight.ts` — `checkDependencies` 호출 선례, R2 재사용
- `packages/happy-cli/src/codex/codexAppServerClient.ts:745-767` — 보호 모드 sandbox init 실패 throw(이미 fail-closed)
- `packages/happy-cli/src/checkpoint/checkpointSandbox.integration.test.ts` — macOS 기준 테스트, Linux 쌍둥이의 원본
- `node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/{linux-sandbox-utils,sandbox-manager}.js` — Linux deny 처리·glob skip·mount-point 정리 로직
- Desktop `src/domain/checkpointTimeline.ts` — reason 파서(닫힌 집합), `docs/adr/059-*.md` — 갱신 대상
