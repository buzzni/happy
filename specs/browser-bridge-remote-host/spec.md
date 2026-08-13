# 브라우저 브리지 — 원격 호스트(사용자 자기 컴퓨터) 연결 지원 Spec

> 작성일: 2026-08-13 / 상태: R1~R5 구현 완료
> ⚠️ 승인 후에는 사용자 지시 없이 수정 금지

## 목표

CLI/데몬이 도는 머신과 Chrome이 도는 머신이 **다른** 경우를 지원한다.
지금까지 다룬 `browser-bridge-headless-linux`는 같은 머신(Ubuntu)에 CLI와
Chrome을 함께 두는 시나리오였다. 이번은 **사용자 자신의 PC**에서 이미 로그인된
Chrome을 그대로 두고, 원격 서버의 happy 세션이 그걸 조종하는 시나리오다.

## 배경 — 코드 실측

두 지점이 loopback에 고정돼 있어 지금은 원리적으로 불가능하다.

1. `connection.js:72` — 확장이 접속할 주소가 `ws://127.0.0.1:${port}`로
   **하드코딩**. 옵션 페이지에 뭘 입력해도 확장은 항상 자기 자신의 loopback만 본다.
2. `browserBridgeServer.ts:18` — `startBrowserBridgeServer`의 `host` 파라미터는
   있지만, `run.ts:1424`가 항상 기본값(`127.0.0.1`)으로 호출해 노출할 CLI/env
   경로가 없다.

인증은 이미 토큰 기반이다 (`browserBridge.ts:69` `handleConnection`). 지금은
loopback에서만 동작하므로 `!==` 평문 비교로 충분했지만, 인터넷에 노출되면
**토큰이 유일한 방어선**이 되므로 타이밍 사이드채널을 없애야 한다.

## 요구사항

### R1. 확장이 host를 설정할 수 있어야 한다

- `connection.js`가 저장된 `host`(기본 `127.0.0.1`)로 접속 URL을 만든다.
- `options.js`에 host 입력 필드를 추가한다.
- `autoConnect.js`가 `&host=`를 해석한다. 없으면 기존처럼 `127.0.0.1`.

### R2. 데몬이 loopback 아닌 주소에 바인드할 수 있어야 한다

- `run.ts`가 `HAPPY_BROWSER_BRIDGE_HOST` 환경변수를 읽어 `startBrowserBridgeServer`에
  넘긴다. 미설정 시 기존과 동일하게 `127.0.0.1`.
- 기존 `HAPPY_APLUS_MCP_CONFIG_URL` 등과 같은 패턴 — `happy daemon start`가
  `process.env`를 그대로 자식 프로세스에 넘기므로 CLI 플래그 없이 동작한다.

### R3. `happy browser`가 원격 페어링용 링크를 만들 수 있어야 한다

- `HAPPY_BROWSER_BRIDGE_PUBLIC_HOST` 환경변수가 설정되면, 출력하는
  auto-connect 링크에 `&host=`를 포함한다. NAT/포트포워딩 뒤에서는 바인드
  주소(`0.0.0.0`)와 사용자가 실제로 접속할 주소(공인 IP/도메인)가 다를 수
  있으므로 별도 변수로 분리한다.
- 바인드 주소가 loopback이 아니면 **경고**를 출력한다: 평문 WS이고 토큰이
  유일한 방어선이라는 사실.
- 사용자는 이 링크를 **자신의 PC**에서(이미 설치된 확장의 옵션 페이지에)
  직접 열거나 값을 붙여넣는다 — CDP로 원격 PC를 열 방법은 없으므로
  `happy browser pair`(같은 머신 전제)와는 별개 경로다.

### R4. 토큰 비교를 타이밍 안전하게 만든다

- `browserBridge.ts`의 `params.token !== this.authToken`을
  `crypto.timingSafeEqual` 기반으로 바꾼다.
- 길이가 다르면 즉시 거부(길이 노출은 감수 — 토큰은 고정 64자 hex).

### R5. 문서

- `docs/browser-bridge-headless.md`에 "원격 PC의 브라우저에 연결" 절 추가.

## 비목표

- TLS/WSS 종단 — 스코프 밖. 문서에 리버스 프록시(Caddy/nginx)나 SSH 터널
  대안을 언급하되, CLI가 인증서를 발급/관리하지는 않는다.
- 여러 사용자를 위한 토큰 로테이션·다중 토큰 — 기존과 동일하게 머신당 토큰 1개.
- 데몬이 자동으로 공인 IP를 감지하는 것 — 사용자가 명시.
