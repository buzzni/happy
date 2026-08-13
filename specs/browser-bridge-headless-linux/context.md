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

## 검증 결과

- `happy-browser-extension`: 166 passed (기준선 159 → +7)
- `happy-cli` unit `src/commands/` + `src/daemon/`: 529 passed (신규 17)
- `happy-cli` `tsc --noEmit`: exit 0
- `happy-cli` unit 전체: 1694 passed / 1 failed
  - 실패 1건 `fetchAplusMcpServersResult`는 `origin/main`을 별도 워크트리에
    체크아웃해 확인한 결과 동일하게 실패하는 **기존 실패**다.

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
