# Preview relay Origin 정규화 Plan

> 작성일: 2026-07-28 / 상태: 초안
> 근거 문서: [spec.md](./spec.md)

## 아키텍처 영향

| 항목 | 내용 |
|------|------|
| 관련 모듈/레이어 | `packages/happy-cli/src/daemon/previewProxy.ts`(HTTP 프록시), `packages/happy-server/sources/modules/preview/previewWebSocketRelay.ts`(WS 업그레이드 relay) |
| 새 외부 의존성 | 없음 |
| 모듈 경계/공개 API 변경 | 없음 — 두 함수(`proxyHttp`/`stripHopByHop`, `serializeUpgradeRequest`) 모두 시그니처 불변, 내부 헤더 조립 로직만 확장. daemon↔server 소켓 프로토콜(`proxy-http-request`, `proxy-ws-open` 등) 변경 없음 |
| 데이터 스키마 변경 | 없음 |

이 repo는 `docs/adr/` 컨벤션이 없고 `specs/[feature]/`가 결정 기록의 단일 지점이라
(session-created-by 선례와 동일), 이 문서가 사실상 결정 기록을 겸한다.

## 접근 방식

두 지점 모두 이미 `Host`를 무조건 loopback으로 재작성하는 기존 로직이 있다
(`previewProxy.ts`는 caller의 `Host`를 지우고 Node가 `http.request({host, port})`로
자동 채우게 함, `serializeUpgradeRequest`는 명시적으로 `Host: 127.0.0.1:{port}`로
치환). `Origin`도 정확히 같은 대상 값(`http://127.0.0.1:{port}`)으로 맞추기만 하면
되므로, **새 모듈을 만들지 않고 두 기존 함수에 대칭적인 한 줄을 추가**한다.

검토했으나 기각한 대안:
- **`previewRoutes.ts`(happy-server, HTTP relay route)에서 재작성** — 기각. 그 파일은
  이미 `request.headers.origin`을 응답 CORS 헤더 조립(`applySubdomainPreviewCorsHeaders`)에
  쓰고 있어서, 같은 값을 outbound 재작성에도 쓰려면 "이 값은 브라우저→relay 방향으로만
  쓰고, 재작성된 값은 daemon에 새 필드로 얹어 전달"해야 해서 payload 스키마가 늘어난다.
  반면 `previewProxy.ts`는 이미 daemon 안에서 upstream 접속 직전에 `Host`를 결정하는
  바로 그 지점이라, `port`(이미 payload에 있음)만으로 `Origin`도 같이 계산할 수 있어
  프로토콜 변경이 필요 없다.
- **daemon↔server 프로토콜에 `kind`(frontend/backend) 필드를 추가해 `kind==='backend'`일
  때만 재작성 skip** — 기각(spec.md 비목표 참고). 오늘 `Host`가 이미 무조건 재작성되고
  있어 대칭성을 지키는 게 일관적이고, `kind`를 relay가 알게 하는 건 이 spec보다 훨씬
  큰 프로토콜 확장이라 별도 spec 대상.
- **Origin을 아예 삭제(헤더 제거)** — 기각. 일부 미들웨어(CSRF 방어 등)는 Origin이
  "아예 없음"과 "same-origin"을 다르게 처리할 수 있어(전자를 서버-사이드 요청으로
  보고 더 엄격하게 다루는 경우도 있음), 존재는 하되 loopback을 가리키게 하는 쪽이
  "브라우저가 dev 서버 자기 자신에 요청한 것"이라는 실제 상황과 의미적으로 더 정확하다.

## 단계 (Phases)

- [ ] **Phase 1: HTTP 경로(`previewProxy.ts`) Origin 재작성** → 검증:
      `previewProxy.test.ts`에 "Origin 헤더가 있으면 upstream이 받는 Origin이
      `http://127.0.0.1:{port}`" / "Origin 헤더가 없으면 upstream도 받지 않음" 2케이스
      추가, 기존 케이스 전부 통과 유지.
- [ ] **Phase 2: WS 경로(`previewWebSocketRelay.ts`) Origin 재작성** → 검증:
      `previewWebSocketRelay.spec.ts`의 `describe('serializeUpgradeRequest')`에 Phase 1과
      대칭인 2케이스 추가(있음/없음), 기존 `Host` 재작성 케이스와 나란히 통과.
- [ ] **Phase 3: 전체 회귀 + 실기기 검증** → 검증: `pnpm -C packages/happy-cli test`,
      `pnpm -C packages/happy-server test`, 양쪽 `typecheck` 전체 통과. 가능하면
      `aplus-dev-studio-app`을 이 브랜치의 happy-cli/daemon으로 띄워 `app.config.js`
      워크어라운드 없이(또는 임시로 비활성화하고) 프리뷰가 뜨는지 수동 확인 — 이번
      spec이 실제로 근본 원인을 해결했다는 최종 증거.
- [ ] **Phase 4: 문서화** → 검증: `context.md`에 완료 요약, 비대칭이 남아있던 이유와
      고친 지점을 결정 로그로 압축. `specs/preview-relay-credential-passthrough/context.md`의
      "남은 이슈" 항목 중 Origin 재전달 건에 이 spec으로의 링크를 추가.

## 리스크와 대응

- **Origin 재작성이 어떤 dev 서버의 "Origin이 정확히 프리뷰 도메인이어야 통과"하는
  화이트리스트 로직과 충돌할 가능성** — 이론상 존재하지만 실사용 케이스가 확인되지
  않음(Expo/Vite/webpack류는 반대로 "Origin이 자기 자신과 다르면 차단"하는 게
  일반적이라 이 fix가 정확히 그 케이스를 푼다). 발견되면 spec.md 비목표에 재검토
  트리거로 이미 기록.
- **`stripHopByHop`이 대소문자 다른 `Origin`/`origin` 키를 모두 처리해야 함** —
  Phase 1에서 case-insensitive 매칭으로 구현하고 테스트 케이스에 대문자 `Origin` 포함.
- **`serializeUpgradeRequest`는 `rawHeaders`(브라우저가 보낸 원본 대소문자)를 순회하므로
  `Origin`으로 올 수도 `origin`으로 올 수도 있음** — Phase 2에서 기존 `Host` 매칭과
  동일한 `key.toLowerCase() === 'origin'` 패턴으로 구현.
