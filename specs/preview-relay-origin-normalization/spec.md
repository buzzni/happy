# Preview relay Origin 정규화 Spec

> 작성일: 2026-07-28 / 상태: 초안
> ⚠️ 승인 후에는 사용자 지시 없이 수정 금지

## 목표

임의의(프레임워크 불문) 사용자 프로젝트를 프리뷰로 띄웠을 때, dev 서버 자체의 Origin/Host
검사 미들웨어(Expo `CorsMiddleware`, Vite, webpack-dev-server, Next.js dev 등)가 relay를
거친 요청을 거부해서 흰 화면·HMR 끊김이 나는 문제를, **프로젝트마다 개별 워크어라운드를
심지 않고** relay 레이어에서 한 번에 해결한다.

## 배경

- `aplus-dev-studio-app`(Expo 프로젝트)에서 실측: 브라우저가 프리뷰 도메인
  (`https://{machineId}-{port}.preview.saycode.ai`)에서 dev 서버로 요청을 보내면
  `@expo/cli`의 `CorsMiddleware`가 `Origin` 헤더의 host와 자기 자신의 `Host` 헤더가
  다르고, `localhost`/loopback도 아니라서 **HTML 셸은 200, JS 번들 요청은 500**
  (`Unauthorized request`)으로 거부했다. 그 프로젝트에서는 `app.config.js` +
  머신별 `.env`(`EXPO_PREVIEW_ORIGIN`)로 Expo의 CORS 허용목록에 프리뷰 도메인을
  직접 등록해 우회했다.
- 이 relay(happy-cli/happy-server)의 코드를 실측한 결과, **`Host`는 이미 항상
  loopback으로 재작성되고 있는데 `Origin`만 원본 그대로 전달**되는 비대칭이 있다:
  - HTTP: `packages/happy-cli/src/daemon/previewProxy.ts`의 `stripHopByHop`이
    caller가 보낸 `Host`를 제거하고(HOP_BY_HOP_HEADERS에 포함), `http.request({host:
    '127.0.0.1', port, ...})`가 Node 기본 동작으로 `Host: 127.0.0.1:{port}`를
    자동 생성한다. 반면 `Origin`은 어떤 필터에도 걸리지 않고
    (`packages/happy-server/.../previewRoutes.ts`의 `filterForwardedHeaders`도
    통과, `previewProxy.ts`의 `stripHopByHop`도 통과) 원본
    (`https://{machineId}-{port}.preview.saycode.ai`)이 그대로 upstream에 전달된다.
  - WS(HMR/업그레이드): `packages/happy-server/.../previewWebSocketRelay.ts`의
    `serializeUpgradeRequest`가 이미 `Host` 헤더만 명시적으로
    `127.0.0.1:{port}`로 재작성하는 주석 있는 로직을 갖고 있다("rewrites `Host`
    to the loopback target so name-based vhosts... resolve correctly") — 그런데
    `Origin`은 이 함수에서 다루지 않아 원본 그대로 replay된다.
- 그 결과 `Host`와 `Origin`이 서로 다른 도메인을 가리키게 되고, cross-origin
  요청을 막는 모든 dev 서버 미들웨어가 발동한다. 이건 Expo만의 문제가 아니라
  **Host/Origin 일치를 요구하는 임의의 프레임워크 전부**에 해당하는 구조적 갭이다
  — `specs/preview-relay-credential-passthrough/context.md`의 "남은 이슈"에도
  "`Origin` 헤더 그대로 전달... relay가 upstream origin으로 다시 쓸지는 결정
  필요"로 이미 발견되어 있었다(이번 spec이 그 결정을 내리고 구현한다).

## 요구사항

- R1. Given HTTP 프리뷰 요청에 `Origin` 헤더가 있을 때, When
  `previewProxy.ts`(`proxyHttp`/`stripHopByHop`)가 upstream(`127.0.0.1:{port}`)으로
  요청을 보내면, Then `Origin` 헤더 값이 `http://127.0.0.1:{port}`로 재작성된다
  — Node가 자동 생성하는 `Host: 127.0.0.1:{port}`와 정확히 일치시켜, `Host`와
  `Origin`을 함께 검사하는 미들웨어에서 same-origin으로 판정되게 한다.
- R2. Given HTTP 프리뷰 요청에 `Origin` 헤더가 없을 때, Then 아무것도 추가하지
  않는다(없는 헤더를 새로 만들지 않음 — 순수 GET 네비게이션 등 원래 Origin이
  없는 요청과 동일하게 유지).
- R3. Given WS 업그레이드(HMR 등) 요청에 `Origin` 헤더가 있을 때, When
  `previewWebSocketRelay.ts`의 `serializeUpgradeRequest`가 raw handshake bytes를
  조립하면, Then `Origin`도 `Host`와 동일한 규칙(`http://127.0.0.1:{port}`)으로
  재작성된다 — 기존 `Host` 재작성과 대칭.
- R4. Given `Origin` 재작성 전후로 기존 subdomain CORS 응답 헤더 로직
  (`applySubdomainPreviewCorsHeaders`, `packages/happy-server/.../previewRoutes.ts:246`)이
  요청의 **원본** `request.headers.origin`(relay가 브라우저로부터 받은 값, 재작성
  전)을 계속 사용해야 하므로, Then 이 spec의 재작성은 daemon이 upstream으로 보내는
  아웃바운드 요청에만 적용하고, relay가 브라우저로 돌려주는 응답 헤더 로직에는
  손대지 않는다(회귀 없음 보장 — 재작성은 `previewProxy.ts`/
  `previewWebSocketRelay.ts`의 outbound 조립 지점에서만 일어나고, `previewRoutes.ts`가
  `request.headers.origin`을 읽는 지점은 이 재작성의 영향을 받지 않는 별개의 값).

## 비목표 (Non-Goals)

- **`kind`(frontend/backend/electron-gui)별 분기** — 이번 spec은 `Host`가 이미
  무조건 재작성되는 것과 동일한 스코프로 `Origin`도 무조건 재작성한다. relay는
  현재 요청이 어느 `kind`로 향하는지 알지 못하고(포트 번호만 앎), 이를 알게
  하려면 daemon↔서버 프로토콜에 `kind` 메타데이터를 추가하는 별도 작업이 필요해서
  범위 밖.
- **backend API의 CSRF/Origin 검증과의 상호작용 조사** — `Origin`이
  `http://127.0.0.1:{port}`로 바뀌면, 만약 어떤 프로젝트의 백엔드가 이 relay를 통해
  직접 프리뷰되면서 자체적으로 "브라우저의 실제 Origin과 일치하는지" 같은 CSRF
  방어를 한다면 그 방어가 깨질 수 있다. 이미 `Host`가 항상 재작성되고 있어 그런
  방어는 오늘도 `Host` 기준으로는 이미 무력화돼 있었고(Host를 보고 검증하는 방식이면
  이미 깨져 있었음), `Origin` 재작성은 그 비일관성을 없애 **Host와 Origin을 다시
  일치**시키는 것에 가깝다고 판단해 스코프에 넣지 않는다. 재발 시(어떤 프로젝트가
  이 relay 뒤에서 Origin 기반 CSRF가 깨졌다고 보고하면) 재검토.
- **`app.config.js` 같은 프로젝트별 워크어라운드 제거** — 이미 있는
  `aplus-dev-studio-app`의 워크어라운드는 이번 spec과 무관하게 그대로 둔다(양쪽 다
  같은 문제를 다른 레이어에서 고치는 것이라 공존 가능, 되돌리는 건 별도 승인
  필요한 다른 저장소 작업).
- **HTTPS로 upstream에 연결하는 경로 지원** — `proxyHttp`가 `node:http`로 고정
  loopback 연결만 하므로(TLS 없음), 재작성 값은 항상 `http://` 스킴이다. HTTPS
  loopback dev 서버(드묾)는 이번 스코프 밖.

## 제약

- 호환성: 순수 additive/재작성 — 새 daemon↔server 프로토콜 필드 없음, 기존
  `proxyHttp(req, opts)` / `serializeUpgradeRequest(...)` 시그니처 불변. 구버전
  daemon과 신버전 서버, 또는 그 반대 조합에서도 각자 독립적으로 안전(HTTP 경로는
  전부 CLI daemon 안에서만 일어나고, WS 경로는 전부 happy-server 안에서만 일어남 —
  cross-version 프로토콜 영향 없음).
- 릴리스: 이 spec 범위에서 `npm publish`/태그 푸시를 직접 수행하지 않는다
  (`AGENTS.md` "Happy CLI Release Publisher" 정책 — 외부 릴리스는 별도 승인).

## 완료 기준 (Definition of Done)

- [x] R1~R3에 대응하는 테스트 존재 및 통과
      (`previewProxy.test.ts`에 Origin 재작성 케이스 추가,
      `previewWebSocketRelay.spec.ts`의 `serializeUpgradeRequest` describe에
      Origin 케이스 추가)
- [x] R4 회귀 확인 — 기존 `previewRoutesCredentials.spec.ts` /
      `previewRoutesStripHeaders.spec.ts` / `previewRoutesRelay.spec.ts` 등
      `previewRoutes.ts` 관련 스위트가 그대로 통과(이 spec이 그 파일을 건드리지
      않는다는 것 자체가 증거) — happy-server 39파일/478개 전체 통과로 확인
- [x] `pnpm -C packages/happy-cli typecheck` && `pnpm -C packages/happy-cli test`
      통과 (typecheck 통과, test 145/147 파일 — 실패 2개는 무관한 기존 flake, context.md 참고)
- [x] `pnpm -C packages/happy-server typecheck` && `pnpm -C packages/happy-server test`
      통과 (39/39 파일, 478/478 테스트)
- [ ] `context.md`에 완료 요약 + (재현 가능하면) `aplus-dev-studio-app`에서
      `app.config.js` 워크어라운드 없이도 프리뷰가 뜨는지 수동 확인 기록
