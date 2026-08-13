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

두 가지 방법이 있고, **Xvfb 쪽이 확실합니다.**

### 방법 A — Xvfb + 일반(headful) Chrome (권장)

```bash
sudo apt install -y xvfb
Xvfb :99 -screen 0 1920x1080x24 &
export DISPLAY=:99

google-chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.happy-chrome" \
  --disable-extensions-except="$EXT" \
  --load-extension="$EXT" &
```

### 방법 B — `--headless=new`

```bash
google-chrome --headless=new \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.happy-chrome" \
  --disable-extensions-except="$EXT" \
  --load-extension="$EXT" &
```

주의할 점:

- **구형 `--headless`(= `--headless=old`)는 확장을 아예 로드하지 않습니다.**
  반드시 `--headless=new`를 쓰거나 방법 A를 택하세요.
- `--load-extension`은 `--disable-extensions-except`와 **짝으로** 써야
  합니다. 하나만 주면 Chrome이 조용히 무시합니다.
- `--user-data-dir`은 고정하세요. 로그인 세션·쿠키가 여기 저장되고,
  경로가 바뀌면 로그인이 통째로 사라집니다.
- headless에서는 `chrome.tabs.captureVisibleTab`이 실패할 수 있습니다.
  4단계에서 `--debugger`를 켜면 CDP 경로로 자동 폴백합니다.

## 4. 페어링

```bash
happy daemon start
happy browser pair --debugger
```

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
| 확장이 로드되어 있지 않습니다 | 3단계의 두 플래그 확인, `--headless=old` 여부 확인 |
| 옵션 페이지는 열었지만 연결되지 않았습니다 | 토큰/브리지 포트 불일치 — `happy browser`로 대조 |
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
