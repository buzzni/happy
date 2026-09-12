# ADR: Linux daemon 머신의 체크포인트 보호

- Status: Proposed
- Date: 2026-09-05
- Owners: happy-cli daemon (checkpoint, sandbox)
- Related: aplus-dev-studio-desktop ADR-059, `specs/linux-checkpoint-enforcement-backend/`

## Context

ADR-059는 v1 체크포인트 보호(`protected`)를 macOS Claude remote/Codex에 한정하고, Linux는
"sandbox runtime이 기존 literal path만 차단"한다는 이유로 `unavailable`로 두었다. 실제 OS
강제는 이미 크로스플랫폼인 `@anthropic-ai/sandbox-runtime`(srt; macOS `sandbox-exec`, Linux
`bubblewrap`)을 통과하고 있었고, Happy 코드의 플랫폼 분기는 `resolveCheckpointProtectionCapability`
한 줄뿐이었다. Ubuntu 22.04 컨테이너에서 실제 bwrap으로 실측한 결과:

- srt Linux는 **존재하지 않는 리터럴 deny 경로**에도 `/dev/null`·빈 디렉터리를 bind해 생성까지
  막는다. 못 하는 것은 glob 패턴뿐이며, glob 항목은 wrap 경로에서 걸러지지 않고 `ws/**` 같은
  mount-point 잔여물을 남긴다.
- glob 전용 신규 secret은 workspace에 써지지만 `createExcludedPathMatcher`가 apply 시점에
  `excluded-path` conflict로 막아 원본에는 절대 닿지 않는다. 차이는 차단 시점(write-time vs
  apply-time)뿐이다.
- srt Linux는 **존재하지 않는 allowWrite 경로를 bind하지 않는다.** Codex는 `connect()`에서
  sandbox를 감싸고 workspace는 그 뒤 `beforeTurn()`에서 만들므로, Linux에서는 workspace가
  writable bind에 들어가지 않아 모든 쓰기가 `Read-only file system`으로 실패했다.
- srt Linux의 symlink 교체 방어(`findSymlinkInPath`)가 allowWrite 안의 symlink deny 경로에
  `/dev/null`을 bind하려 해 bwrap이 기동조차 못 한다. 체크포인트의 read-only passthrough는
  symlink로 구현돼 있어, passthrough가 하나라도 있으면 Linux protected 턴이 시작되지 않는다.
- Desktop은 `protection` 객체를 키 개수까지 검사하는 닫힌 파서로 읽고, 원격 daemon은 버전
  미고정 `npm i -g`로 설치된다.

## Decision

1. `resolveCheckpointProtectionCapability`는 `linux`를 받되 srt `checkDependencies()`가
   error 없이 통과할 때만 `protected`를 광고한다. 프로브 예외는 fail-closed이고 결과는 daemon
   수명 동안 캐시한다. 의존성 부재 사유는 기존 `unsupported-platform`을 재사용한다 — 공개
   계약(`protection`, reason enum, event envelope)은 바꾸지 않는다.
2. provider workspace 경로는 sandbox 구성 전에 `CheckpointTurnWorkspace.reserve()`로 빈
   디렉터리로 예약하고, **보호 모드 Codex는 실행 중인 프로세스를 끊은 뒤에 checkpoint gate를
   돌리고 그 다음에 wrap·spawn 한다**(`CodexAppServerClient.prepareProtectedTurn()`). 예약만으로는
   부족하다 — bwrap이 살아 있는 동안 만든 mount-point는 삭제할 수 없어(EBUSY) `prepare()`가
   "not empty"로 실패한다. 프로세스 종료를 기다린 뒤 srt cleanup이 그 파일들을 지운다. dispatch되지
   않은 turn은 `composition.abortTurn()`으로 폐기한다. macOS는 mount-point가 없어 동작이 같다.
3. glob 전용 secret 신규 생성의 write-time 차단은 Linux v1에서 보장하지 않는다. apply-time
   `excluded-path` conflict + `pendingDecision.source: 'turn-apply'`가 계약이며 Linux
   integration 테스트로 고정한다. gitignore된 신규 secret은 원본 미반영이지만 pending을
   보장하지 않는다.
4. (2026-09-05 승인) Linux에서 srt에 넘기는 workspace deny 목록에서 **glob 항목**과 **passthrough
   symlink 항목**만 제외한다. glob은 Linux에서 원래 무효이고, passthrough 대상은 `/` ro-bind로
   이미 read-only다. 그 외 열거된 리터럴 deny(secret·too-large·ignored 파일)는 유지한다.

## Alternatives

- Happy 자체 Landlock 레이어 — 원본 보호가 apply 게이트로 성립해 v1 가치 대비 과잉. 별도 스펙.
- `protection.status` qualifier / 새 reason 값 — Desktop 파서와 원격 daemon 버전 스큐 때문에
  daemon-first로 불가.
- Linux에서 workspace deny 목록 전체 생략 — ignored·용량 제한 파일의 write-time 차단까지 잃는
  ADR-059 보장 축소. 기각.
- 빈 디렉터리 예약만으로 순서 문제를 덮기 — 실측에서 실패. 살아 있는 bwrap이 만든 mount-point는
  EBUSY로 지울 수 없어 `prepare()`가 거부한다.
- Linux Codex를 `unavailable`로 남기기 — 순서 변경이 기존 재접속 경로(매 보호 턴마다 이미
  disconnect→reconnect 한다)를 재사용하는 작은 변경이라 기각.
- 제외 경로를 placeholder 파일로 미리 만들어 bwrap이 기존 경로를 ro-bind하게 하기 — placeholder가
  synthetic baseline에 커밋되고 provider에게 빈 파일로 보이므로 기각.

## Consequences

- Linux daemon 머신(bwrap·socat·rg 설치, unprivileged userns 가능)에서 protected 세션이 열린다.
- Linux의 glob 전용 신규 secret은 턴 종료 시 사용자 재확인으로 올라오며, 그 내용은 정상
  apply 뒤 삭제되는 daemon 소유 workspace(0700)에 턴 동안 존재한다.
- seccomp 필터가 없는 머신은 Unix socket 차단 없이 실행된다(파일시스템 보장은 동일).
- Happy MCP `bash_stream`이 호스트에서 sandbox 없이 실행되는 것은 macOS와 동일한 플랫폼 공통
  누락으로 남는다(별도 스펙).
- 되돌리려면 게이트의 `linux` 분기를 제거하면 된다. `reserve()`는 macOS에 무해하므로 유지.
- **재검토 조건**: srt가 Linux glob deny 또는 symlink passthrough를 지원하게 되면 4번을 되돌리고
  write-time 보장을 macOS와 맞춘다. Desktop 파서가 관용적으로 바뀌고 원격 daemon 최소 버전이
  고정되면 의존성 부재 전용 reason 값을 검토한다.
