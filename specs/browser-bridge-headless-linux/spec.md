# 브라우저 브리지 — 터미널 전용 Linux 머신 지원 Spec

> 작성일: 2026-08-13 / 상태: 진행 중
> ⚠️ 승인 후에는 사용자 지시 없이 수정 금지

## 목표

Chrome 확장 브리지를 **GUI가 없고 SSH 터미널로만 접속하는 Ubuntu 머신**에서
쓸 수 있게 한다. 현재는 페어링·권한 토글·스크린샷·탭 선택 네 지점이
"사람이 화면 앞에 앉아 있다"는 전제에 묶여 있다.

## 배경 — 코드 실측

`packages/happy-browser-extension` / `packages/happy-cli`를 읽어 확인한 사실:

| 지점 | 현재 동작 | headless에서의 결과 |
|---|---|---|
| 페어링 | `options.js:46-55` — `?token=&port=` 링크가 `save()` 자동 호출 | ✅ **이미 무클릭.** CDP로 URL만 열면 끝 |
| `debuggerTier` | `options.js:75` 버튼 클릭이 **유일한 writer** | ❌ 클릭할 사람이 없음 → 정밀 제어 영구 불가 |
| 스크린샷 | `protocol.js:229` `chrome.tabs.captureVisibleTab` | ⚠️ 보이는 창 표면이 필요 — 실패 시 대안 없음 |
| 탭 선택 | `protocol.js:66` `{active:true, lastFocusedWindow:true}` | ❌ WM 없는 Xvfb는 포커스 개념 부재 → `NO_ACTIVE_TAB` |
| CLI 안내 | `browser.ts:136-144` `chrome://extensions` 수동 클릭 안내 | ❌ headless 경로에 대한 안내가 전무 |

`cdp.js:16-21` 주석은 `debuggerTier`가 스토어 설정인 이유를 명시한다 —
Chrome이 `debugger`를 `optional_permissions`에 허용하지 않기 때문이고,
지켜야 할 보안 속성은 **"에이전트가 스스로 켜지 못한다"**이다.

## 요구사항

### R1. auto-connect 링크로 debugger tier를 켤 수 있어야 한다

- `parseAutoConnectParams`가 `debugger` 쿼리 파라미터를 해석한다.
- 파라미터가 **없으면 기존 저장값을 건드리지 않는다** (끄지도 켜지도 않음).
- 명시적으로 주어진 경우에만 `debuggerTier`를 그 값으로 저장한다.
- 옵션 페이지는 자동 연결 후 어느 상태가 됐는지 문구로 밝힌다.

**보안 근거:** R1은 `cdp.js`가 지키려는 속성을 깨지 않는다. 에이전트에게는
확장 스토리지를 쓰는 프로토콜 명령이 여전히 없다. 이 링크는 사용자가
터미널에서 스스로 실행한 결과물이며, `options.js:44-45`가 이미 auto-connect
링크를 "사용자가 붙여넣은 것과 같은 수준의 의도"로 규정하고 있다.

### R2. 포커스된 창이 없어도 활성 탭을 찾아야 한다

- `lastFocusedWindow`로 못 찾으면 `{active: true}` 전역 조회로 폴백한다.
- 그래도 없으면 기존과 같이 `NO_ACTIVE_TAB`.
- 폴백이 여러 창에서 여러 활성 탭을 반환하면 첫 번째를 쓴다 (창이 하나뿐인
  headless가 실제 대상이며, 임의 선택이 아니라 "포커스 정보가 없다"는
  상황에서의 유일한 선택지).

### R3. viewport 스크린샷에 CDP 폴백이 있어야 한다

- `captureVisibleTab`이 실패했고 debugger tier가 켜져 있으면
  CDP `Page.captureScreenshot`(viewport 범위)로 재시도한다.
- debugger tier가 꺼져 있으면 **원래 실패를 그대로 올린다** — 조용한 성공 위장 금지.
- `fullPage: true` 경로는 변경하지 않는다 (이미 CDP 전용).

### R4. 터미널만으로 페어링을 끝낼 수 있어야 한다

- `happy browser pair` 명령을 추가한다.
- Chrome의 `--remote-debugging-port`에 붙어 auto-connect 페이지를 열고,
  확장이 실제로 붙었는지 데몬 상태로 확인한다.
- `--debugger` 플래그로 R1의 정밀 제어를 함께 켠다.
- 실패 시 무엇이 잘못됐는지 구분해서 알린다: CDP 미도달 / 확장 미로드 / 미연결.

### R5. Linux headless 기동 절차가 문서로 있어야 한다

- `--load-extension`은 `--disable-extensions-except`와 짝으로 써야 함
- 구형 `--headless`는 확장 미지원 → `--headless=new` 또는 Xvfb + headful
- `--user-data-dir` 프로필을 보존해야 로그인 세션이 유지된다는 점
- 최초 1회 로그인은 SSH 터널로 CDP를 포워딩해 로컬에서 처리

## 비목표

- 로그인 자동화 (2FA·캡차 때문에 원리적으로 불가)
- Chrome 자동 설치/기동을 happy가 떠맡는 것 — 문서와 `pair` 명령까지만
- `chrome.tabs.captureVisibleTab`을 CDP로 전면 대체하는 것
