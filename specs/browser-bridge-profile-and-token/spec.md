# 브라우저 브리지 — 토큰 드리프트와 프로필 오선택 수정 Spec

> 작성일: 2026-07-31 / 상태: 승인됨
> ⚠️ 승인 후에는 사용자 지시 없이 수정 금지

## 목표

Chrome 확장 브리지가 **엉뚱한 Chrome 프로필에 붙어 조용히 실패하는 것**을 구조적으로 막는다.

1. `happy browser`가 출력하는 pairing 토큰이 **실제로 브리지를 운영 중인 데몬이 검증하는 토큰**과 항상 같아야 한다.
2. 에이전트가 받는 응답만으로 "탭이 없다"와 "다른 프로필에 붙었다 / allowlist가 다 가렸다"를 **구분할 수 있어야** 한다.
3. 프로필이 둘 이상 연결됐을 때 **임의의 하나를 조용히 고르지 않아야** 한다.

## 배경 — 실측된 장애

2026-07-31, 사용자 Chrome에 창 2개·탭 10개(Gmail 포함)가 열려 있는데도:

- `browser_capabilities` → 성공
- `browser_tabs` → `No open tabs.`
- `browser_open_tab` → `No current window`

실측 진단:

```
GET /browser/status → {"connections":[{"profile":"profile2"}],"hasRecentAuthFailure":true}

데몬(pid 94184) env : HAPPY_HOME_DIR=/Users/justin/.happy_remote
  검증 토큰          : ~/.happy_remote/browser-bridge.token = 7c1b…
터미널 `happy browser` (env 없음)
  출력 토큰          : ~/.happy/browser-bridge.token        = bf12…
```

- 연결된 `profile2` = Chrome `Default` 프로필. **열린 창이 0개**여서
  `chrome.tabs.query({})` → `[]`, `chrome.tabs.create()` → Chrome 원문 `No current window`.
- 실제로 쓰는 `Profile 1` 확장은 `bf12…`를 들고 있어 **4401로 영구 거부**(`hasRecentAuthFailure: true`).
- 사용자는 출력된 토큰(`bf12…`)을 계속 붙여넣었으나 데몬은 `7c1b…`를 검증 — 화면에 보이는 값과
  실제 검증 값이 다르므로 **사용자가 스스로 알아낼 방법이 없었다.**

## 요구사항

### R1 — 토큰은 머신 단위 자원이다
브리지 포트(41777)는 머신당 하나이고 두 번째 데몬은 bind에 실패해 브리지가 아예 없다.
따라서 토큰도 `HAPPY_HOME_DIR`과 무관하게 **머신 공용 경로**(`~/.happy/browser-bridge.token`)에
있어야 한다. 기존에 home-dir 스코프 파일만 있던 설치는 최초 1회 **마이그레이션**한다.

### R2 — `happy browser`는 브리지의 실제 상태를 말해야 한다
이 설치의 데몬이 떠 있지 않아도 **누군가 41777을 잡고 있으면** 그 사실과 대처를 안내한다.
(현재는 "데몬이 실행 중이 아닙니다"만 출력해 사용자를 잘못된 방향으로 보낸다.)

### R3 — 프로필 모호성은 에러다
연결이 2개 이상인데 호출자가 프로필을 지정하지 않으면 **임의 선택(`values().next()`) 대신
`AMBIGUOUS_PROFILE` 에러**를 내고 연결된 프로필 이름을 알려준다.
연결이 하나뿐일 때의 동작은 바뀌지 않는다.

### R4 — 에이전트가 프로필을 고를 수 있어야 한다
모든 `browser_*` 툴이 선택적 `profile` 인자를 받아 브리지까지 전달한다.

### R5 — 빈 결과는 이유를 함께 말해야 한다
`tabs_list`는 표시 대상 탭 외에 **응답한 프로필 이름 / 창 개수 / 필터 전 탭 수**를 함께 반환하고,
툴 출력은 0건일 때 그 맥락과 다음 행동을 문장으로 제시한다.
`capabilities`도 응답한 프로필 이름을 포함한다.

### R6 — 토큰 거부는 숨지 않아야 한다
`hasRecentAuthFailure`가 참일 때, 에이전트 대면 출력(연결 없음 / 탭 0건)에
"다른 확장이 옛 토큰으로 거부되는 중"이라는 사실과 재페어링 안내가 포함돼야 한다.

## 비목표

- 확장이 여러 프로필의 탭을 **합쳐서** 보여주는 것 (프로필 경계는 Chrome이 강제한다)
- 브리지 포트 자동 협상 / 다중 데몬 동시 운영
- allowlist 정책 변경
