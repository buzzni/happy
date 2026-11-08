# 데몬 재시작·업데이트에도 터미널 유지 — Tasks (happy-cli)

실행 순서 근거: 순수 프리미티브(Phase 1)가 워커·프록시(Phase 2)의 전제, 데몬 배선(Phase 3)은 둘 다 필요.

## Phase 0 — 승인
- [x] T0. 아키텍처 변경 승인(plan §7 ①~④) — 2026-11-08 조건 3개 붙여 승인, spec HR10~HR12·plan §2.8~2.10에 반영

## Phase 1 — 워커 프리미티브
- [x] T1. `terminalWorker/frames.ts` 길이 접두 JSON 프레임 인코더/디코더 → 단위 테스트(분할 수신·최대 크기·잘못된 길이)
- [x] T2. `terminalWorker/protocol.ts` 버전 상수·동결 봉투 타입·`classifyWorkerProtocol` → 단위 테스트
- [x] T3. `terminalWorker/record.ts` 기록 원자적 쓰기(0600/0700)·읽기·recordId 확인 삭제 → 단위 테스트
- [x] T4. `terminalWorker/socketPath.ts` 바이트 예산·후보 디렉터리·owner-only 검증 → 단위 테스트
- [x] T5. `terminalWorker/survivalDecision.ts` spec HR3 표 + `readTerminalWorkerFlag`(HR11 플래그 3값) → 표 전 행·플래그 테스트

## Phase 2 — 워커 프로세스와 프록시
- [x] T6. (structural) `TerminalOutputBuffer` seq 지정 append·dump/restore, `bindTerminal` 상태 내보내기/복원 — 동작 보존 → 기존 테스트 + 새 단위 테스트
- [x] T7. `terminalWorker/workerProcess.ts` + `happy terminal-worker` 하위 명령(`--protocol-version` 포함) → 통합 테스트(생성·입출력·terminate·hello 실패·컨트롤러 교체·자기 수명)
- [x] T8. `terminalWorker/workerClient.ts`(launch·connect·hello·요청/응답) + `workerPtySession.ts`(PtySession 구현) → 통합 테스트

## Phase 3 — 데몬 배선
- [x] T9. `terminalWorker/adoption.ts` 시작 시 분류·입양·리퍼(spec HR6 규칙) → 단위(가짜 프로세스 테이블) + 통합(고아·부팅 ID·비호환)
- [x] T10. 세션 생성 경로 선택(`remoteTerminal.ts`), 직결 경로 입양 등록·detach grace·`caps.survive`(`controlServerTerminalWs.ts`), 릴레이 경로 유지 안 함 → 기존 테스트 회귀 + 새 케이스
- [x] T11. 드레인 keep/close 결정·lifecycle 광고·busy 집계·`finalizeReady` 분기·설치본 프로토콜 질의(`restartDrainRuntime.ts`·`restartDrainLifecycle.ts`·`run.ts`) → restartDrain 테스트 + 통합(keep 드레인)
- [x] T12. 종료 경로: SIGTERM/stop = 워커 shutdown, 핸드오프 = detach, `TerminalWsRoute.close` 분기, `daemonState.terminalSurvival` 광고, 플래그 꺼짐 = 지금 경로 + 시작 리퍼 → 통합(stop은 셸 종료, SIGKILL 뒤 생존·입양)
- [x] T12a. (HR10) `doctor.ts` `terminal-worker` 분류·`doctor clean` 제외, `happy daemon status` 워커 줄, `terminalSurvival` 진단 필드(workers·workerVersion·lastAdoption) → 단위 테스트

## Phase 4 — 문서·마무리
- [x] T13. `docs/terminal-worker.md`, context 갱신
- [ ] T14. 셀프 리뷰 → 교차 리뷰 → PR(`buzzni/happy` main) → 리뷰봇 → rebase/CI

## 후속 (이번 PR 범위 아님)
- [ ] F1. **기본 켜기 전환**(HR11): `TERMINAL_WORKER_DEFAULT_ENABLED = true` 한 줄 + 릴리스 노트, 다음 Desktop pin에 반입. 전환 조건: (a) 옵트인 릴리스가 Desktop pin에 반입됨, (b) 팀 Mac 2대 이상에서 `HAPPY_TERMINAL_WORKER=1`로 pin 갱신 핸드오프 1회 이상·데몬 강제 종료(SIGKILL) 뒤 재기동 1회 이상에 터미널이 살아남음을 실기 확인, (c) 그 상태로 7일 동안 워커 누수(`happy daemon status` 워커 수가 열린 터미널 없이 0이 아닌 상태 지속)·도움 요청 0건, (d) `doctor clean`·Desktop 정리 경로 회귀 없음.
- [ ] F2. **릴레이 경로 유지**(HR12): 후속 spec `terminal-survive-relay-restart` — 선행: 다중 레플리카 세션 보류 계약, happy-server 배포, F1.
