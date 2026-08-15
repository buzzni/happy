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

## Phase 4 — 앱 UI + 릴레이 연결 ✅ 완료

- [x] `browser-setup:launch` 에 `viewer` 옵션 — 뷰어 스택(없으면 자동
      기동)의 Xvfb 디스플레이에 headful 로 합류 (컨테이너 E2E 5/5)
- [x] 릴레이 URL 조립 + CDP 와 구분되는 토큰 종류 (AC3) —
      `aplus-dev-studio` `mintBrowserViewerToken` (machine 소유권 기반,
      project 포트 소유권 로직과 완전 분리)
- [x] 머신 화면 "원격 브라우저 화면 열기" 버튼 + 위험도 명시 (AC4) —
      `aplus-dev-studio` `MachineDashboard.tsx`

Phase 4b(릴레이+UI)는 web-ui 쪽이라 `aplus-dev-studio` 저장소에서
구현했다: `mintBrowserViewerToken.ts`, `browserViewerRelayResponse.ts`,
`useOpenBrowserViewer.ts`, `POST /api/machines/:id/browser-viewer/{install,open}`.

2026-08-13 사용자 결정: 회사 공유 머신에서 소유자가 아닌 회사 멤버도
원격 화면을 열 수 있다(preview-token-trusted 와 같은 패턴).

## 후속 수정 — 뷰어 스택 liveness (2026-08-14)

리뷰에서 `startViewerStack` 이 캐시(`this.viewer`)를 확인 없이 신뢰하던
결함 2건을 찾아 고쳤다. 캐시는 대입만 되고 해제되지 않았다.

- **죽은 캐시**: 스택이 죽어도 `ready: true` 를 계속 반환해 죽은 포트로
  릴레이 토큰이 발급됐고, 재시도해도 같은 포트라 데몬 재시작 전까지
  복구 불가였다.
- **재시작 후 중복 기동**: 스택은 detached 라 데몬보다 오래 산다. 재시작
  뒤 캐시는 비었는데 프로세스는 살아 있어 다음 클릭이 새 스택을 또
  띄웠다. 재시작 몇 번이면 후보 포트가 소진돼 기능이 멈춘다.

`decideViewerStackAction` 순수 함수로 분리(reuse / adopt / start)하고,
`isViewerServing` 이 "무언가 listen 중"이 아니라 **`/vnc.html` 200** 을
확인한다 — 6080 을 쓰는 무관한 서비스를 사용자 화면으로 넘기면 안 된다.

채택한 스택의 `vncPort` 는 알 수 없으므로 `null` 로 둔다(산술로 지어내면
args 빌더가 약속하지 않은 결합을 만든다).

검증: 유닛 68개 통과(변이로 이 확인 — 캐시를 그대로 신뢰하도록 되돌리면
해당 2건이 실패). 컨테이너 E2E **6/6**: 기동 → 스택 kill → 죽은 것 확인 →
재기동되고 `/vnc.html` 200 → 새 클라이언트(재시작 모사)가 기존 스택을
채택(`reused: true`) → 뷰어 포트 listener 가 여전히 1개.

## 후속 수정 — 검은 화면 (2026-08-15)

dev 에서 릴레이 URL 을 열면 noVNC 는 뜨는데 **화면이 검게** 나왔다.

원인: `browser-viewer/open` 라우트가 `status → start → mint` 만 호출하고
**Chrome 을 띄우는 경로를 전혀 부르지 않았다**. Xvfb 는 그 자체로 아무것도
그리지 않으므로 빈 디스플레이가 그대로 보인 것이다. Phase 4a 에서 만든
`browser-setup:launch({ viewer: true })` 가 UI 에서 호출되지 않아 고아로
남아 있었다.

`startViewerStack` 이 세 경로(신규 기동 / 재사용 / 채택) 모두에서
`ensureViewerBrowser(display)` 를 거치게 했다. 브라우저 존재 여부는
캐시가 아니라 CDP 포트 프로브로 판정한다 — 데몬보다 오래 산 Chrome 을
채택해야 클릭할 때마다 같은 디스플레이에 Chrome 이 한 대씩 쌓이지 않는다.

검증: 유닛 71개. 컨테이너 E2E 4/4 — 스택 기동 후 `xwininfo` 에 Chrome
창이 실제로 존재하고, 재호출해도 Chrome 프로세스 수가 늘지 않는다.

## 후속 수정 — profile launch 소유권 (2026-08-15)

검은 화면 수정 뒤 `browser-setup:launch({ viewer: true })`도 viewer stack을 준비하는
과정에서 기본 profile Chrome을 먼저 실행했다. 호출자가 이미 선택 profile을 실행할
예정인데 viewer가 같은 free CDP port를 선점해, 비기본 profile 요청이 기본 profile에
연결된 것처럼 성공할 수 있었다.

viewer를 직접 여는 경로는 계속 기본 browser를 보장하되, profile launch 호출자는
`callerWillLaunchBrowser` ownership을 전달해 선행 browser 실행을 생략한다. 순수 결정
test가 defer/launch/reuse 세 경우를 고정하며 browser setup/viewer 유닛 38개와 CLI
typecheck/package build가 통과했다.
