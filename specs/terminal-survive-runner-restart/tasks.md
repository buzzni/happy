# 데몬 재시작·업데이트에도 터미널 유지 — Tasks (happy-cli)

실행 순서 근거: 순수 프리미티브(Phase 1)가 워커·프록시(Phase 2)의 전제, 데몬 배선(Phase 3)은 둘 다 필요. 승인 전 구현 없음.

## Phase 0 — 승인
- [ ] T0. 아키텍처 변경 승인(plan §7 ①~④)

## Phase 1 — 워커 프리미티브
- [ ] T1. `terminalWorker/frames.ts` 길이 접두 JSON 프레임 인코더/디코더 → 단위 테스트(분할 수신·최대 크기·잘못된 길이)
- [ ] T2. `terminalWorker/protocol.ts` 버전 상수·동결 봉투 타입·`classifyWorkerProtocol` → 단위 테스트
- [ ] T3. `terminalWorker/record.ts` 기록 원자적 쓰기(0600/0700)·읽기·recordId 확인 삭제 → 단위 테스트
- [ ] T4. `terminalWorker/socketPath.ts` 바이트 예산·후보 디렉터리·owner-only 검증 → 단위 테스트
- [ ] T5. `terminalWorker/survivalDecision.ts` spec HR3 표 → 표 전 행 테스트

## Phase 2 — 워커 프로세스와 프록시
- [ ] T6. (structural) `TerminalOutputBuffer` seq 지정 append·dump/restore, `bindTerminal` 상태 내보내기/복원 — 동작 보존 → 기존 테스트 + 새 단위 테스트
- [ ] T7. `terminalWorker/workerProcess.ts` + `happy terminal-worker` 하위 명령(`--protocol-version` 포함) → 통합 테스트(생성·입출력·terminate·hello 실패·컨트롤러 교체·자기 수명)
- [ ] T8. `terminalWorker/workerClient.ts`(launch·connect·hello·요청/응답) + `workerPtySession.ts`(PtySession 구현) → 통합 테스트

## Phase 3 — 데몬 배선
- [ ] T9. `terminalWorker/adoption.ts` 시작 시 분류·입양·리퍼(spec HR6 규칙) → 단위(가짜 프로세스 테이블) + 통합(고아·부팅 ID·비호환)
- [ ] T10. 세션 생성 경로 선택(`remoteTerminal.ts`), 직결 경로 입양 등록·detach grace·`caps.survive`(`controlServerTerminalWs.ts`), 릴레이 경로 유지 안 함 → 기존 테스트 회귀 + 새 케이스
- [ ] T11. 드레인 keep/close 결정·lifecycle 광고·busy 집계·`finalizeReady` 분기·설치본 프로토콜 질의(`restartDrainRuntime.ts`·`restartDrainLifecycle.ts`·`run.ts`) → restartDrain 테스트 + 통합(keep 드레인)
- [ ] T12. 종료 경로: SIGTERM/stop = 워커 shutdown, 핸드오프 = detach, `TerminalWsRoute.close` 분기, `daemonState.terminalSurvival` 광고, 킬 스위치 → 통합(stop은 셸 종료, SIGKILL 뒤 생존·입양)

## Phase 4 — 문서·마무리
- [ ] T13. `docs/terminal-worker.md`, context 갱신
- [ ] T14. 셀프 리뷰 → 교차 리뷰 → PR(`buzzni/happy` main) → 리뷰봇 → rebase/CI
