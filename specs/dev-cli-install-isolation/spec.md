# dev-cli-install-isolation

## 배경

2026-08-23 과 2026-08-25, 이 머신의 daemon 이 각각 약 6시간씩 사라졌다. 두 건 모두
번들 교체 handoff 경로에서 터졌고, 각각 `specs/daemon-handoff-spawn-race` 와
`specs/daemon-handoff-confirm-startup` 에서 고쳤다.

하지만 그 handoff 를 **하루에 수십 번 반복시키는 동인** 은 그대로 남아 있었다.
08-24 저녁 6시간 동안 daemon 이 20번 교체됐고, handoff 를 유발한 `daemon start`
호출 12건의 실행 위치가 전부 한 곳이었다:

```
/Users/justin/workspace/happy/.aplus/worktrees/natural-language-subagent-reliability
```

happy-cli 를 개발하는 세션이 자기 변경을 확인하려고 `pnpm cli:install` 을 반복
실행한 것이다. 이 문서를 쓰는 동안에도 전역 번들이 07:49:48 과 07:50:15 에 두 번
덮였다.

## 문제

`cli:install` 은 이 워크스페이스를 **전역** `happy` 로 설치한다. 그 부작용:

1. `npm install -g` 가 전역 번들을 덮는다.
2. 그 번들을 감시하던 daemon 이 handoff 한다.
3. 그 daemon 이 물고 있던 **모든 세션** 이 새 daemon 으로 넘어간다.
4. handoff 가 실패하면 그 세션들 전부가 daemon 을 잃는다.

즉 개발자 한 명이 자기 브랜치를 테스트하는 행위가, 같은 머신의 무관한 세션
전부의 daemon 을 교체한다. 8월 두 건의 장애는 이 반복 시행이 결국 한 번
실패한 것이다.

### 안전한 경로는 이미 있었지만 아무도 안 쓴다

`docs/runbooks/happy-cli-dev-e2e-verification.md` §2 가 격리 절차를 문서화하고
있고, §2.1 은 공유 머신에서 **전역 설치를 건드리지 말라** 고 명시한다.

그런데 그 절차는 5개 하위 단계에 걸친 수동 셸 30여 줄이고, 각 단계마다 함정이
있다 — 별도 prefix, 별도 `HAPPY_HOME_DIR`, 상속된 `HAPPY_*` 세션 변수 스크럽,
node-pty 네이티브 처리. 반면 위험한 경로는 `pnpm cli:install` 한 줄이다.

**안전한 길이 30줄이고 위험한 길이 1줄이면 사람들은 위험한 길로 간다.**
이것이 고칠 대상이다.

## 요구사항

- **R1** 격리 설치가 `cli:install` 만큼 쉬워야 한다. 한 줄 명령으로 전역 설치와
  공유 daemon 을 건드리지 않고 개발 빌드를 실행할 수 있어야 한다.
- **R2** 격리 설치는 별도 npm prefix 와 별도 `HAPPY_HOME_DIR` 을 쓴다.
- **R3** 실행 명령을 출력할 때 상속된 세션 변수(`HAPPY_HOME_DIR`,
  `HAPPY_RECONNECT_*` 등) 스크럽을 포함한다. 이게 빠지면 격리 홈을 줘도 daemon 이
  프로덕션 설정을 읽고 죽는다.
- **R4** 전역 설치는 **잃을 것이 있을 때** 거부한다. 살아 있는 daemon 이 세션을
  추적 중이면 중단하고 격리 경로를 안내한다.
- **R5** 거부는 우회 가능해야 한다 (`HAPPY_CLI_INSTALL_GLOBAL=1`). 전역 설치가
  정말 의도인 경우가 있다.
- **R6** 가드는 좁아야 한다. 세션을 안 물고 있는 solo daemon 은 통과시킨다.
  그러지 않으면 사람들이 읽지 않고 반사적으로 우회하는 소음이 된다.

## 비목표

- **`cli:install` 의 전역 설치 동작 자체는 바꾸지 않는다.** 그것이 이 스크립트의
  목적이고, 런북 §2.1 도 "공유 머신이 아니면 써도 된다" 는 전제다. 가드는
  게이트지 대체가 아니다.
- **격리 설치가 daemon 을 자동 기동하지 않는다.** 자격증명 복사와 daemon 기동은
  운영자가 명시적으로 결정할 일이다. 스크립트는 실행할 명령을 출력한다.
- **번들 재설치 빈도 자체를 제한하지 않는다.** 격리 경로가 쉬워지면 전역 재설치
  빈도는 자연히 떨어진다.

## 이번에 드러난 런북 오류

§2.3 은 `--ignore-scripts` 로 설치한 뒤 node-pty 의 `build/` 디렉터리를 복사하라고
한다. 현재 node-pty 1.1.0 은 `build/` 를 쓰지 않고 `prebuilds/` 를 tarball 에
포함하므로 복사할 것이 없다. 진짜 문제는 다른 데 있었다 — `--ignore-scripts` 가
`fix-node-pty-perms.cjs` 를 건너뛰어 `spawn-helper` 가 `0644` 로 남고, 그러면
PTY 스폰이 런타임에 실패한다.

그래서 이 스크립트는 `--ignore-scripts` 를 아예 쓰지 않는다. postinstall 을
정상 실행하면 권한도 도구 언팩도 실제 설치와 동일하게 처리된다. 실측으로
`spawn-helper` 가 `-rwxr-xr-x` 로 나오는 것을 확인했다.
