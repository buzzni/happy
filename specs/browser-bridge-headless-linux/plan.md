# 구현 계획

각 Phase는 독립 커밋. 모두 동작 변경이며, 선행 구조 변경은 없다.

## Phase 1 — R1: auto-connect 링크의 debugger 파라미터

- 🔴 `autoConnect.test.js`: `debugger=1` → `{debuggerTier: true}`,
  `debugger=0` → `false`, 미지정 → 키 자체가 없음
- 🟢 `autoConnect.js`에 파싱 추가
- 🟢 `options.js`가 값이 있을 때만 `chrome.storage.local.set`
- 검증: `npx vitest run src/autoConnect.test.js`

## Phase 2 — R2: 포커스 없는 창의 활성 탭 폴백

- 🔴 `protocol.test.js`: `lastFocusedWindow` 조회가 빈 배열이고
  `{active:true}`가 탭을 반환하면 그 탭으로 동작
- 🟢 `resolveTab`에 폴백 추가
- 검증: `npx vitest run src/protocol.test.js`

## Phase 3 — R3: viewport 스크린샷 CDP 폴백

- 🔴 `protocol.test.js`: `captureVisibleTab` 실패 + tier ON → CDP 결과 반환 /
  tier OFF → 원래 에러 전파
- 🟢 `cdp.js`에 `captureViewport` 추가, `protocol.js` screenshot 핸들러 수정
- 검증: `npx vitest run`

## Phase 4 — R4: `happy browser pair`

- 🔴 `browserPair.test.ts`: URL 조립, CDP 실패/확장 미연결 분기 메시지
- 🟢 `commands/browserPair.ts` 신규 + `browser.ts` 라우팅
- 검증: `yarn vitest run src/commands/` + `tsc --noEmit`

## Phase 5 — R5: 문서

- `docs/browser-bridge-headless.md`
- `happy browser help`에 `pair` 노출

## 파일 배치 선언

수정 5개 / 신규 4개.

- 신규 `src/commands/browserPair.ts` — CDP HTTP로 Chrome에 페어링 탭을 여는
  책임. `browser.ts`는 상태 출력이 책임이라 섞지 않는다.
- 신규 `src/commands/browserPair.test.ts` — 위의 테스트.
- 신규 `docs/browser-bridge-headless.md` — Linux 기동 절차.
- 신규 `specs/browser-bridge-headless-linux/*` — spec/plan/context.
