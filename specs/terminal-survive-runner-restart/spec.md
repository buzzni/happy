# 데몬 재시작·업데이트에도 터미널 유지 (happy-cli)

> 작성일: 2026-11-08 / 상태: 초안 (아키텍처 변경 승인 대기)
> 짝 문서: aplus Desktop `specs/terminal-survive-runner-restart/` — 재시작 예고 UI와 직결 재연결.
> 참고 구현(읽기 전용): paseo `packages/server/src/terminal/terminal-worker-*.ts`, `docs/terminal-worker.md` (v0.15.x).

## 목표

같은 PC의 SayCode 터미널에서 돌던 셸·dev 서버·tmux가 데몬 재시작(pin 갱신·앱 업데이트·사용자 재시작·크래시)에 함께 죽지 않게, PTY를 데몬과 분리된 터미널 워커 프로세스에 두고 다음 데몬이 그 워커를 입양한다.

## 배경

PTY는 지금 데몬 프로세스 안에 있다(`daemon/remoteTerminal.ts` `createPtySession`, 레지스트리 `daemonTerminalSessions.ts`, 직결 경로 `controlServerTerminalWs.ts`, 릴레이 경로 `api/apiMachine.ts` terminal-open). 데몬이 끝나면 node-pty 마스터 fd가 닫혀 셸이 SIGHUP을 받는다. 재시작 드레인(aplus `specs/codexcli-daemon-restart-drain` R23)은 그래서 재시작 직전에 모든 터미널을 닫고, 핸드오프는 "사용 중인 터미널"을 최대 24시간 기다린다.

## 요구사항

- HR1. **분리.** POSIX(macOS·Linux)에서 새 터미널의 PTY는 데몬이 아니라 터미널 워커 프로세스가 연다. 워커는 detached로 떠서 데몬이 끝나면 init에 재부모화되고, 데몬과는 owner-only 유닉스 소켓 + 시크릿 인증으로 통신한다. 워커는 자기 기록 파일(`$HAPPY_HOME_DIR/terminal-workers/<recordId>.json`, 파일 0600·디렉터리 0700, 원자적 쓰기)에 pid·프로세스 시작 시각·부팅 ID·소켓 경로·시크릿·프로토콜 버전·CLI 버전을 남긴다. 기록은 워커만 쓴다.
- HR2. **입양.** 데몬은 시작할 때 기록을 읽어 살아 있는 같은 프로토콜 워커에 인증 연결하고 그 터미널을 같은 `sessionId`로 레지스트리에 되살린다(출력 버퍼·seq·사용자·경로·v2 바인딩 포함). pid 재사용 오판은 부팅 ID와 프로세스 시작 시각 비교로 막는다. 입양된 직결 터미널은 클라이언트가 없으므로 기존 detach grace(30초)를 입양 시점부터 센다.
- HR3. **재시작 의도.** 재시작 드레인이 "터미널 유지"로 끝나면 데몬은 워커에 붙은 직결 터미널을 닫지 않고 연결만 끊은 채 핸드오프한다. 유지 여부는 아래 표로 정하고, `daemonState.lifecycle.terminals`(`keep`|`close`)와 `terminalsCloseReason`으로 드레인 시작부터 광고한다.

  | 경우 | 터미널 | closeReason |
  |---|---|---|
  | restart 드레인: `bundle-replaced`·`version-mismatch`·`desktop-version-match`·`app-update`·`env-reapply`·`user-restart`·`signal`(SIGHUP) | 유지 | — |
  | restart 드레인: `account-switch` | 닫기 | `account-switch` |
  | stop 드레인·`happy daemon stop`·SIGTERM·SIGINT | 닫기 | `stop` |
  | 데몬 크래시(정상 종료 경로 없이 사라짐) | 유지(워커가 계속 보유) | — |
  | Windows | 닫기(워커 미사용, 지금 동작) | `windows` |
  | 설치본의 워커 프로토콜이 다르거나 확인 불가 | 닫기 | `incompatible` |
  | 기록 파일을 읽을 수 없음 | 닫기 | `record-unreadable` |
  | 킬 스위치 `HAPPY_TERMINAL_WORKER=0` | 닫기(워커 미사용) | `disabled` |
  | 워커를 띄우지 못해 데몬 안에서 연 터미널 | 닫기 | `worker-unavailable` |
  | 릴레이 경로 터미널 | 항상 닫기(서버가 데몬 끊김에 세션을 닫음) | 경로로 판단(Desktop) |

  유지 드레인에서는 유지될 터미널이 "사용 중"이어도 기다리지 않는다(`busyTerminalCount`는 닫힐 터미널만 센다).
- HR4. **능력 광고.** 워커를 쓸 수 있는 데몬은 `daemonState.terminalSurvival = { version: 1 }`을 광고하고, 워커 위의 직결 터미널은 open ack·attach 응답·v2 proof의 `caps.survive = true`를 보낸다. 킬 스위치·Windows·워커 실패 시에는 광고하지 않는다.
- HR5. **프로토콜 버전.** `TERMINAL_WORKER_PROTOCOL_VERSION`을 두고, 입양은 같은 버전만 한다. 프레임 형식·`hello`/`helloAck`·`list`·`shutdown`은 **동결 봉투**로 고정해 어떤 데몬이든 어떤 워커든 닫을 수 있게 한다. 다른 버전 워커는 동결 봉투의 `shutdown`으로 닫는다. 재시작 전 데몬은 설치본에 `happy terminal-worker --protocol-version`을 물어 버전이 같을 때만 `keep`을 광고한다.
- HR6. **리퍼(fail-safe).** 데몬 시작 시: 이전 부팅 기록·pid가 없는 기록·pid는 있으나 시작 시각이 다른 기록(pid 재사용)은 **신호 없이** 기록만 지운다. 소켓이 응답하는 다른 버전 워커는 동결 `shutdown`. pid는 살아 있고 시작 시각이 같은데 소켓이 응답하지 않으면, 또는 프로세스 테이블/시작 시각을 읽을 수 없으면 **아무것도 신호하지 않고** 기록도 남긴다(다음 시작에 재시도). 읽을 수 없는 기록은 지우지 않고 경로를 로그에 남긴다. 리퍼가 신호를 보내는 대상은 소켓 인증을 통과한 워커 자신뿐이고, 워커가 자기 PTY 그룹을 닫는다.
- HR7. **워커 자기 수명.** 워커는 (a) 첫 컨트롤러를 30초 안에 못 받고 터미널도 없으면, (b) 터미널이 0개이고 컨트롤러가 없으면, (c) 자기 기록 파일이 사라지면(10초 간격 확인), (d) 컨트롤러 없이 24시간이 지나면 모든 터미널을 닫고 종료한다. SIGTERM은 "닫기"다. 한 번에 컨트롤러 하나만 붙고, 새로 인증한 연결이 이전 연결을 대체한다.
- HR8. **이전 버전 워커.** 입양한 워커의 CLI 버전이 현재 데몬과 다르면 그 워커는 기존 터미널만 유지(draining)하고 새 터미널은 현재 버전의 새 워커에 연다 — 바뀐 설치 경로에서 node-pty 헬퍼를 다시 불러오지 않기 위해서다. draining 워커는 마지막 터미널이 끝나면 스스로 종료한다.
- HR9. **통합 테스트.** 실제 프로세스로: 워커 분리(데몬 프로세스 SIGKILL 뒤에도 셸 생존), 입양(새 데몬이 같은 sessionId·출력 seq를 이어감), 비호환(다른 프로토콜 워커를 동결 shutdown으로 닫음), 고아 정리(기록만 남은 경우·부팅 ID 다른 경우 신호 없이 정리), 명시적 stop은 터미널을 닫음.

## 비목표

- 릴레이 경로 터미널 유지 — happy-server `terminalRelayHandler.ts`가 데몬 소켓 disconnect에 세션을 닫는다. 서버 세션 보류 계약이 필요해 별도 spec.
- Windows 지원 — 지금의 hosted launcher(`standaloneWindowsRuntime`) 경로를 그대로 두고 항상 닫는다.
- 스크롤백 형식·상한 변경 — 기존 `terminalOutputBuffer`를 워커가 그대로 쓴다.
- paseo식 런타임 사본(`$HOME` 아래 워커 코드 복사) — HR8(이전 버전 워커는 새 PTY를 열지 않음)로 대신한다.
- 사용자 설정으로 유지/닫기 선택.

## 제약

- 보안: 소켓·기록은 owner-only. 시크릿은 32바이트 랜덤, `timingSafeEqual`. v2 터미널 키는 워커 **메모리**에만 두고 디스크에 쓰지 않는다. 공유 임시 디렉터리 아래 디렉터리는 chmod하지 않고 소유자·모드가 정확할 때만 쓴다.
- 호환성: 구 Desktop과 구 데몬 모두 지금 동작으로 떨어진다. 새 wire는 전부 선택 필드.
- 소켓 경로 바이트 예산: macOS 103, Linux 107.
- 워커 진입 모듈은 시작 뒤 동적 import를 하지 않는다(설치본 교체 뒤 청크 유실 방지).

## 완료 기준

- [ ] HR1~HR9 단위·통합 테스트 통과(`pnpm test` in `packages/happy-cli`)
- [ ] typecheck 통과
- [ ] `docs/` 터미널 워커 문서와 이 spec의 context 갱신
- [ ] 실기(실제 데몬 재시작·pin 갱신 중 터미널 생존)는 사용자 수동 확인으로 PR에 기록
