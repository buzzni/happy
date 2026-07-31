# 브라우저 브리지 — 토큰 드리프트와 프로필 오선택 수정 Plan

> 작성일: 2026-07-31
> 근거 문서: [spec.md](./spec.md)

## 아키텍처 영향

**있음(경미).** 모듈 경계는 그대로다. 바뀌는 것은 **토큰 파일의 소유 스코프**뿐:

```
before: configuration.happyHomeDir/browser-bridge.token   (설치별)
after : ~/.happy/browser-bridge.token                      (머신 공용)
```

근거: 브리지 리스너는 고정 포트 41777에 bind하므로 머신당 최대 하나만 존재할 수 있다
(`daemon/run.ts`는 bind 실패를 로그만 남기고 브리지 없이 계속 뜬다). 자원이 머신 단위인데
자격증명만 설치 단위로 나눠 가진 것이 이번 장애의 근본 원인이다. ADR을 쓸 만큼 되돌리기
어려운 결정은 아니나(파일 한 개), `context.md` 결정 로그에 재검토 조건과 함께 남긴다.

## 단계

### Phase 1 — 토큰 스코프 교정 (R1, R2)
- `resolveBrowserBridgeTokenFile()` 순수 함수 신설 → `configuration`이 이를 사용
- `readOrCreateBrowserBridgeToken(path, { migrateFrom })` — 공용 경로가 비었고 레거시 경로에
  토큰이 있으면 그 값을 승계(디렉터리 없으면 생성)
- `formatBrowserStatus`에 `bridgePortInUse` 입력 추가 — 데몬이 안 떠 있어도 포트를 누가
  잡고 있으면 다르게 안내
- `happy browser`가 41777에 TCP 프로브를 던져 그 값을 채움

### Phase 2 — 프로필 선택 (R3, R4)
- `BrowserBridge.request()` — 미지정 + 연결 2개 이상 → `AMBIGUOUS_PROFILE`
- 모든 `browser_*` 툴에 `profile` 인자 추가 → `params`에서 분리해 `requestBrowser`로 전달
- `describeError`에 `AMBIGUOUS_PROFILE` 안내 추가

### Phase 3 — 관측 가능성 (R5, R6)
- 확장 `tabs_list` → `{ tabs, profile, windowCount, totalTabs }`, `capabilities` → `profile` 포함
  (`chrome.windows`/`storage`가 없는 페이크 chrome에서도 죽지 않게 방어)
- `renderTabs`/`renderCapabilities` — 프로필·창 수 헤더, 0건일 때 원인별 후속 행동 문장
- `runBrowserTool`에 선택적 `status` 조회 주입 — 연결 없음/탭 0건일 때만 `/browser/status`를
  읽어 `hasRecentAuthFailure`·연결 프로필 목록을 덧붙임

## 실행 순서 근거

의존성 순서다. Phase 1은 **사용자의 실제 장애를 푸는 경로**(잘못된 토큰)이자 나머지와 독립이라
먼저 간다. Phase 3의 안내 문구가 Phase 2의 `profile` 인자를 지목하므로 2 → 3 순서여야 한다.

## 위험

- **기존 페어링 무효화**: 공용 경로와 레거시 경로의 토큰이 이미 다르면(=이번 사용자 사례)
  데몬 재시작 후 레거시 토큰을 든 확장이 거부된다. 이는 의도된 수렴이며, R2/R6 안내가 그
  상황을 설명하도록 함께 넣는다.
- **연결 2개 사용자의 기존 호출 실패**: R3는 이전에 "조용히 아무 프로필"이던 호출을 에러로
  바꾼다. 조용한 오동작보다 낫다는 판단(spec R3). 에러 메시지가 프로필 목록을 주므로 즉시 복구 가능.
