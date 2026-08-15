# context

## 2026-08-15 — 3개 Phase 모두 완료

### 진단 근거 (재현용)

- daemon 로그 `~/.happy_remote/logs/2026-08-15-20-19-37-pid-79301-daemon.log`
  - L35 `Recovered alive session PID 9179` (20:19:38 입양)
  - L7311-7315 `absolute-idle-cut` → SIGTERM (22:03:37).
    **`Preserved session ... for resume` 줄이 없다** — 이게 결정적 단서였다.
  - L7317-7319 `resume-happy-session` 이 1ms 만에 272바이트 에러 반환, spawn 없음
- `~/.happy_remote/sessions.json` 의 `cmssqf5t70a8y212fmgf6pc10` 레코드에
  `lastProcessedSeq` / `userHomeDir` 키가 없고 `savedAt` 이 spawn 시각(08-14
  18:15:43)에 머물러 있었다 → `hasReliableResumeBaseline` false →
  `SESSION_CURSOR_MISSING`

### Phase 1 (a5a67302) — 구조

`hydrateTrackedSessionFromPersisted` 추출. run.ts 의 finished-session 맵이
인라인으로 하던 변환을 옮긴 것이라 동작 변경 없음. `readPersistedSessions()`
호출도 startup 앞으로 한 번만 올려 세 소비자가 공유한다.

### Phase 2 (98ebed6c) — daemon 동작

- `run.ts` 상태파일 복구 + `orphanAdoption.ts` `resolveOrphanAdoption` 이
  하이드레이션 적용
- `preserveSessionForResume` 이 보존 실패 이유를 로깅

주의: `runtime` 은 절대 만들어내지 않는다. idle guard 의 stale-runtime 보호가
`runtime` 부재에 의존한다. 테스트로 고정해 뒀다.

### Phase 3 (ab0168e8) — 모바일 앱

`prepareSessionForSend` (순수, deps 주입) + `useSessionSend` 훅.
`getResumeAvailability` 는 `useSessionQuickActions` 에서 export 해 재사용한다.

## 검증

| 대상 | 결과 |
|---|---|
| `happy-cli` 단위 테스트 | 636 통과 |
| `happy-cli` tsc --noEmit | 통과 |
| `happy-app` 전체 스위트 | 726 통과 (62 파일) |
| `happy-app` typecheck | 통과 |
| `happy-cli` daemon.integration.test.ts | **미실행** — DB 마이그레이션 필요.
  손대지 않은 base(main)에서도 동일하게 실패하는 환경 의존 테스트다 |

## 남은 것 / 후속

- 이미 커서 없이 저장된 기존 레코드는 소급 복구하지 않는다. 그런 세션은 계속
  resume 불가이며, 앱은 이제 recover 로 새 대화를 이어가거나 실패를 알린다.
- daemon 배포 전까지는 같은 증상이 재발할 수 있다. `vendor/happy` pointer 갱신은
  CLAUDE.md 1.8 의 릴리스 절차(tag → CI publish)를 따를 것.

## 2026-08-15 — 셀프 리뷰 후 수정 (2차)

- **[버그] 실패 시 메시지 유실**: handleSend 가 composer 를 먼저 비우고
  performSend 를 불러서, resume/recover 실패 시 사용자가 입력한 텍스트가
  통째로 사라졌다 (composer 에 setMessage 복원 API 없음). useSessionSend 가
  consumed boolean 을 반환하고 SessionView 는 성공 시에만 clear 하도록 수정.
- **[누락] 전송 연타 가드**: composer 가 ladder 진행 중(수 초) 유지되므로
  연타 시 동일 텍스트로 ladder 가 중복 실행될 수 있었다. in-flight ref 추가.
- **[관행] sendFailedNoRunningAgent 번역**: 다른 신규 키들은 전 로케일 번역이
  있는데 이 키만 영어였다. 9개 로케일 번역 채움.
- 확인만 하고 수정 불필요: daemon.state.json 은 필드를 명시적으로 골라
  저장하므로 하이드레이션된 encryption 이 새지 않는다. 훅 자체의 renderHook
  테스트는 이 저장소 관행(훅 파일의 exported 순수 함수만 테스트)에 없어
  추가하지 않았다.
- 알려진 한계(주석으로 명시): recover 는 텍스트만 전달하므로 prompt-delivered
  경로에서 attachments 는 새 세션으로 전달되지 않는다.

## 2026-08-15 — 셀프 리뷰 (3차): 오프라인 큐잉 회귀 복원

2차까지의 구현은 disconnected 세션 전송을 "복구 아니면 차단"으로 다뤘다.
이건 두 가지를 놓친 회귀였다:

- `isConnected` 는 `presence === "online"` 일 뿐이다. offline 은 프로세스
  죽음뿐 아니라 **살아있는 CLI 의 일시적 연결 끊김**(노트북 lid 닫힘)도
  포함한다. 후자에서 "서버 큐잉 → 재접속 시 수신"은 정상 동작하던 기존
  플로우인데 이를 알림+차단으로 막아버렸다.
- `expResumeSession` 기본값은 false 다. 실험 off 는 기존 동작 그대로여야
  하는데 off 에서도 차단했다.

수정: 복구를 시도할 수 없는 조건(플래그 off / 머신 오프라인 / backend id
없음)은 기존처럼 큐잉 전송. ladder 를 실제로 시도해 실패한 경우에만 알림 +
composer 보존. daemon 이 커서를 보존하므로(AC1~AC2) 죽은 세션으로 큐잉된
메시지도 다음 resume 에서 replay 된다 — 큐잉이 데이터 유실이 아니게 됐다.

이에 따라 `sendFailedNoRunningAgent` i18n 키가 고아가 되어 11개 파일에서
제거. spec.md AC5 도 이 설계로 갱신.

남는 갭(의도된 결정): 기본 플래그 off 에서는 머신 온라인+프로세스 죽음
케이스의 자동 복구가 동작하지 않는다. 실험 원칙(off=기존 동작) 준수가
우선이고, daemon 수정 덕에 메시지는 유실되지 않고 다음 resume 에서
replay 된다.
