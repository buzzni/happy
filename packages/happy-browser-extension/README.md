# Happy Browser Bridge (Chrome Extension)

happy CLI 세션이 **이 머신에 이미 떠 있는, 로그인된 Chrome**을 제어할 수 있게 하는 확장입니다.
mac mini 같은 GUI 머신에서 원격 세션(Claude Code / Codex)이 사용자의 실제 브라우저를 쓰는 것이 목적입니다.

설계: `specs/chrome-extension-bridge/spec.md` (aplus-dev-studio 저장소)

## 구조

```
세션 → happy 데몬 컨트롤 서버 (POST /browser/request)
     → BrowserBridge (happy-cli/src/daemon/browserBridge.ts)
     → WS 127.0.0.1:41777  ← 이 확장의 service worker
     → chrome.tabs 등으로 실제 탭 조작
```

WS는 루프백 전용이며, pairing 토큰이 없는 연결은 데몬이 거부합니다(코드 4401).

## 설치

```bash
happy browser
```

토큰, 연결 상태, 설치 절차를 한 번에 보여줍니다. 토큰만 필요하면 `happy browser token`.

1. 위 명령이 출력한 **pairing 토큰**을 복사합니다
   (파일 경로는 `~/.happy/browser-bridge.token`).
2. Chrome에서 `chrome://extensions` → **개발자 모드** 켜기 → **압축해제된 확장 프로그램을 로드** →
   `happy browser` 가 알려준 폴더를 선택합니다.
   (모노레포에서 개발 중이면 이 디렉터리, `npm i -g @buzzni/happy-cli` 로 설치했다면
   설치된 `browser-extension/` — `happy browser` 가 실제 상황에 맞는 경로를 출력합니다.
   `shipped-files.json` 이 packed 될 파일 목록의 유일한 출처이고,
   `happy-cli/scripts/copy-browser-extension.cjs` 가 그걸 읽어 CLI 패키지에 번들합니다.)
3. 확장의 **옵션** 페이지에서 토큰을 붙여넣고 저장합니다. 포트는 기본 41777.
   Chrome 프로필이 여러 개면 프로필마다 다른 이름을 지정하세요.
   (`happy browser` 가 2번 이후 열 수 있는 **설정 링크**도 함께 출력합니다 —
   `chrome-extension://<고정ID>/src/options.html?token=...&port=...` 를 열면
   토큰 붙여넣기·저장이 자동으로 끝납니다. 확장 ID는 `manifest.json` 의 `key` 로
   고정되어 있어 CLI가 미리 계산할 수 있습니다.)
4. 연결되면 확장 아이콘에 ● 배지(초록)가 표시됩니다.
   에이전트가 명령을 실행하는 동안에는 ▶ (주황)으로 바뀝니다.

### 사이트 allowlist (선택)

옵션 페이지의 allowlist를 비워 두면 **모든 탭**을 제어할 수 있습니다.
한 줄에 하나씩 사이트를 적으면 그 사이트에서만 동작하고, 나머지 탭은
조작은 물론 `tabs_list` 목록에도 나타나지 않습니다.

| 패턴 | 의미 |
|------|------|
| `example.com` | 그 호스트만 (서브도메인 제외) |
| `*.example.com` | 서브도메인 + bare 도메인 |
| `https://example.com` | https 로만 |
| `localhost:3000` | 그 포트만 |

허용되지 않은 탭에 대한 명령은 `SITE_NOT_ALLOWED` 로 거부됩니다.

### 정밀 제어 — 디버거 티어 (선택)

옵션 페이지에서 켤 수 있는 **선택 권한**입니다. 켜면 두 가지가 가능해집니다:

- **trusted 입력** — 실제 사용자 입력과 동일한 `isTrusted` 이벤트.
  스크립트 클릭을 무시하는 사이트나 리치 텍스트 에디터에 필요합니다.
- **전체 페이지 스크린샷** — 화면 밖까지 포함한 캡처.

대가로 조작 대상 탭에 Chrome의 **"디버깅 중" 알림 바**가 뜹니다. 끄면 나머지
기능은 전부 그대로 동작합니다.

이 티어는 **사용자만** 켤 수 있습니다 — 에이전트에겐 확장 설정을 바꾸는 명령이
없기 때문입니다(allowlist와 같은 성질).

한 가지 솔직한 한계: Chrome은 `debugger`를 **선택 권한으로 허용하지 않습니다**
(`optional_permissions` 제외 목록에 있음). 그래서 권한 자체는 설치 시 함께
부여되고, 실제 사용 여부만 이 설정이 통제합니다. 즉 게이트를 지키는 건 브라우저가
아니라 이 확장의 코드입니다. 다만 attach 될 때마다 Chrome이 직접 띄우는
"디버깅 중" 배너가 있어 사용 시점의 가시성은 그대로 확보됩니다.

권한 없이 `fullPage`/`trusted`를 요청하면 **조용히 대체하지 않고**
`DEBUGGER_NOT_AVAILABLE`로 실패합니다. 뷰포트 스크린샷을 전체 페이지인 척
돌려주면 아무도 그 차이를 모르기 때문입니다.

에이전트는 `browser_capabilities`로 현재 가용 여부를 미리 확인할 수 있습니다.

## 배포용 패키징

```bash
pnpm --filter happy-browser-extension package
```

Chrome이 로드하는 파일만 담은 zip을 `dist/` 에 만듭니다 (테스트·dev 스크립트 제외).

## 확인

데몬 컨트롤 서버 포트는 `~/.happy/daemon.state.json` 의 `httpPort` 입니다.

```bash
PORT=$(jq -r .httpPort ~/.happy/daemon.state.json)
curl -s localhost:$PORT/browser/status
curl -s localhost:$PORT/browser/request -H 'Content-Type: application/json' -d '{"method":"tabs_list"}'
```

## 데몬 없이 확인하기 (dev-bridge)

프로덕션 데몬이 세션을 물고 있어 재시작할 수 없을 때 사용합니다.
데몬과 같은 프로토콜을 말하는 독립 브리지라 확장은 실제와 동일하게 붙습니다.

```bash
node packages/happy-browser-extension/scripts/dev-bridge.mjs
```

출력된 토큰을 확장 옵션에 입력하면 연결됩니다(`✓ extension connected`).
이후 프롬프트에 `ping` 또는 `tabs_list` 를 입력하면 응답이 그대로 출력됩니다.

## 현재 지원 명령

| method | params | 결과 |
|--------|--------|------|
| `ping` | — | `"pong"` |
| `tabs_list` | — | 열린 탭 목록 (id, url, title, active 등) |
| `snapshot` | `tabId?` | 인터랙티브 요소 + `@eN` ref, url/title, truncated |
| `screenshot` | `tabId?`, `fullPage?` | `{ mimeType, dataB64 }` (기본은 보이는 영역 PNG) |
| `click` | `ref`, `tabId?`, `trusted?` | `{ ok: true }` |
| `fill` | `ref`, `value`, `tabId?`, `trusted?` | `{ ok: true }` (`value: ""` 로 필드 지우기) |
| `capabilities` | — | `{ debugger, commands }` |
| `navigate` | `url`, `tabId?` | `{ ok: true }` |
| `tabs_open` | `url` | 새 탭 정보 (id, windowId, url) |
| `tabs_close` | `tabId` | `{ ok: true }` |

`tabId` 를 생략하면 활성 탭을 대상으로 합니다. `ref` 는 가장 최근 `snapshot` 이
돌려준 `@eN` 값입니다 — 페이지가 바뀌면(내비게이션 포함) 무효화되므로 그때는
다시 스냅샷을 떠야 합니다. 무효한 ref 로 click/fill 을 호출하면 재스냅샷을
안내하는 메시지와 함께 실패합니다.

### 스냅샷 범위: shadow DOM 과 iframe

- **open shadow root** 내부까지 수집합니다. 웹 컴포넌트의 컨트롤도 보입니다.
  `closed` shadow root 은 브라우저가 `shadowRoot` 자체를 노출하지 않아 접근 불가입니다.
- **모든 iframe** 을 수집합니다(임베드된 에디터·결제 폼 등). 프레임마다 자기
  요소를 `@e1` 부터 번호 매기므로, 메인 프레임 밖 요소는 `@f7:e1` 처럼 프레임
  id 로 한정된 ref 를 받고 `frameUrl` 이 함께 표시됩니다. click/fill 은 그 ref 가
  가리키는 프레임에서만 실행됩니다.
  - 단, iframe 안 요소에는 **`trusted` 입력을 쓸 수 없습니다**. CDP 입력은
    페이지 최상위 좌표를 쓰는데 프레임 내부 좌표와 어긋나기 때문입니다.
    프레임 안에서는 일반 click/fill 을 쓰세요 (`TRUSTED_FRAME_UNSUPPORTED`).

세션 쪽에서는 `mcp__happy__browser_tabs` / `browser_snapshot` /
`browser_screenshot` / `browser_click` / `browser_fill` / `browser_navigate` /
`browser_open_tab` / `browser_close_tab` / `browser_capabilities` 도구로 노출됩니다.

## 테스트

```bash
pnpm --filter happy-browser-extension test
```

순수 로직(명령 디스패치, 재접속 백오프)만 유닛 테스트합니다. Chrome API 연동은 실제 브라우저에서 수동 확인합니다.
