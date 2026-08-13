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

## 자체 리뷰에서 잡은 결함

4차 (커밋 `0fd06b16`) — host 가 자유 입력이 되면서 생긴 것들:

1. 잘못된 host 가 WebSocket 생성자 throw → unhandled rejection → 배지도
   재연결도 없이 확장이 조용히 죽음.
2. IPv6 리터럴이 대괄호 없이 들어가 URL 이 깨짐 (1번 경로로 이어짐).
3. `host` 미지정 링크가 기존 원격 설정을 loopback 으로 덮어씀 —
   debuggerTier 에만 적용해 둔 "미지정 = 유지" 계약을 host 에 빠뜨림.
   그 여파로 `happy browser pair` 는 host 를 명시적으로 127.0.0.1 로 고정.

5차 — 노출 경로가 진단 로직을 어긋나게 만든 것들:

4. `isBridgePortInUse` 가 항상 127.0.0.1 을 찔러, 특정 인터페이스 바인드
   (`HAPPY_BROWSER_BRIDGE_HOST=192.168.1.5`) 시 정상 동작하는 브리지를
   "포트를 잡지 못했습니다"로 오진하고 무의미한 재시작을 안내했다.
   `bridgeProbeHost` 로 실제 바인드 대상을 찌른다 (와일드카드는 loopback 을
   포함하므로 0.0.0.0/:: 는 127.0.0.1 로 찌른다 — 0.0.0.0 을 목적지로
   connect 하는 동작은 플랫폼 의존이다).
5. `hasRecentAuthFailure` 문구가 "당신의 다른 확장이 옛 토큰으로 재시도
   중"이라고 단정했다. 공개 바인드에서는 지나가는 스캐너가 같은 플래그를
   올리므로, 멀쩡한 확장을 재페어링하게 만드는 오진이 된다. 포트가 외부에
   열린 경우에만 문구를 완화한다.

6차 — IPv6 바인드 조합:

6. **IPv6 바인드가 연결마다 데몬 핸들러를 크래시시켰다.**
   `browserBridgeServer.ts`의 connection 핸들러가 base URL을 바인드
   host로 조립했는데(`http://${host}`), 브래킷 없는 IPv6(`::1`, `::`)는
   URL authority로 무효라 `new URL()`이 throw했다. base는 상대 URL
   해석용일 뿐 host 값은 읽히지 않으므로 고정 문자열로 바꿨다.
   실증: `node -e "new URL('/', 'http://::1')"` → Invalid URL.
   실서버 `::1` 바인드 테스트는 수정 전 hang(uncaught throw), 수정 후 통과.
7. `portIsPublic`이 `::1`(IPv6 loopback)을 외부 노출로 오판해 불필요한
   경고와 스캐너 문구 완화를 적용했다. loopback 목록('127.0.0.1',
   '::1', 'localhost')으로 판정을 통일했다.

7차 — 절차·설정 조합:

8. 문서의 SSH 터널 명령이 `-R`(리버스)로 적혀 있었다 — 방향이 거꾸로다.
   사용자 PC에서 `-R`을 실행하면 **원격 서버에** 리스너를 만들려다 이미
   데몬이 잡은 41777과 충돌한다. 필요한 것은 사용자 PC에 리스너를 만들어
   원격 데몬으로 잇는 `-L`(로컬 포워딩)이고, "확장은 127.0.0.1 그대로"
   라는 그 절의 논리도 `-L`에서만 성립한다.
9. `HAPPY_BROWSER_BRIDGE_PUBLIC_HOST`만 설정하고 `HAPPY_BROWSER_BRIDGE_HOST`
   를 잊은 조합의 진단 부재. 링크는 이 머신을 가리키는데 데몬은 loopback
   만 들어, 원격 확장이 침묵 속으로 접속하고 어느 쪽에도 원인이 보이지
   않는다. `happy browser`가 두 반쪽을 모두 볼 수 있는 유일한 지점이므로
   그곳에서 불일치를 경고한다.

## 남은 리스크 / 미검증

- 실제 원격 네트워크(다른 LAN, NAT 뒤)에서의 왕복은 미검증 — 단위 테스트는
  fake WebSocket/HTTP 위에서 돌았다.
- `wss://` 미지원은 의도된 스코프 제한이지 결함이 아니다. 필요해지면 별도
  spec으로 다룬다.
