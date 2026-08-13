# 계획

## Phase 0 — 선행 보안 조치 ✅ 완료

`aplus-dev-studio` PR #1972 (머지됨). `preview-relay-token` 이 `worktreeId`
없이 호출될 때 포트 소유권 검증이 빠져 임의 포트(= CDP 9222) 토큰이
발급되던 공백을 닫았다.

## Phase 1 — 조사 ✅ 완료

### Q2. 릴레이 토큰 만료가 로그인에 충분한가 → 충분하다

`previewToken.ts` `DEFAULT_TTL_MS = 60 * 60 * 1000` (1시간). 주석에 따르면
Phase 10c 의 HTML 폴백이 만료 시 클라이언트 재발급까지 해준다. 로그인
1회에 1시간은 넉넉하다. **추가 작업 없음.**

### Q3. 어떤 뷰어를 쓸 것인가 → noVNC (CDP DevTools 아님)

결정을 가른 것은 **기존 브리지 명령으로는 로그인을 할 수 없다**는 사실이다.

`protocol.js` 의 `click` / `fill` 은 **ref 기반**이다 — `snapshot` 이 준
참조를 요구하고 좌표를 받지 않는다:

```js
click: async (params, …) => {
    const { frameId, innerRef } = decodeRef(requireParam(params, 'ref'))
```

즉 "스크린샷 띄우고 사용자가 탭한 좌표를 전달"하는 자체 뷰어는 현재
명령 집합으로 불가능하다. 아이디/비밀번호 입력은 ref 로 되지만, **캡차와
2FA 는 정확히 안 되는 쪽**이다 — 그리고 그게 이 기능의 존재 이유다.

따라서 진짜 대화형 화면이 필요하고, 후보는 둘이었다.

| | CDP DevTools | **noVNC** |
|---|---|---|
| 추가 설치 | 없음 | x11vnc, websockify, novnc |
| 주소창 | 없음 | **있음 (진짜 브라우저 UI)** |
| 노출되는 것 | **raw CDP** (쿠키 프로그래밍 접근) | 화면 + 입력 |
| 프록시 난이도 | `ws=` 파라미터·절대 URL 재작성 필요 | 자체 완결형 |
| 릴레이 설계 의도 | — | `apiMachine.ts:97` 이 **noVNC/websockify 를 명시** |

noVNC 를 택한다. 설치 부담이 늘지만 `specs/browser-setup-gui/` 에서 이미
"sudo 없으면 명령을 안내한다"는 정직한 설치 경로를 만들어 뒀으므로 같은
패턴에 패키지 3개를 더하는 한계비용이다. 그 대가로 **CDP 를 아예 노출하지
않고**(AC2/AC3 가 자동으로 쉬워진다) 사용자는 주소창 있는 진짜 브라우저를
얻는다.

### 파생 제약

noVNC 는 화면이 있어야 하므로 Chrome 을 **Xvfb 위 headful** 로 띄워야 한다.
`browser-setup:launch` 는 `DISPLAY` 가 없으면 `--headless=new` 를 쓰므로,
뷰어를 쓸 때는 Xvfb 를 먼저 띄우고 그 `DISPLAY` 로 Chrome 을 기동해야 한다.

## Phase 2 — 머신 측 구현 ✅ 완료

`specs/browser-setup-gui/` 에서 검증된 패턴을 그대로 따른다: 순수 함수 +
TDD → 얇은 부수효과 층 → RPC.

- [x] `daemon/remoteViewer.ts`
  - `planViewerInstall({ missing, canSudo, platform })` — 정직한 설치 판정
  - `buildXvfbArgs`, `buildX11vncArgs`, `buildWebsockifyArgs` — 인자 구성
  - `detectViewerTools()` — 무엇이 설치돼 있나
- [x] RPC: `browser-viewer:status` / `:install` / `:start`
- [ ] `browser-setup:launch` 가 Xvfb `DISPLAY` 를 받아 headful 로 뜨게 (Phase 4 로 이월)

## Phase 3 — 검증 ✅ 완료

- [x] `remoteViewer` 순수 함수 유닛 12개 (변이로 이 확인: `-localhost`,
      `-forever`, websockify loopback 바인드 3건이 정확히 잡힘)
- [x] Ubuntu 컨테이너 E2E **8/8 통과** — 도구가 하나도 없는 상태에서 시작해
      실제 등록된 핸들러로:
      status(3개 누락 보고) → install(실제 apt 설치 성공) → status(설치됨) →
      start(Xvfb+x11vnc+websockify 기동, webPort 응답) →
      `/vnc.html` **200** (웹 루트가 맞다는 증거) →
      **off-loopback 도달 불가** (AC2 의 실질) → 재호출 시 기존 스택 재사용
- [x] 실제 headful Chrome 이 그 화면에 뜨는지 확인:
      `xwininfo` 에 `"Example Domain - Google Chrome" 945x1060` 창 관측

## Phase 4 — 앱 UI + 릴레이 연결 (남음)

- [ ] `browser-setup:launch` 에 `display` 옵션 (뷰어 사용 시 headful 기동)
- [ ] 릴레이 URL 조립 + CDP 와 구분되는 토큰 종류 (AC3)
- [ ] 머신 화면 "브라우저 화면 열기" 버튼 + 위험도 명시 (AC4)


