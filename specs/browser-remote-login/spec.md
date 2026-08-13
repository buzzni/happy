# 원격 브라우저 로그인 접속

## 문제

`specs/browser-setup-gui/`로 Chrome 설치·기동·페어링은 버튼이 됐지만,
**로그인은 여전히 SSH 터널이 필요하다**:

```bash
ssh -L 9222:127.0.0.1:9222 user@ubuntu-host
# 그다음 로컬 chrome://inspect 에서 원격 탭 inspect
```

2FA·캡차·새 기기 확인 때문에 자동화가 불가능하므로, 사람이 그 브라우저
화면을 실제로 봐야 한다. 목표는 이 과정을 앱 안에서 끝내는 것이다.

## 조사 결과 — 배관은 이미 다 있다

| 구성요소 | 위치 | 비고 |
|---|---|---|
| HTTP 프록시 | `daemon/previewProxy.ts` | `127.0.0.1:{port}` 중계 |
| WS 터널 | `daemon/previewWsProxy.ts` | 포트 1024–65535, **주석에 noVNC/websockify가 용도로 명시됨** |
| 릴레이 라우트 | happy-server `/v1/preview/:machineId/:port/*` | |
| 인증 | `previewToken.ts` | `(userId, machineId, port)` 를 HMAC-SHA256 서명, 만료 있음 |
| 자격증명 투과 | `specs/preview-relay-credential-passthrough/` | Cookie/Authorization 왕복 검증 완료 |

CDP는 HTTP + WebSocket 조합이고 Chrome이 DevTools 프론트엔드를 자기
자신에게서 서빙한다. 즉 **별도 뷰어를 만들 필요 없이** 이 릴레이로 CDP를
중계하면 DevTools의 inspect 화면(스크린캐스트 + 입력 전달)을 그대로 쓴다.

## 핵심 발견 — 이 노출은 새로 생기는 게 아니다

`parsePreviewHost`는 포트를 **1–65535 전체**로 받고, WS 프록시도
1024–65535다. 특정 포트 화이트리스트가 없다.

따라서 **오늘도 이미**, 해당 머신에 대해 preview token을 받을 수 있는
사용자는 `9222` 포트를 지정해 CDP에 도달할 수 있다. 이 기능이 추가하는
것은 새로운 권한이 아니라 **발견 가능성(UI에 버튼으로 노출)**이다.

이건 기능을 정당화하는 근거가 아니라 **먼저 확인해야 할 기존 노출**이다.
아래 미해결 질문 참조.

## 보안 — CDP는 preview 와 위험도가 다르다

같은 릴레이를 타더라도 대상이 다르다:

- preview 대상 = 사용자가 띄운 **dev server**
- CDP 대상 = 사용자의 **로그인 세션을 담은 브라우저**

CDP 접근은 쿠키 전량 열람, 임의 사이트 방문, 세션 탈취가 가능하다.
브라우저 브리지가 `click`/`fill`/`screenshot` 같은 **정의된 명령 집합**으로
제한되는 것과 달리 CDP에는 상한이 없다.

또한 `specs/browser-setup-gui/`에서 확인했듯 브리지는 이미
"그 데몬에 닿는 세션은 모든 프로필을 조종 가능"한 구조다. CDP 노출은
그보다 한 단계 더 강하다.

## ⚠️ 질문 1 답변 — 임의 포트 발급이 이미 가능하다 (코드 확인)

**이 기능과 무관하게 선행 처리해야 할 사안이다.**

web-ui 의 preview token 발급 경로에서 **포트는 클라이언트가 지정**하고,
소유권 검증은 **`worktreeId` 가 함께 올 때만** 수행된다:

```
server/appRoutes.ts:9790  const portRaw = url.searchParams.get('port')   // 클라이언트 입력
server/appRoutes.ts:9800  if (relayWorktreeId) {                          // ← 조건부
                              ownsPort = record.devServerPort === port || …
                              // worktreeId 가 없으면 이 검증 자체를 건너뛴다
```

그 뒤 happy-server `/v1/preview-token-trusted` 는 포트를 `1–65535` 로만
검사하고 machine 소유권 매칭을 **의도적으로 skip** 한다(회사 공유 머신
viewer 접근을 위한 설계). 릴레이(`parsePreviewHost`)와 WS 프록시도
포트 화이트리스트가 없다.

**귀결**: 어떤 프로젝트에 접근 권한이 있는 사용자는 `?port=9222` 를 지정해
그 머신의 CDP 에 도달하는 토큰을 받을 수 있다. 그 머신에서 누군가
로그인된 Chrome 을 띄워 두었다면 쿠키 전량 열람과 세션 탈취가 가능하다.

### 검증 수준 (정직하게)

- **코드 경로로 확인**: 포트가 클라이언트 입력이고, 소유권 검증이
  `worktreeId` 조건부이며, 상·하류 어디에도 포트 제한이 없다.
- **미확인**: 실제로 토큰을 발급받아 CDP 에 도달하는 end-to-end 재현은
  하지 않았다. 따라서 "악용 가능함이 입증됨"이 아니라 "코드상 이를 막는
  것이 없음"까지가 현재 확인 범위다.

### 선행 조치 제안

`worktreeId` 없이도 포트 소유권을 검증하거나(프로젝트가 실제로 띄운
포트 목록과 대조), 최소한 CDP 계열 포트를 릴레이 대상에서 제외한다.
이 기능은 그 뒤에 얹는다 — 순서를 바꾸면 "로그인된 브라우저를 공유 머신에
띄우라"고 권하면서 그 브라우저를 열어 두는 셈이 된다.

## 남은 미해결 질문

2. 릴레이 토큰 만료(현재 값)가 로그인 세션 길이로 충분한가?
3. CDP 프론트엔드가 절대 URL을 쓰는 구간이 있는지 — preview relay의
   `rewriteHtml` shim이 DevTools에도 통하는가?

## 범위 밖

- 로그인 **자동화** — 2FA·캡차 때문에 불가. 사람이 하는 것이 전제다.
- 스크린샷+클릭 자체 패널 — DevTools를 그대로 쓸 수 있으면 불필요.

## 수용 기준 (잠정 — 질문 1 답변 후 확정)

- AC1: 앱에서 버튼으로 원격 브라우저 화면을 열고 실제로 로그인할 수 있다.
- AC2: CDP 릴레이는 인증 없이 도달 불가능하다.
- AC3: CDP 대상 토큰은 preview 토큰과 **구분 가능**해야 한다 — dev server
  용으로 발급된 토큰이 브라우저 통제로 승격되면 안 된다.
- AC4: UI가 이 연결의 위험도를 명시한다(로그인 세션 전체 접근).
