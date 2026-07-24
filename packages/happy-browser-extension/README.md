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

1. 데몬이 한 번 실행되면 `~/.happy/browser-bridge.token` 이 생성됩니다. 값을 복사합니다.
   ```
   cat ~/.happy/browser-bridge.token
   ```
2. Chrome에서 `chrome://extensions` → **개발자 모드** 켜기 → **압축해제된 확장 프로그램을 로드** →
   이 디렉터리(`packages/happy-browser-extension`)를 선택합니다.
3. 확장의 **옵션** 페이지에서 토큰을 붙여넣고 저장합니다. 포트는 기본 41777.
   Chrome 프로필이 여러 개면 프로필마다 다른 이름을 지정하세요.
4. 연결되면 확장 아이콘에 ● 배지가 표시됩니다.

## 확인

데몬 컨트롤 서버 포트는 `~/.happy/daemon.state.json` 의 `httpPort` 입니다.

```bash
PORT=$(jq -r .httpPort ~/.happy/daemon.state.json)
curl -s localhost:$PORT/browser/status
curl -s localhost:$PORT/browser/request -H 'Content-Type: application/json' -d '{"method":"tabs_list"}'
```

## 현재 지원 명령 (Phase 1)

| method | 결과 |
|--------|------|
| `ping` | `"pong"` |
| `tabs_list` | 열린 탭 목록 (id, url, title, active 등) |

내비게이션·클릭·입력·스냅샷은 Phase 2–3에서 추가됩니다.

## 테스트

```bash
pnpm --filter happy-browser-extension test
```

순수 로직(명령 디스패치, 재접속 백오프)만 유닛 테스트합니다. Chrome API 연동은 실제 브라우저에서 수동 확인합니다.
