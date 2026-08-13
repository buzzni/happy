# 진행 상태

> 갱신: 2026-08-13 / 브랜치 `feat/browser-bridge-headless-linux`

## 완료

| Phase | 요구 | 커밋 |
|---|---|---|
| 1 | R1 auto-connect `?debugger=` | `6f42f8f3` |
| 2 | R2 포커스 없는 활성 탭 폴백 | `66d35ae9` |
| 3 | R3 스크린샷 CDP 폴백 | `353847e1` |
| 4 | R4 `happy browser pair` | `4019ca37` |
| 5 | R5 문서 | `5605b058` |
| 리뷰 | pair 오보고 2건 수정 | `a21a9842` |

## 리뷰에서 잡은 결함

1. `openTab` 반환값을 버려서, `/json/new` 거부를 "확장 미로드"로 오진했다.
2. `--debugger` 반영 여부를 확인하지 않아, 이미 연결된 프로필이 있으면
   설정이 안 걸렸는데도 "페어링 완료"를 찍었다. `capabilities`로 되읽어
   대조하도록 고쳤다.
3. (2차 리뷰) 그 tier 확인이 프로필을 지정하지 않아, 프로필 2개 이상
   연결 시 데몬의 AMBIGUOUS_PROFILE 거부(502)를 5초 내내 받다가 "확장
   무응답"이라는 틀린 원인을 보고했다. `pickTierProbeProfile`로 페이지
   열기 전후 연결 목록을 대조해 대상 프로필을 특정하고, 특정 불가면
   폴링 없이 정직하게 "확인 불가"로 보고한다.
4. (3차 리뷰) 성공 판정 자체가 틀렸다. `waitForConnection`이 "연결이
   하나라도 있으면" 즉시 반환해, pair 시작 전부터 연결돼 있던 방관자
   프로필만으로 0초에 "페어링 완료"를 찍었다 — 대상 Chrome에 확장이
   로드조차 안 됐어도. 신규 프로필이 나타날 때까지 기다리고, 성공
   문구는 이번 실행이 실제 연결한 프로필을 앞세우며, 신규 없음 +
   확장 미로드는 성공이 아니라 로드 실패로 보고한다. 재페어링(신규
   프로필이 원리적으로 안 생김)은 타임아웃을 다 쓰고 "이미 연결"로
   기술된다 — 방관자 오판정을 막는 대가로 수용.

## 검증 결과

- `happy-browser-extension`: 166 passed (기준선 159 → +7)
- `happy-cli` unit `src/commands/` + `src/daemon/`: 529 passed (신규 17)
- `happy-cli` `tsc --noEmit`: exit 0
- `happy-cli` unit 전체: 1694 passed / 1 failed
  - 실패 1건 `fetchAplusMcpServersResult`는 `origin/main`을 별도 워크트리에
    체크아웃해 확인한 결과 동일하게 실패하는 **기존 실패**다.

## 실기 검증 결과 (2026-08-13, macOS + Chrome 151, headless=new)

브리지를 기본 포트가 아닌 임시 포트에 띄우고(사용자 데몬 무간섭) 실제
Chrome을 일회용 프로필로 구동해 검증했다.

| 항목 | 결과 |
|---|---|
| auto-connect `&host=`/`&debugger=1` → storage 저장 | ✅ `host`,`port`,`debuggerTier` 실제 기록 |
| 확장이 비기본 포트(41991/41993)로 연결 | ✅ |
| **비-loopback 원격 연결** (LAN IP `172.16.9.1`, 브리지 `0.0.0.0`) | ✅ |
| `capabilities.debugger` 실제 반영 | ✅ true |
| `timingSafeEqual` — 동일길이/다른길이 오답, 정답 | ✅ 4401 / 4401 / open |

### 발견: `--load-extension` 이 죽었다 (Chrome 137+)

최소 확장으로 대조 실험해 **우리 확장 문제가 아님**을 확정했다.
`--enable-unsafe-extension-debugging` 이나
`--disable-features=DisableLoadExtensionCommandLineSwitch` 를 붙여도 무시된다.
문서와 pair 안내가 이 플래그를 전제하고 있었으므로 **따라 해도 실패하는
절차**였다.

대체 경로: `--enable-unsafe-extension-debugging` 으로 띄운 Chrome 에
CDP `Extensions.loadUnpacked` 를 호출하면 정상 로드된다(확장 id 정확히 반환,
옵션 페이지·SW 동작). **CDP 세션을 끊어도 확장이 유지됨**을 15초 후 연결
생존으로 확인했고, 이것이 일회성 `pair` 명령이 확장을 넣어도 되는 근거다.

→ `pair` 가 `loadUnpackedExtension` 으로 직접 넣도록 변경, 문서 3단계 교체.

## pair 종단 실기 검증 (2026-08-13, 격리 브리지 + 실제 Chrome)

이 머신의 41777 데몬이 justin/ryan 두 사용자의 세션 35개(이 세션 포함)가
묶여 쓰는 공유 자원임을 확인했다. `pair`의 브리지 포트(41777)는
`HAPPY_HOME_DIR`과 무관한 하드코딩 상수라 순수 env 격리로는 공유 데몬을
피할 수 없어, `vi.mock`으로 `DEFAULT_BROWSER_BRIDGE_PORT`·`configuration`·
`readDaemonState`만 사설 값으로 바꾸고 나머지는 실제 `handlePairCommand`를
그대로 실행하는 방식으로 검증했다. 공유 포트 41777·실제 토큰 파일
(`~/.happy/browser-bridge.token`, mtime 불변 확인)에는 어떤 패킷도
파일 변경도 가지 않는다.

| 시나리오 | 결과 |
|---|---|
| 정상 페어링(확장 CDP 로드 → 연결 → tier 확인) | ✅ 실제 출력: `페어링 완료 — 새로 연결된 프로필: default-2d13 / 정밀 제어: 켬` |
| CDP 미도달(`--cdp-port 19999`) | ✅ 정확한 안내 문구 출력, `process.exitCode === 1` |

`handlePairCommand`의 전체 오케스트레이션(데몬 상태 확인 → CDP 확인 →
연결 스냅샷 → `loadUnpackedExtension` → `openTab` → `waitForConnection` →
`waitForDebuggerTier` → `formatPairOutcome`)이 실제 Chrome 151 위에서
설계대로 동작함을 실측했다.

## 미검증 — 실제 Ubuntu 머신에서 확인 필요

단위 테스트는 fake chrome/CDP 위에서 돌았다. 실물에서만 확인 가능한 것:

1. `--headless=new`에서 MV3 service worker가 실제로 살아 WS를 유지하는지
2. `hasExtensionTarget`이 보는 `/json/list`에 확장 service worker 타깃이
   실제로 뜨는지 — dormant면 "확장 미로드"로 오진할 수 있다.
   오진해도 페이지는 열고 연결 폴링은 그대로 도므로 치명적이진 않다.
3. `captureVisibleTab`이 Xvfb headful에서 성공하는지 (성공하면 폴백은
   `--headless=new` 경로에서만 쓰인다)

## 남은 것

- `packages/happy-cli/browser-extension`은 빌드 시 생성물이라 손대지 않음
  (`copy-browser-extension.cjs`, `shipped-files.json`). 새 확장 파일을
  추가하지 않았으므로 shipped-files.json 수정 불필요.
- 릴리스는 `happy-cli-v<version>` 태그 → CI. 로컬 publish 금지.
