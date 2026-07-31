# 브라우저 브리지 — 토큰 드리프트와 프로필 오선택 수정 Tasks

> 작성일: 2026-07-31
> 근거 문서: [spec.md](./spec.md) / [plan.md](./plan.md)

## Phase 1 — 토큰 스코프 교정 (R1, R2)

- [x] T1. `src/daemon/browserBridgeToken.test.ts` — `resolveBrowserBridgeTokenFile(home, happyHome)`가
      `HAPPY_HOME_DIR`과 무관하게 `<home>/.happy/browser-bridge.token`을 반환 (R1)
- [x] T2. 같은 파일 — 공용 경로가 없고 `migrateFrom`에 토큰이 있으면 그 값을 승계해 기록 (R1)
- [x] T3. `browserBridgeToken.ts` / `configuration.ts` 구현 — 경로 해석 + 마이그레이션 + 디렉터리 생성
- [x] T4. `src/commands/browser.test.ts` — 데몬 미실행 + `bridgePortInUse: true`면 "다른 데몬이
      브리지를 잡고 있음" 안내가 출력에 포함 (R2)
- [x] T5. `commands/browser.ts` 구현 — `formatBrowserStatus` 입력 확장 + 41777 TCP 프로브
- [x] T16. 같은 파일 — 다른 설치가 브리지를 잡고 있으면 연결 상태를 "없음"이 아니라
      "확인 불가"로 보고 (실측 출력에서 발견한 거짓 단정)

## Phase 2 — 프로필 선택 (R3, R4)

- [x] T6. `src/daemon/browserBridge.test.ts` — 연결 2개 + profile 미지정 → `AMBIGUOUS_PROFILE`,
      에러 메시지에 두 프로필 이름 포함 / 연결 1개일 때는 기존대로 동작 (R3)
- [x] T7. `browserBridge.ts` 구현
- [x] T8. `src/claude/utils/browserTools.test.ts` — `profile`이 params가 아니라 라우팅 인자로
      전달되고, `AMBIGUOUS_PROFILE` 에러가 재시도 방법을 안내 (R3, R4)
- [x] T9. `browserTools.ts` / `startHappyServer.ts` 구현 — 모든 툴에 `profile` 인자

## Phase 3 — 관측 가능성 (R5, R6)

- [x] T10. `packages/happy-browser-extension/src/protocol.test.js` — `tabs_list`가
      `profile`/`windowCount`/`totalTabs`를 함께 반환, `chrome.windows` 없는 환경에서도 실패하지 않음 (R5)
- [x] T11. `protocol.js` 구현 (`tabs_list`, `capabilities`)
- [x] T12. `browserTools.test.ts` — 탭 0건일 때 창 0개 / allowlist 전량 차단을 구분해 안내 (R5)
- [x] T13. `browserTools.test.ts` — `hasRecentAuthFailure`면 재페어링 안내가 붙음 (R6)
- [x] T14. `browserTools.ts` / `browserClient.ts` / `startHappyServer.ts` 구현 — 상태 조회 주입
- [x] T15. 전체 유닛 테스트 + `typecheck` 통과, `context.md` 갱신

## Phase 4 — 셀프 리뷰에서 나온 수정

- [x] T17. `browserBridge.ts` — 지정한 프로필이 없을 때 "연결된 확장 없음" 대신
      실제 연결된 프로필 이름을 알려줌 (거짓 진술 제거)
- [x] T18. `commands/browser.ts` — 데몬은 떠 있는데 브리지 포트를 못 잡은 경우를 보고
      (run.ts가 bind 실패를 debug 로그로만 남기는 침묵 실패)
- [x] T19. `commands/browser.ts` — `bridgePortInUse`를 3-state(참/거짓/미조사)로 바꿔
      조사하지 않은 것을 "포트 사용 중"으로 단정하지 않도록
- [x] T20. `commands/browser.ts` — 중복된 `fetchBridgeStatus` 제거,
      `browserClient.fetchBrowserStatus` 재사용
