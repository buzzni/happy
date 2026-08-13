# 터미널 전용 Linux 머신에서 브라우저 브리지 쓰기

SSH로만 접속하는 Ubuntu 서버에 Chrome을 띄우고, happy 세션이 그 브라우저를
조종하게 하는 절차입니다. 데스크톱 절차(`happy browser`가 출력하는 링크를
클릭)를 쓸 수 없는 환경이 대상입니다.

## 1. Chrome 설치

```bash
wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo apt install -y ./google-chrome-stable_current_amd64.deb
```

## 2. 확장 위치 확인

```bash
happy browser        # "압축해제된 확장 프로그램을 로드" 항목에 경로가 출력됨
```

이 경로를 아래에서 `$EXT`로 씁니다.

## 3. Chrome 기동

**확장은 명령줄로 넣지 않습니다.** Chrome 137부터 `--load-extension`이
무시되기 때문입니다(Chrome 151에서 실측: 최소 확장조차 로드되지 않고,
`--enable-unsafe-extension-debugging`이나
`--disable-features=DisableLoadExtensionCommandLineSwitch`를 붙여도 그대로).
대신 4단계의 `happy browser pair`가 CDP로 직접 넣습니다. 그 호출을 Chrome이
허용하려면 **`--enable-unsafe-extension-debugging`**으로 띄워야 합니다.

### 방법 A — `--headless=new` (간단)

```bash
google-chrome --headless=new \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.happy-chrome" \
  --enable-unsafe-extension-debugging &
```

### 방법 B — Xvfb + 일반(headful) Chrome

```bash
sudo apt install -y xvfb
Xvfb :99 -screen 0 1920x1080x24 &
export DISPLAY=:99

google-chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.happy-chrome" \
  --enable-unsafe-extension-debugging &
```

주의할 점:

- **구형 `--headless`(= `--headless=old`)는 확장을 아예 지원하지 않습니다.**
  `--headless=new`를 쓰거나 방법 B를 택하세요.
- `--user-data-dir`은 고정하세요. 로그인 세션·쿠키가 여기 저장되고,
  경로가 바뀌면 로그인이 통째로 사라집니다.
- headless에서는 `chrome.tabs.captureVisibleTab`이 실패할 수 있습니다.
  4단계에서 `--debugger`를 켜면 CDP 경로로 자동 폴백합니다.
- CDP로 넣은 확장은 **그 CDP 세션이 끊겨도 살아 있습니다**(실측 확인).
  `happy browser pair`가 일회성 명령이어도 되는 이유입니다.

## 4. 페어링

```bash
happy daemon start
happy browser pair --debugger
```

이 명령이 **확장 설치와 페어링을 모두** 처리합니다 — 확장이 아직 없으면
CDP로 넣고, 이어서 옵션 페이지를 열어 토큰을 저장시킵니다.

`--debugger`는 정밀 제어(디버거 tier)를 함께 켭니다. 옵션 페이지의 토글을
누를 사람이 없는 환경이므로, 이 플래그가 headless에서 trusted 입력과
전체 페이지 스크린샷에 닿는 유일한 방법입니다. 필요 없으면 생략하세요.

Chrome을 다른 포트로 띄웠다면 `--cdp-port 9333`처럼 맞춰 줍니다.

실패하면 원인별로 다른 메시지가 나옵니다:

| 메시지 | 뜻 |
|---|---|
| 데몬이 실행 중이 아닙니다 | `happy daemon start` 먼저 |
| Chrome이 디버깅 포트에서 응답하지 않습니다 | Chrome 미기동 또는 포트 불일치 |
| 페어링 페이지를 열지 못했습니다 (/json/new 거부) | 다른 도구가 CDP를 점유 중이거나 바인드 주소 불일치 |
| 확장을 Chrome에 넣지 못했습니다 | `--enable-unsafe-extension-debugging` 누락, 또는 `--headless=old` |
| 확장이 브리지에 닿았지만 토큰이 거부됐습니다 | 다른 데몬(`HAPPY_HOME_DIR` 상이)이 포트를 쥔 경우 |
| 옵션 페이지는 열었지만 확장이 브리지에 닿지 못했습니다 | 저장된 데몬 주소/포트 불일치 — `happy browser`로 대조 |
| 정밀 제어가 요청한 상태로 바뀌지 않았습니다 | 옵션 페이지 로드가 늦은 경우 — 다시 실행 |

## 5. 계정 로그인 (최초 1회)

**이 단계만은 화면이 필요합니다.** 2FA·캡차·새 기기 확인이 끼면 명령어로
넘길 수 없습니다. 로컬 머신에서 SSH 터널로 Chrome의 디버깅 포트를 끌어옵니다.

```bash
# 로컬 머신에서
ssh -L 9222:127.0.0.1:9222 user@ubuntu-host
```

그다음 로컬 Chrome에서 `chrome://inspect` → Configure에 `127.0.0.1:9222`를
등록하면 원격 탭이 목록에 뜨고, `inspect`로 열어 그 안에서 로그인하면
됩니다. (`chrome://inspect` 대신 noVNC로 `DISPLAY=:99`를 그대로 보는 방법도
있습니다.)

로그인이 끝나면 세션은 `--user-data-dir` 프로필에 남습니다. 이후에는 터널
없이 터미널만으로 계속 씁니다.

## 6. 확인

```bash
happy browser        # 연결된 프로필이 보이면 정상
```

세션에서 `browser_tabs`, `browser_navigate`, `browser_screenshot`이 동작합니다.

## 알려진 제약

- 로그인 자동화는 지원하지 않습니다 (5단계 참고).
- Chrome 설치·기동은 happy가 대신 해 주지 않습니다. 재부팅 후에도 살려면
  3단계를 systemd 유닛으로 감싸세요.

## 원격 PC의 브라우저에 연결하기 (CLI와 다른 머신)

지금까지는 CLI와 Chrome이 **같은** 머신(Ubuntu)에 있는 경우였다. 반대로,
**당신 자신의 컴퓨터에서 이미 로그인된 Chrome**을 그대로 두고 원격 서버의
happy 세션이 그걸 조종하게 할 수도 있다. 이 경우 Chrome을 새로 띄우거나
CDP로 페이지를 열 필요가 없다 — 확장을 한 번 설치해 두고, 옵션 페이지에서
원격 데몬 주소를 알려주기만 하면 된다.

### 1. 원격 데몬을 열기

데몬이 도는 서버에서 `happy daemon start` 전에 두 환경변수를 둔다:

```bash
export HAPPY_BROWSER_BRIDGE_HOST=0.0.0.0        # 바인드 주소
export HAPPY_BROWSER_BRIDGE_PUBLIC_HOST=1.2.3.4 # 당신의 Chrome이 실제로 접속할 주소
happy daemon start
```

두 변수가 분리된 이유: NAT나 포트포워딩 뒤에서는 서버가 듣는 주소(`0.0.0.0`)와
바깥에서 실제로 닿는 주소(공인 IP·도메인)가 다르다. `happy browser`를 실행하면
이 두 값을 반영한 링크와 함께, loopback이 아닌 바인드에 대한 경고가 함께 출력된다:

```
브리지가 0.0.0.0에 바인드되어 있습니다 — 이 컴퓨터 밖에서도 닿을 수 있습니다.
  연결은 평문 WebSocket이고 pairing 토큰이 유일한 방어선입니다. 신뢰하는 네트워크에서만 여세요.
...
  chrome-extension://<id>/src/options.html?token=...&port=41777&host=1.2.3.4
```

### 2. 보안 — 반드시 읽을 것

**연결은 TLS가 아닌 평문 WebSocket이다.** `HAPPY_BROWSER_BRIDGE_HOST`로 열면
pairing 토큰이 사용자의 로그인된 브라우저에 접근하는 **유일한** 방어선이 된다.
아래 중 하나를 반드시 적용하라:

- **가장 안전:** 공인 인터넷에 그대로 열지 말고, VPN이나 SSH 터널로 접속을
  제한한다. **당신의 PC에서** 로컬 포워딩으로 연다:

  ```bash
  ssh -L 41777:127.0.0.1:41777 user@remote
  ```

  당신의 PC의 `127.0.0.1:41777`이 원격 데몬으로 이어지므로, 확장은 데몬
  주소를 기본값(`127.0.0.1`) 그대로 두면 되고 `HAPPY_BROWSER_BRIDGE_HOST`도
  필요 없다. (`-R`이 아니라 `-L`이다 — `-R`은 반대로 **원격 서버에**
  리스너를 만들려다 이미 데몬이 잡은 41777과 충돌한다.)
- 공인 인터넷에 열어야 한다면, 리버스 프록시(Caddy/nginx)로 TLS를 종단하고
  `wss://`로 받게 한 뒤 확장 쪽 코드가 그 스킴을 쓰도록 별도 조정이 필요하다
  (기본 확장은 `ws://`만 지원한다 — 이 문서 기준 미지원).
- 어느 쪽이든 방화벽으로 브리지 포트(기본 41777)를 신뢰하는 IP로 제한한다.

### 3. 당신의 컴퓨터에서

1. 확장을 설치한다(원격 서버의 `happy browser`가 안내하는 `압축해제된 확장
   프로그램을 로드` 절차를 그대로 따르되, `$EXT` 폴더는 로컬에 미리
   내려받아 둔다 — manifest의 `key`가 고정이라 어디서 로드하든 확장 id는
   같다).
2. 1단계에서 출력된 링크를 열거나, 옵션 페이지에서 **데몬 주소**에
   `1.2.3.4`(`HAPPY_BROWSER_BRIDGE_PUBLIC_HOST`와 동일 값)를 직접 입력하고
   토큰을 붙여넣는다.
3. `happy browser`로 연결을 확인한다.

로그인은 원래 **당신 자신의 Chrome**이므로 이 시나리오에는 5단계(SSH 터널
로그인)가 필요 없다 — 이미 로그인돼 있다.
