# 브라우저 브리지 GUI 설정

## 문제

터미널 전용 Linux 머신에서 브라우저 브리지를 쓰려면 지금은 SSH로 들어가
명령어를 직접 입력해야 한다(`docs/browser-bridge-headless.md`):

1. Chrome 설치 (`apt install`)
2. Chrome 기동 (플래그 4개, 특히 `--enable-unsafe-extension-debugging`)
3. `happy daemon start` + `happy browser pair --debugger`

플래그를 하나 빠뜨리면 조용히 실패하고, 프로필을 여러 개 쓰려면 포트와
`--user-data-dir`을 사람이 직접 관리해야 한다.

## 목표

앱의 머신 상세 화면에서 버튼으로 위 과정을 끝낸다.

## 범위 (이번 단계)

- **상태 조회** — Chrome 설치 여부, 기동 여부, 연결된 프로필 목록
- **Chrome 설치** 버튼
- **브라우저 띄우기** 버튼 (프로필별 `--user-data-dir` + CDP 포트 자동 배정)
- **페어링** 버튼 (`--debugger` 포함)

## 범위 밖 (이번 단계)

- **로그인 GUI 패널.** 2FA·캡차 때문에 사람이 화면을 봐야 한다. 기존
  SSH 터널 + `chrome://inspect` 방식을 그대로 쓴다. 원시 기능
  (`screenshot`/`click`/`fill`, 디버거 tier의 trusted 입력)은 이미 있으므로
  나중에 붙일 수 있다.

## 확정된 제약 — Chrome 설치는 완전 무인이 될 수 없다

조사 결과, **sudo 없이 신뢰성 있게 Chrome을 설치할 방법이 없다.**

- `dpkg-deb -x`나 Chrome for Testing zip으로 바이너리만 홈 디렉터리에
  풀 수는 있지만, Chrome은 `libnss3`, `libgbm1`, `libatk-1.0` 등 **시스템
  공유 라이브러리**를 요구한다. 이건 root 없이 못 깐다.
  (2026-08-13 컨테이너 실측: 의존성 미설치 상태에서 `apt install ./chrome.deb`이
  unmet dependencies 28개로 실패)

따라서 설치 버튼은 **무인 설치를 가장하지 않는다**:

| 상황 | 동작 |
|---|---|
| Chrome이 이미 있음 | 경로·버전 보고, 설치 건너뜀 |
| 비밀번호 없는 sudo 사용 가능 | 그대로 설치 실행 |
| sudo 불가 | **정확히 붙여넣을 명령 한 줄**과 이유를 반환. 거짓 성공 금지 |

버튼을 눌러 실패했을 때 "왜"가 즉시 보이는 것이 조용히 절반만 성공하는
것보다 낫다.

## 수용 기준

- AC1: 상태 조회가 Chrome 미설치/미기동/기동됨을 구분해 보고한다.
- AC2: 설치 버튼이 sudo 불가 환경에서 **실패를 성공으로 보고하지 않고**,
  붙여넣을 명령을 함께 준다.
- AC3: 기동 버튼이 `--enable-unsafe-extension-debugging`을 포함한 인자를
  구성한다. 이 플래그 누락은 확장 주입을 통째로 막으므로 회귀 테스트 대상.
- AC4: 프로필 이름이 주어지면 `--user-data-dir`이 프로필별로 갈린다.
  (같은 디렉터리를 공유하면 로그인 세션이 서로 덮어써진다)
- AC5: CDP 포트는 프로필마다 다르게 배정된다. 같은 포트면 두 번째 기동이
  조용히 실패한다.
- AC6: 페어링 버튼이 기존 `handlePairCommand`와 같은 경로를 탄다 —
  페어링 로직을 복제하지 않는다.
