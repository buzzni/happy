# 데몬 재시작·업데이트에도 터미널 유지 — Plan (happy-cli)

> 작성일: 2026-11-08 / 상태: 초안 (아키텍처 변경 승인 대기)
> 근거: [spec.md](./spec.md). Desktop 짝 문서: aplus `specs/terminal-survive-runner-restart/plan.md`.

## 1. 영향

| 항목 | 내용 |
|---|---|
| 프로세스 경계 | **변경.** 데몬 안 PTY → detached 터미널 워커 프로세스(데몬당 current 1개 + 이전 버전 draining 0~N개). 데몬이 죽어도 셸과 그 자식이 산다 |
| 관련 모듈 | 신규 `src/daemon/terminalWorker/`(protocol·frames·record·socketPath·workerProcess·workerClient·workerPtySession·adoption·reaper), 수정 `remoteTerminal.ts`(세션 생성 경로 선택), `daemonTerminalSessions.ts`(입양 등록·유지 대상 집계), `controlServerTerminalWs.ts`(입양된 직결 터미널 등록·caps.survive·종료 시 detach), `api/apiMachine.ts`(릴레이 터미널은 지금처럼), `restartDrainRuntime.ts`·`restartDrainLifecycle.ts`(유지 결정·광고), `run.ts`(시작 시 입양·종료 경로별 close/detach), `src/index.ts`/CLI 진입(`happy terminal-worker` 하위 명령) |
| 소비 경로 | 핸드오프(`handOffToInstalledBundle`)·SIGHUP 재시작·`happy daemon stop`·SIGTERM·크래시 재기동, Desktop 재시작 예고(`daemonState.lifecycle`), 직결 재연결(`terminal-attach`) |
| 새 외부 의존성 | 없음(node-pty·node 내장만) |
| 공개 wire 변경(추가·선택 필드) | `daemonState.terminalSurvival {version:1}`, `daemonState.lifecycle.terminals`·`terminalsCloseReason`, 직결 `DIRECT_TERMINAL_CAPS.survive`, v2 `TerminalProofCaps.survive` |
| 디스크 | 신규 `$HAPPY_HOME_DIR/terminal-workers/`(기록 JSON 0600, `s/` 소켓 디렉터리 0700), `terminal-worker.log` |
| 보안 | 터미널 키(v2)와 바인딩 상태를 워커 메모리에 둔다. 소켓은 owner-only + 시크릿. 기록 파일에 시크릿이 있다(데몬 상태 파일의 control secret과 같은 신뢰 수준) |

## 2. 설계

### 2.1 프로세스 모델

```
daemon ──spawn(detached, stdio: [ignore, pipe(ready), logFd])──► terminal worker
   ▲                                                                │
   └──── unix socket (owner-only, hello{secret, protocolVersion}) ◄─┘
```

- 데몬이 `spawnHappyCLI`와 같은 명령 구성으로 `happy terminal-worker --record-id <uuid>`를 detached 실행한다. 워커는 listen·기록 쓰기 뒤 stdout에 `ready <socketPath>\n` 한 줄을 쓰고 stdout을 닫는다(데몬이 죽은 뒤 끊긴 파이프에 쓰지 않도록). 데몬은 15초 안에 ready가 없으면 그 자식을 SIGKILL한다. 로그는 파일로만.
- 세션 프로세스가 이미 같은 방식(detached + unref)으로 데몬보다 오래 사는 선례가 있다(`restartDrain.ts` 머리 주석). paseo는 슈퍼바이저의 tree-kill 때문에 중간 런처가 필요했지만, 우리 데몬을 ppid 체인으로 죽이는 경로는 없다(Desktop `electron/` 확인: tree-kill 없음). 런처는 두지 않고, 생기면 재검토한다.
- 워커 시작 실패는 데몬 부팅을 막지 않는다. 그 경우 터미널은 지금처럼 데몬 안에서 열고(`worker-unavailable`), 다음 터미널 생성 때 다시 띄워 본다.

### 2.2 프레임·프로토콜 (HR5)

- 프레임: 4바이트 BE 길이 + UTF-8 JSON, 최대 16 MiB. 잘못된 프레임은 소켓 파괴.
- **동결 봉투**(버전이 바뀌어도 절대 바꾸지 않음): 프레임 형식, `hello{secret, protocolVersion}` → `helloAck{pid, protocolVersion, cliVersion}`, `list` → `{terminals:[{id, pid, exited}]}`, `shutdown` → 모든 터미널 terminate 후 응답 flush 뒤 exit.
- 버전 1 요청: `create{id, shell, args, cwd, env, cols, rows, meta, bufferChars, bufferFrames}`, `write{id, data}`, `resize{id, cols, rows}`, `signal{id, signal}`, `terminate{id, graceMs?}` → outcome, `dump{id}` → `{frames, nextSeq, exit}`, `setMeta{id, meta}`. 이벤트: `output{id, seq, data}`, `exit{id, code, signal}`.
- 인증 없는 연결은 5초 뒤 파괴. 인증된 새 연결이 이전 컨트롤러를 대체한다. 소켓 생존 확인은 인증 없이 connect만 한다(현재 컨트롤러를 빼앗지 않도록).

### 2.3 출력 버퍼와 seq (스크롤백 재사용)

- 워커가 터미널별로 기존 `createTerminalOutputCoalescer` + `createTerminalOutputBuffer`를 그대로 돌려 **seq를 정한다**. 데몬은 `output{seq}`를 같은 seq로 자기 버퍼에 미러한다(`TerminalOutputBuffer`에 seq 지정 append 추가). 기존 `terminal-resume`·페이지 재생·gap 판정 코드는 데몬 버퍼를 읽으므로 바뀌지 않는다.
- 입양 시 데몬은 `dump`로 버퍼를 받아 같은 seq로 복원한다. 상한은 기존 값(문자 1,000,000·프레임 20,000).

### 2.4 데몬 쪽 PtySession 프록시

- `PtySession` 인터페이스(write·resize·kill·isAlive·terminate·onData·onExit)를 그대로 구현하는 `createWorkerPtySession`을 둔다. 호출부(`controlServerTerminalWs`, `apiMachine` terminal-open)는 `createPtySession` 대신 선택 함수 하나만 부른다. `terminate()`의 SIGHUP→SIGKILL 보장은 워커 안의 실제 `createPtySession`이 그대로 수행한다.
- 메타(`meta`): `{sessionId, userId, machineId, route, openedAt, binding?}`. v2 바인딩은 `{terminalKey, daemonNonce, terminalId, lastInSeq}`로 직렬화한다(`bindTerminal`에 상태 내보내기/복원 추가). `lastInSeq`는 정상 핸드오프 직전에 `setMeta`로 최신화하고, 크래시 뒤에는 낡을 수 있지만 직결 재연결은 항상 `attach`(seq > lastInSeq면 수락하고 lastInSeq를 갱신)로 시작하므로 무해하다.

### 2.5 유지 결정과 광고 (HR3·HR4)

- 드레인 runtime이 드레인 시작 시 `decideTerminalSurvival({platform, workerEnabled, intent, reason, installedProtocol, recordsReadable})` → `{terminals:'keep'|'close', reason?}`를 계산해 lifecycle에 싣는다. `installedProtocol`은 기존 `preflightReplacement`와 같은 자리에서 설치본에 `terminal-worker --protocol-version`을 물어 얻는다(실패·불일치 = `incompatible`).
- `finalizeReady`: keep이면 릴레이 터미널만 지금처럼 `daemon-restart`로 닫고, 직결 워커 터미널은 `setMeta`로 바인딩 상태를 밀어 넣은 뒤 소켓만 끊는다(`detach`). close면 지금처럼 전부 닫는다(워커 `terminate` → 워커가 비면 스스로 종료).
- `getRestartDrainActivity().busyTerminalCount`·핸드오프 터미널 대기: keep일 때 닫힐 터미널만 센다.
- 종료 경로: `requestShutdown`(SIGTERM·SIGINT·stop 드레인·`happy daemon stop`) = 워커 `shutdown`(닫기). 핸드오프 성공 = detach 후 `process.exit(0)`. 크래시 = 아무것도 안 함.
- `TerminalWsRoute.close()`가 지금은 detach grace 중인 터미널을 끝내는데, keep 핸드오프에서는 닫지 않도록 `close({keepWorkerTerminals})` 분기를 둔다.

### 2.6 시작 시 입양·리퍼 (HR2·HR6·HR8)

분류(기록별):
1. 읽기 실패 → 경고, 신호·삭제 없음, `recordsReadable=false`(다음 드레인은 `record-unreadable`).
2. 부팅 ID 다름(`utils/bootIdentity.ts`) → 기록 삭제, 신호 없음.
3. pid 없음 → 기록 삭제. pid 있음 + 시작 시각(`utils/processStartTime.ts`) 다름 → pid 재사용, 기록 삭제·신호 없음. 시작 시각을 못 읽음 → 아무것도 안 함.
4. 소켓 connect 거부 + pid·시작 시각 일치 → 응답 없는 워커: 신호 없음, 기록 유지, 로그.
5. 소켓 accepting → 인증 hello. 같은 프로토콜 → 입양(`list`+`dump`+메타로 레지스트리 복원). 버전 다름 → 동결 `shutdown`. 인증 실패 → 신호 없음.
- 입양한 워커의 `cliVersion`이 다르면 draining(HR8). 같으면 current. current가 둘 이상이면 첫째만 current, 나머지 draining.
- 입양된 릴레이 경로 터미널(크래시 뒤에만 생김)은 서버 세션이 이미 닫혔으므로 즉시 terminate.
- 기록 삭제는 recordId가 일치할 때만(같은 파일명을 새 워커가 다시 쓴 경우 보존).

### 2.7 Windows·킬 스위치

- `process.platform === 'win32'` 또는 `HAPPY_TERMINAL_WORKER=0`이면 워커를 쓰지 않고 지금 코드 경로 그대로. `terminalSurvival`을 광고하지 않는다.

## 3. 대안 비교

| 대안 | 기각 이유 |
|---|---|
| tmux/screen으로 셸 감싸기 | 설치 의존, 사용자 tmux와 중첩, 출력·키 처리 변화 |
| 데몬 in-place 재실행(exec)으로 fd 유지 | Node에 fd 보존 exec 없음, node-pty 객체 복원 불가 |
| PTY 마스터 fd를 새 데몬에 넘김(SCM_RIGHTS) | Node 유닉스 소켓에 fd 전달 API 없음(네이티브 애드온 필요), node-pty 객체를 fd에서 만들 수 없음 |
| paseo식 런타임 사본 | 복사·정리·asar 처리 비용이 크다. 이전 버전 워커가 새 PTY를 열지 않게 하면(HR8) 필요 없음. 재검토: draining 워커가 새 PTY를 열어야 하는 요구가 생기면 |
| 중간 런처로 재부모화 | 우리 데몬엔 ppid 체인 강제 종료가 없어 불필요. 재검토: tree-kill 경로가 생기면 |
| 릴레이 경로까지 유지 | happy-server 세션 보류·다중 레플리카 계약·서버 배포 필요. 별도 spec |
| 버전 다른 워커도 어댑터로 입양 | 출시 전 1버전이라 불필요. 동결 봉투로 닫기만 보장 |

## 4. 단계

- [ ] **Phase 1 — 워커 프리미티브**: frames·protocol·record·socketPath·decideTerminalSurvival 순수 모듈 → 검증: 단위 테스트(프레임 경계·크기 초과, 기록 원자적 쓰기·0600·recordId 확인 삭제, 소켓 경로 예산·디렉터리 검증, 버전 분류, 유지 결정 표 전 행)
- [ ] **Phase 2 — 워커 프로세스와 프록시**: workerProcess·workerClient·workerPtySession, 출력 seq 미러, 바인딩 상태 내보내기/복원 → 검증: 실제 워커 프로세스 통합 테스트(생성·입출력·terminate 보장·hello 실패·컨트롤러 교체·자기 수명 규칙)
- [ ] **Phase 3 — 데몬 배선**: 입양·리퍼, 직결/릴레이 경로 선택, 드레인 keep/close·lifecycle 광고·busy 집계, 종료 경로별 close/detach, caps.survive, 킬 스위치 → 검증: 통합 테스트 HR9 5종 + 기존 restartDrain·controlServerTerminalWs 테스트 회귀
- [ ] **Phase 4 — 문서·마무리**: `docs/terminal-worker.md`(프로세스 모델·동결 봉투·리퍼 규칙), context 갱신 → 교차 리뷰 → PR

## 5. 검증

- 단위: Phase 1·2 모듈별.
- 통합(실제 프로세스, 임시 `HAPPY_HOME_DIR`, 포트 0, 기존 `restartDrain.integration` 패턴): (1) 데몬 fixture에서 직결 터미널 열고 `sleep` 루프 실행 → fixture SIGKILL → 셸 pid 생존 → 새 fixture가 입양, 같은 sessionId로 attach·resume에서 seq 이어짐 (2) `PROTOCOL_OVERRIDE`로 다른 버전 워커 → 새 데몬이 shutdown, 셸 종료 확인 (3) 기록만 남은 경우·부팅 ID 다른 기록 → 신호 없이 삭제 (4) `stop` → 셸 종료 (5) keep 드레인 → 릴레이 터미널만 닫힘.
- 실기(사용자 수동 확인): macOS에서 Desktop 직결 터미널 `npm run dev` → pin 갱신 핸드오프 → 같은 탭 유지.

## 6. 리스크와 복구

| 리스크 | 대응 |
|---|---|
| 워커 누수(데몬이 영영 안 돌아옴) | HR7: 기록 삭제 감지 10초, 컨트롤러 없이 24시간, 터미널 0개면 종료. `happy daemon stop`이 남은 워커를 닫는다 |
| pid 재사용으로 남의 프로세스에 신호 | 신호는 인증된 워커에만 소켓 요청으로. 직접 kill 신호는 ready 타임아웃 시 방금 spawn한 자식에만 |
| 프로세스 테이블·시작 시각을 못 읽음 | 아무것도 신호하지 않고 기록 유지(fail-safe) |
| 입양 실패로 "유지" 약속이 거짓이 됨 | 새 데몬이 모르는 터미널 → Desktop attach가 `unknown-session` → 지금과 같이 닫힘 표시. 실패 원인은 데몬 로그 |
| 설치본 교체 뒤 워커가 사라진 파일을 로드 | 워커 진입은 정적 import만, 이전 버전 워커는 새 PTY를 열지 않음(HR8) |
| 워커 크래시 | 그 워커의 터미널은 모두 끝난다(지금 데몬 크래시와 같은 결과). 데몬은 소켓 close → 모든 로컬 항목에 exit(code null) |
| 회귀 | 킬 스위치 `HAPPY_TERMINAL_WORKER=0` = 지금 경로. Desktop은 능력 게이트라 자동으로 지금 동작 |

복구: 킬 스위치 → 데몬 재시작이면 워커 미사용, 남은 워커는 `happy daemon stop` 또는 `$HAPPY_HOME_DIR/terminal-workers/` 삭제(워커가 10초 안에 스스로 닫고 종료). 코드 롤백은 이전 pin으로.

## 7. 승인

- 근거: 오케스트레이션 T10 브리프 — spec·plan 뒤 BLOCKED로 승인 요청 후 구현.
- 승인 대상(AGENTS.md 기준): ① 프로세스 경계 변경(장수 detached 워커, 터미널 키 메모리 보관) ② wire 추가(§1 표) ③ 범위: 릴레이 경로 제외 ④ 유지 정책 표(spec HR3).
- 승인받은 사항: 없음(대기).
