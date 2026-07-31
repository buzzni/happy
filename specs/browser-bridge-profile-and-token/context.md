# 브라우저 브리지 — 토큰 드리프트와 프로필 오선택 수정 Context

> 마지막 갱신: 2026-07-31 / 상태: 구현 완료 + 로컬 배포·실측 검증 완료
> 근거 문서: [spec.md](./spec.md) / [plan.md](./plan.md) / [tasks.md](./tasks.md)

## 지금 상태

Phase 1~3 구현 완료. `packages/happy-cli` 유닛 1395개, `packages/happy-browser-extension` 159개 통과,
`tsc --noEmit` 클린. 브랜치 `fix/browser-bridge-token-and-profile` (미푸시).

2026-07-31 로컬 전역 설치(`npm i -g` 로컬 tarball) 후 데몬 재시작으로 **실측 검증 완료**:
`/browser/status` → `{"connections":[{"profile":"justin"}],"hasRecentAuthFailure":false}`,
`browser_tabs`가 Gmail 포함 실제 탭 목록 반환. 재시작 시 데몬 env(HAPPY_HOME_DIR 등 8개)는
`ps eww`로 스냅샷해 그대로 복원했다.

**D4. 배포 시 공용 토큰 파일에 확장이 이미 들고 있던 값을 수동 승계.**
`~/.happy/browser-bridge.token`에 아무도 검증하지 않는 낡은 값(`bf12…`)이 남아 있어 자동
마이그레이션이 발동하지 않았고(=파일이 비어 있지 않음), 확장은 `~/.happy_remote`의 `7c1b…`를
들고 있었다. 사용자가 Chrome을 만지지 않아도 되도록 공용 파일에 `7c1b…`를 써 넣고 재시작했다
(이전 값은 `.bak-20260731`). 마이그레이션 규칙 자체는 그대로 두는 게 맞다 — "비어 있을 때만
승계"가 아니면 유효한 토큰을 덮어쓸 수 있다.
*재검토 조건:* 같은 상황(양쪽 파일이 모두 비어 있지 않고 서로 다름)이 다른 사용자에게서도
보고되면, `happy browser`에 두 파일의 불일치를 감지해 알려주는 진단을 추가한다.

## 이 기능이 존재하는 이유 (실측 진단)

`browser_capabilities`는 성공하는데 `browser_tabs`는 비고 `browser_open_tab`은
`No current window`. 세 증상 전부가 **창이 0개인 Chrome 프로필에 붙었다** 하나로 설명된다.

```
GET /browser/status → {"connections":[{"profile":"profile2"}],"hasRecentAuthFailure":true}
데몬 env  : HAPPY_HOME_DIR=~/.happy_remote  → 검증 토큰 7c1b…
`happy browser` (env 없는 셸)                → 출력 토큰 bf12…  (~/.happy)
```

- `profile2` = Chrome `Default` 프로필, 창 0개. 여기에 모든 명령이 갔다.
- 사용자가 실제로 쓰는 `Profile 1`은 `bf12…`를 들고 4401로 영구 거부.
- 확장 storage 로그에 `7c1b… ↔ bf12…` 왕복 기록 = 사용자가 눈에 보이는 토큰을 계속 붙여넣은 흔적.

## 결정 로그

**D1. 토큰을 `~/.happy`로 고정 (HAPPY_HOME_DIR 무시).**
브리지 리스너는 41777에 bind하므로 머신당 하나다. 자원이 머신 단위인데 자격증명만 설치 단위인
비대칭이 장애의 근본 원인이었다. 레거시 경로 토큰은 최초 1회 승계해 기존 페어링을 지킨다.
*재검토 조건:* 브리지 포트를 설치별로 협상하게 되면(멀티 데몬 동시 운영) 이 결정은 무효다.

**D2. 프로필이 여럿이면 고르지 않고 `AMBIGUOUS_PROFILE`로 실패.**
"창 있는 프로필 우선"도 검토했으나, 데몬은 창 개수를 모르고(확장에 물어야 함) 그 정보는 즉시
낡는다. 조용한 오선택보다 이름을 알려주는 실패가 낫다는 판단.
*재검토 조건:* 프로필 2개 이상이 일상인 사용자에게서 마찰이 보고되면, 확장이 연결 시 창 개수를
보고하도록 하고 자동 선택을 재검토.

**D3. `/browser/status` 조회는 지연(lazy).**
정상 경로에 매번 HTTP 왕복을 추가하지 않기 위해 "연결 없음" 또는 "탭 0건"일 때만 읽는다.
조회 실패는 무시한다 — 진단이 정상 명령을 깨뜨리면 안 된다.

## 시도했으나 기각한 접근

- **브리지 포트로 토큰을 노출(HTTP GET /token)**: 어느 홈 디렉터리든 토큰을 알 수 있어 편하지만,
  루프백 HTTP는 같은 머신의 모든 프로세스가 읽을 수 있다. 0600 파일보다 약해져서 기각.
- **Apple Events(JS from Apple Events) 우회**: 사용자에게 제안된 적 있으나 이 문제와 무관하고
  모든 앱에 Chrome 스크립팅 권한을 여는 광범위한 토글이라 권하지 않았다.

## 다음 세션 시작점

1. **확장 재로드 대기 중**: Chrome `Profile 1`은 확장을 이 저장소 경로
   (`packages/happy-browser-extension`)에서 unpacked로 로드하고 있다. Phase 3의
   `profile`/`windowCount`/`totalTabs` 필드는 사용자가 `chrome://extensions`에서 새로고침하거나
   Chrome을 재시작해야 실제로 실린다. 그 전까지 툴 출력에 프로필 헤더가 안 보이는 것은 정상.
2. 세션의 MCP 서버는 세션 시작 시점의 CLI 빌드를 쓴다 — 새 렌더링(프로필 헤더, 빈 목록 진단)은
   **새 세션**에서 확인할 것.
3. 브랜치 푸시 / PR은 아직 하지 않았다.

## 발견된 문제 (이번 범위 밖)

- `packages/happy-cli/src/daemon/run.ts`는 브리지 bind 실패를 debug 로그로만 남긴다. 두 번째
  데몬은 브리지 없이 조용히 뜬다 — 사용자에게 보이는 신호가 없다.
- 확장 옵션의 기본 프로필 이름이 과거 설치에서는 리터럴 `default`로 저장돼 있다(랜덤 접미사
  도입 이전). 서로 다른 두 프로필이 같은 이름이면 지금도 소켓을 번갈아 뺏는다.
