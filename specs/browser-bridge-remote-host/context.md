# 진행 상태

> 갱신: 2026-08-13 / 브랜치 `feat/browser-bridge-headless-linux`
> (PR #170에 이어서 진행 — 별도 브랜치를 새로 파지 않음)

## 완료

| Phase | 요구 | 커밋 |
|---|---|---|
| 1 | R1 확장 host 설정 (connection/options/autoConnect) | `1ae78738` |
| 2 | R2 `HAPPY_BROWSER_BRIDGE_HOST`로 데몬 바인드 | `f6471884` |
| 4 | R4 토큰 비교 타이밍 안전화 | `885e3d41` |
| 3 | R3 `happy browser` 원격 링크 + 노출 경고 | `3b22aeb8` |
| 5 | R5 문서 | (다음 커밋) |

R4를 R3보다 먼저 한 이유: R2로 non-loopback 바인드가 가능해진 시점부터
토큰이 유일한 방어선이 되므로, 노출 경로를 더 넓히는 R3 전에 막았다.

## 검증 결과

- `happy-browser-extension`: 169 passed (직전 세션 166 → +3, connection.test.js)
- `happy-cli` `commands/`+`daemon/`: 544 passed
- `happy-cli` `tsc --noEmit`: exit 0

## 설계 결정

- **바인드 주소(`HAPPY_BROWSER_BRIDGE_HOST`)와 공개 주소(`HAPPY_BROWSER_BRIDGE_PUBLIC_HOST`)를
  분리**했다. NAT/포트포워딩 뒤에서는 서버가 듣는 주소와 클라이언트가 실제로
  접속할 주소가 다르므로, 하나를 추론해서 쓰면 틀린 링크를 찍을 위험이 있다.
- **TLS는 스코프 밖**으로 명시했다(spec 비목표). 확장은 `ws://`만 지원하고,
  `wss://`로 바꾸려면 확장 쪽 스킴 처리와 인증서 관리가 추가로 필요해 이번
  범위를 넘어선다. 대신 문서에 SSH 리버스 터널/VPN을 1순위 권장으로 적었다.
- **`happy browser`가 읽는 host/publicHost는 best-effort**다 — 이 명령을
  실행하는 프로세스 자신의 env이지, 이미 떠 있는 데몬이 기동 시점에 실제로
  읽은 값이 아닐 수 있다. 데몬 기동 후 env가 바뀌면 어긋난다.

## 남은 리스크 / 미검증

- 실제 원격 네트워크(다른 LAN, NAT 뒤)에서의 왕복은 미검증 — 단위 테스트는
  fake WebSocket/HTTP 위에서 돌았다.
- `wss://` 미지원은 의도된 스코프 제한이지 결함이 아니다. 필요해지면 별도
  spec으로 다룬다.
