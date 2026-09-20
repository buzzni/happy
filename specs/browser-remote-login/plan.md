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

## 후속 수정 — viewer Chrome 브리지 자동 페어링 (2026-08-23)

원격 화면에서 Gmail에 로그인해도 Saycode 세션의 browser tool은
`No Chrome extension is connected`를 반환했다. viewer 경로가 Xvfb/noVNC와 Chrome만
보장하고, 확장 주입·token 저장·WebSocket 연결을 담당하는 `runPairing`은 수동
`browser-setup:pair`에만 연결돼 있었기 때문이다.

`browser-viewer:start`가 신규/재사용 viewer Chrome의 정확한 CDP port로 기존
`runPairing`을 호출하게 했다. browser 준비와 bridge 준비 결과를 분리해 페어링 실패가
noVNC 복구 화면 자체를 숨기지 않게 했다. 또한 `/proc`의 정확한 NUL 구분 cmdline과
DISPLAY를 확인해 headless Chrome을 viewer Chrome으로 성공 오인하지 않는다. pairing
URL은 사용자 프로필 이름을 바꾸지 않고 실행별 고유 `pairingId`를 전달하며, bridge가
같은 marker의 연결을 보고해야 성공한다. 따라서 확장이 이미 로드된 viewer 앞에서
unrelated 프로필만 연결되거나 대기 중 새 bystander가 도착해도 성공 또는 조기 실패로
오인하지 않는다.

검증: viewer API/browser setup/remote viewer/browser pair focused 68개, browser extension
전체 187개, CLI typecheck와 package build 통과. 현재 실행 환경의 OrbStack 및
`walter-gpu` 직접 접속 timeout으로 Linux 실기 E2E는 릴리스 후 머신 검증으로 이월했다.

2026-08-24 셀프 리뷰에서 사용자 프로필명 덮어쓰기와 bystander 조기 종료를 위의
고유 marker 방식으로 수정했다. browser extension 188개와 CLI 관련 163개 테스트,
CLI typecheck/build, staged artifact guard/install smoke가 통과했다.

같은 날 2차 리뷰에서 구버전 확장이 이미 보이는 viewer Chrome은 최신 marker
프로토콜로 갱신되지 않는 업그레이드 결함을 수정했다. marker 페어링에 한해 현재 CLI의
unpacked extension을 다시 로드하며 일반 수동 페어링의 기존 fast path는 보존한다.
확장 188개, CLI 관련 168개 테스트와 CLI typecheck/build, staged artifact
guard/install smoke가 통과했다.

3차 리뷰에서는 기존 확장이 보여도 최신 번들 갱신이 실패한 target-marker 오류가 실제
원인을 숨기던 진단 누락을 수정했다. 실패 메시지가 Chrome 재기동에 필요한
`--enable-unsafe-extension-debugging` 플래그를 직접 안내한다.
Happy CLI 관련 169개 테스트와 typecheck/build가 통과했다.

## 2026-09-14 — 원격 화면의 절반이 검게 남던 문제

사용자 보고: noVNC 화면이 열리기는 하는데 "화면의 반 밖에 사용을 못 한다".

원인은 세 가지가 겹친 것이다. 뷰어 디스플레이에는 **window manager 가 없고**,
Chrome 은 `--window-size` 없이 떠서 **자기 기본 창 크기**를 쓰며, 그 창을
나중에 최대화하거나 끌어서 늘려 줄 주체가 아무도 없다. 즉 기동 시점의 크기가
그대로 최종 크기다.

prod 체험 머신(`saycode-trial-machines-prod` / `80e999da010d28`)에서 실측:

| 대상 | 창 bounds | 화면 |
|---|---|---|
| 사용자의 뷰어 Chromium (현행) | `945x1060 @ (10,10)` | `1920x1080` |
| 같은 이미지, `--window-position=0,0 --window-size=1920,1080` | `1919x1079 @ (0,0)` | `1920x1080` |
| 같은 이미지, 플래그 없음 (대조군) | `945x1060 @ (10,10)` | `1920x1080` |

측정은 X11 유틸이 이미지에 없어 Chrome 자신의 CDP `Browser.getWindowForTarget`
으로 했다. 대조군이 사용자 값과 정확히 일치하므로 플래그가 원인을 바꾼 것이
맞다. 실험은 사용자의 `:99` 를 건드리지 않도록 별도 `:121` 디스플레이와 별도
프로필에서 돌리고 전부 정리했다.

수정: 화면 크기를 `remoteViewer.ts` 의 `VIEWER_SCREEN` 한 곳에 두고 Xvfb 와
Chrome 창이 같은 값을 읽는다. 창 크기는 **우리가 소유한 디스플레이에만** 건다 —
데스크톱의 실제 DISPLAY 로 뜨는 Chrome 의 창 배치는 그 사용자 것이다.
`--window-position=0,0` 을 같이 주는 이유는 Chrome 이 프로필에 저장된 이전
창 위치를 복원하기 때문이다(현행 값이 `(10,10)` 인 것이 그 흔적).

한계: 이미 떠 있는 뷰어 Chrome 은 재사용되므로 이 플래그가 소급 적용되지
않는다. 머신이 재시작돼 Chrome 이 새로 뜰 때부터 반영된다.

검증: buildChromeLaunchArgs/VIEWER_SCREEN 신규 테스트 4개(수정 전 3개 red),
viewer·browser 관련 10개 파일 189개 통과, CLI typecheck/build 통과.

## 2026-09-19 — 창을 꽉 채우지 못하고 붙여넣기가 안 되던 문제

사용자 보고 두 가지. ① 원격 화면이 브라우저를 채우지 못한다(오른쪽이 잘리고
위아래가 검다). ② 로컬에서 복사한 값을 화면 안에 붙여넣을 수 없다.

### 원인

| 증상 | 원인 |
|---|---|
| 잘림 + 검은 띠 | noVNC 의 `resize` 기본값이 `off` 라 1920x1080 을 원본 크기로 그린다. 뷰어 창이 그보다 좁으면 잘리고, 낮으면 레터박스가 된다 |
| ⌘V/Ctrl+V 무반응 | noVNC 가 캔버스의 모든 keydown 에 `preventDefault()` 를 건다(`core/input/keyboard.js` 의 `stopEvent`). 브라우저가 `paste` 이벤트를 아예 만들지 않는다. macOS 에서는 Meta 가 Alt 로 매핑돼 원격에 Ctrl+V 가 가지도 않는다 |

둘 다 URL 파라미터로는 못 고친다 — 사용자는 `/vnc.html` 링크를 그대로
북마크하거나 붙여 넣는다.

### 결정 1 — 정확히 채우려면 서버를 바꿔야 한다

x11vnc 소스에는 `setDesktopSizeHook` 자체가 없다(`src/screen.c`, `src/xrandr.c`
확인). 즉 클라이언트가 `SetDesktopSize` 를 보내도 조용히 무시된다 — `resize=remote`
를 켜 봐야 잘린 화면 그대로다. TigerVNC 의 `Xvnc` 는 이 요청을 받으므로
Xvfb+x11vnc 쌍을 Xvnc 하나로 대체한다.

화면만 리사이즈해서는 부족하다. 이 디스플레이에는 WM 이 없고 Chrome 창 크기는
기동 시점이 최종이라(2026-09-14 실측), 화면만 커지면 브라우저가 그 일부만
덮는다 — 스케일보다 나쁘다. openbox 를 함께 띄우는 이유는 하나다:
`screen_resize()` 가 RandR 변경 때 모든 클라이언트를 `client_reconfigure()` 로
다시 맞춘다(openbox `screen.c` 확인). rc.xml 로 모든 창을 maximized·decor 없음
으로 강제해 브라우저가 화면을 정확히 덮게 한다.

따라서 `selectViewerBackend` 는 **Xvnc 와 WM 이 둘 다 있을 때만** `remote` 를
고르고, 하나라도 없으면 `scale` 로 내려간다. 이미 도는 Xvfb/x11vnc 머신은
계속 동작한다(잘림 없이 축소).

### 결정 2 — 페이지를 우리가 서빙한다

`/usr/share/novnc` 를 쓰기 가능한 디렉터리로 미러링한다(자산은 전부 symlink,
페이지만 우리 것). 페이지는 ① `resize` 기본값을 백엔드가 실제로 지원하는
값으로 seed 하고(사용자가 설정 패널에서 고른 값은 덮지 않는다) ② 브리지
모듈을 로드한다.

브리지는 noVNC 의 `RFB` 객체를 **noVNC 자신이 import 하는 모듈 URL 을 그대로
import** 해서 얻는다 — ES 모듈은 URL 당 싱글턴이라 같은 `UI` 객체다. noVNC 를
포크하거나 vendor 트리를 패치하지 않는다.

붙여넣기 경로: window capture 단계에서 ⌘V/Ctrl+V 를 가로채
(`stopImmediatePropagation` 으로 noVNC 의 preventDefault 를 앞지른다) 숨긴
textarea 에 포커스를 준다 → 브라우저가 native `paste` 를 그 textarea 에 쏜다 →
`clipboardPasteFrom()` 으로 원격 클립보드를 채우고 원격에 Ctrl+V 키를 합성한
뒤 포커스를 화면에 돌려준다. 권한 팝업(`navigator.clipboard.readText`)이
필요 없는 경로다. 반대 방향(원격→로컬)은 `clipboard` 이벤트를
`navigator.clipboard.writeText` 로 넘기되 거부되면 사유를 로그한다.

### 실기에서 배운 것 두 가지 (설계를 바꿨다)

**① 숨긴 textarea 에 포커스를 주는 붙여넣기 경로는 Chrome 에서 동작하지 않는다.**
처음 구현은 keydown 을 가로채 숨긴 textarea 에 포커스를 주고 브라우저의 native
`paste` 를 받는 방식이었다. 컨테이너 실기에서 `paste` 이벤트가 **아예 발생하지
않았다** — Chrome 은 단축키를 처리하는 시점의 포커스 대상을 기준으로 붙여넣기를
정하고, 캔버스는 편집 가능한 요소가 아니라 붙여넣을 곳이 없다고 본다. 그래서
`navigator.clipboard.readText()` 를 1순위로 쓰고, 거부되거나 없는 브라우저에서만
textarea 경로로 내려간다. (Chrome 은 첫 붙여넣기에서 클립보드 읽기 권한을 한 번
묻는다.)

**② TigerVNC 는 vncconfig 없이는 X 클립보드를 소유하지 않는다.**
`clipboardPasteFrom` 이 실제로 호출되고 RFB 로도 나갔는데 원격에는 아무것도
붙지 않았다. 원인은 Xvnc 가 클립보드를 X 로 넘기는 일을 자기 안에서 하지 않고
`vncconfig` 헬퍼에 맡기기 때문이다. 확인:

| 상태 | `xclip -o -selection clipboard` |
|---|---|
| vncconfig 없음 | selection 소유자 자체가 없음 (`target TARGETS not available`) |
| `vncconfig -nowin` 실행 | 텍스트가 그대로 나옴, targets 에 `UTF8_STRING` 포함 |

그래서 Xvnc 백엔드에는 `vncconfig -nowin` 을 함께 띄운다. 없으면 화면은
멀쩡한데 붙여넣기만 조용히 안 되므로, 바이너리가 없을 때는 그 사실을 로그로
남긴다.

### 검증

- 유닛: `viewerWebRoot` 31개(신규), `remoteViewer` 51개, viewer API 37개 —
  관련 8파일 179개 통과 + CLI 빌드(`tsc --noEmit`) 통과. 3라운드에서
  **스택 기동 시퀀스 자체**에 처음으로 테스트를 붙였다(그전까지 모든 테스트가
  재사용 경로만 탔다): 슬롯 포트를 테스트가 직접 listen 해 readiness 대기를
  즉시 끝내고, Xvnc·vncconfig·openbox 가 뜨는지와 서빙되는 페이지의 resize
  모드를 확인한다.
- 뮤테이션 11건 전부 kill (셀프 리뷰 2라운드 포함): capture 플래그 /
  `stopImmediatePropagation` / paste 후 포커스 복구 / `index.html` 미패치 /
  도구 누락 시 start 차단 / Xvnc 드레인 인식 / 비라틴 자판 폴백 / 사용 중
  미러 보존 / install 이 업그레이드까지 설치 / 프롬프트 중 중복 붙여넣기 방지 /
  동기 throw 후 상태 복구. 마지막 항목은 1차 시도에서 가짜 통과가 나와
  (가짜 객체가 프롬프트 승인 시 대기 중 read 를 전부 풀어주지 않았다)
  테스트를 고친 뒤 kill 을 확인했다.
- **컨테이너 실기** (debian bookworm + tigervnc-standalone-server·openbox·
  websockify·novnc, 실제 daemon 모듈을 Node 24 타입 스트리핑으로 그대로 실행,
  호스트의 진짜 Chrome 이 클라이언트):

  | 확인 | 결과 |
  |---|---|
  | 백엔드 판정 | Xvnc + openbox 감지 → `resizeMode: 'remote'` |
  | 페이지 seed | `localStorage.resize === 'remote'` |
  | 원격 해상도 | 1920x1080 → **1100x820** (뷰어 뷰포트와 동일) |
  | 창 재맞춤 | openbox 가 창을 **1100x820+0+0** 으로, 장식 없이 |
  | 붙여넣기 | ⌘V/Ctrl+V → 원격 X CLIPBOARD 에 그대로, `UTF8_STRING` 포함 |
  | 한글 | `붙여넣기 한글 테스트 42` 왕복 성공 |

  주의: TigerVNC 의 확장 클립보드는 **지연 전송**이라 뷰어가 연결돼 있는 동안만
  selection 이 유효하다. 연결을 끊은 뒤 조회하면 비어 보이는 것이 정상이다.

- **비-root 실기**: 체험 머신은 `trial`(uid 10001) 로 돌기 때문에 같은 스택을
  비특권 사용자로 다시 확인했다 — Xvnc 가 `/tmp/.X11-unix` 를 직접 만들고
  루프백만 바인드하며(대조군: `-localhost` 없이는 0.0.0.0), openbox·vncconfig
  도 그대로 뜬다.

### 알려진 한계

- 이미 떠 있는 뷰어 스택은 재사용되므로 새 web root 와 Xvnc 로 **소급 전환되지
  않는다**. 스택이 죽거나 머신이 재시작한 뒤부터 적용된다.
- x11vnc 백엔드의 클립보드는 RFB 표준 ClientCutText 라 Latin-1 만 전달된다 —
  noVNC 가 0xff 를 넘는 코드포인트를 `?` 로 치환한다(core/rfb.js). 한글
  붙여넣기가 온전한 것은 확장 클립보드를 쓰는 Xvnc 백엔드뿐이다. 레거시
  머신에서 ASCII 붙여넣기는 실기로 확인했다(`legacy-ascii-42` 왕복).
