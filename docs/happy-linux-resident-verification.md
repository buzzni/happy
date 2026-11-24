# Linux 상주 번들 검증 런북

Linux Happy 데몬이 대화 모듈 번들(`dist/win32-resident`)을 Claude·Codex 새 대화에 공급하는 경로(happy #1322, `1.1.10-aplus.434`부터)를 확인하는 절차다. 배경과 측정 기록은 [Happy 대화 프로세스 최적화](happy-conversation-process-optimization.md)에 있다.

검증은 두 단계로 한다.

1. **Mac 안의 Linux VM 검증** — 릴리스 전에 코드와 샌드박스 경계를 확인한다. 로그인 없이 할 수 있다.
2. **등록 Linux 작업 머신 검증** — 릴리스 후 실제 대화로 확인한다.

## 반드시 확인할 것

Linux 샌드박스 런타임은 seccomp 필터 `vendor/seccomp/<arch>/unix-block.bpf`를 자기 모듈 파일 기준으로 찾는다. 번들로 묶으면 모듈 위치가 `dist/`로 바뀐다. 그래서 `bundle-resident-session.mjs`가 필터와 `apply-seccomp`를 `dist/vendor/seccomp`에 복사한다.

필터를 찾지 못하면 런타임은 오류 없이 경고만 남기고 unix 소켓 제한을 빼고 실행한다. 이 문서의 핵심 확인은 **번들 상태에서 unix 소켓 생성이 막히는지**다.

데몬은 이 머신 아키텍처(x64·arm64)의 필터가 번들 옆에 없으면 상주 번들을 쓰지 않는다(`bundledSeccompFilterPresent`). Node에 `module.registerHooks`가 없을 때(22.15 미만)도 쓰지 않는다.

## 1. Mac 안의 Linux VM 검증

### 함정

- **전역 docker 설정이 바뀐다.** `colima start`는 기본으로 전역 docker context를 새 VM으로 바꾼다. 그 사이 실행 중인 Happy 데몬의 스크립트 사전 점검(`docker create … proxy`)이 새 VM에 붙어 자격 증명 도우미에서 멈출 수 있다.
  - 대책: 항상 `--activate=false`로 켜고, 명령마다 `DOCKER_HOST=unix://$HOME/.colima/<profile>/docker.sock`을 지정한다.
  - `colima stop`도 context를 `default`로 바꿀 수 있다. 끝나면 `docker context show`로 원래 값을 확인하고 되돌린다.
- **이미지 pull이 멈춘다.** `~/.docker/config.json`의 credsStore(`desktop`·`osxkeychain`)가 멈춰 `docker pull`이 진행되지 않을 수 있다. 빈 설정 폴더(`DOCKER_CONFIG=<scratch>/dockercfg`, 내용 `{}`)를 쓴다.
- **빌드가 메모리 부족으로 죽는다.** VM 기본 힙으로는 `tsc`가 메모리 부족으로 죽는다. 빌드할 때만 `NODE_OPTIONS=--max-old-space-size=4096`을 준다.
- **x64는 실제 차단을 확인할 수 없다.** `--platform linux/amd64` 컨테이너는 qemu 에뮬레이션이다. `bwrap: Creating new namespace failed`로 샌드박스가 시작되지 않는다. x64는 필터 위치·시작·파일 동일성까지만 확인되고, 실제 차단은 실제 x64 머신에서 본다.

### 준비

```bash
colima start <profile> --activate=false --cpu 4 --memory 6 --disk 30 --runtime docker
export DOCKER_HOST=unix://$HOME/.colima/<profile>/docker.sock DOCKER_CONFIG=<scratch>/dockercfg
docker run -d --privileged --name <c> node:22-bookworm sleep infinity
git archive --format=tar HEAD | docker exec -i <c> sh -c 'mkdir -p /work && tar -x -C /work'
docker exec <c> sh -c 'apt-get update -qq && apt-get install -y -qq bubblewrap socat ripgrep python3 curl time'
docker exec -w /work <c> sh -c 'corepack enable && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile'
docker exec -w /work/packages/happy-cli <c> sh -c 'NODE_OPTIONS=--max-old-space-size=4096 pnpm run build'
```

`--privileged`는 bwrap이 네임스페이스를 만들기 위해 필요하다. 샌드박스 런타임은 `rg`가 없으면 초기화를 거부한다.

### 확인 항목

1. **빌드 결과**: `dist/vendor/seccomp/{x64,arm64}/`에 `unix-block.bpf`와 실행 권한 있는 `apply-seccomp`가 있어야 한다. 원본(`node_modules/.pnpm/@anthropic-ai+sandbox-runtime@*/…/vendor/seccomp`)과 sha256이 같아야 한다.
2. **단위 테스트**: `vitest run --project unit src/daemon/residentModuleHost.test.ts`. Linux 활성 조건, 필터 동봉, 빌드한 CLI의 상주 번들 시작을 다룬다.
3. **샌드박스 경계**: 상주 번들과 같은 esbuild 설정(`scripts/bundle-resident-session.mjs`의 `external`·`banner`·`splitting`)으로 작은 검사 프로그램을 묶는다. 이 프로그램은 `SandboxManager.initialize` → `wrapWithSandbox`로 명령을 실행하고, `getPreGeneratedBpfPath()`를 출력한다. 두 곳에 두고 비교한다.

   | 위치 | 필터 | 허용 폴더 쓰기 | 바깥 쓰기 | 네트워크 | unix 소켓 생성 |
   | --- | --- | --- | --- | --- | --- |
   | `dist/` (상주 번들과 같은 배치) | `dist/vendor/seccomp/<arch>/unix-block.bpf` | 성공 | 막힘 | 막힘 | **`Operation not permitted`** |
   | 필터 없는 폴더 (대조) | `null` | 성공 | 막힘 | 막힘 | 막히지 않음 |

   unix 소켓 확인 명령: `python3 -c "import socket; socket.socket(socket.AF_UNIX).connect('/tmp/none.sock')"`. 막히지 않으면 `FileNotFoundError`가 나온다.
4. **시간과 부하**: `startResidentModuleHost(root)`를 띄우고 `bin/happy-resident-session.mjs --version`과 `dist/index.mjs --version`을 번갈아 잰다. 동시 1·5·10·20개 시작의 CPU(`/usr/bin/time -f '%e %U %S %M'`)와 최대 RSS, 종료 시 GC 뒤 RSS·힙도 함께 잰다. 정리 후 메모리는 `--import`로 `process.on('exit')`에서 `gc()`와 `process.memoryUsage()`를 기록하는 방법을 쓴다. `--version`은 `process.exit`로 끝나기 때문이다.
5. **정리**: 컨테이너를 지우고 VM을 멈추거나 지운다(`colima delete <profile> --force`). 남은 docker context(`colima-<profile>`)를 지우고 전역 context를 원래 값으로 되돌린다.

### 2026-11-22 기록 (arm64 VM 4코어·6GB, Node 22.23.5)

- 샌드박스 경계: 위 표 그대로 나왔다(대조군에서는 unix 소켓이 막히지 않음).
- `--version` 시작: 752ms → 503ms.
- 동시 10개 시작: 전체 4.16초 → 2.57초, CPU 합계 16.3초 → 9.8초.
- 대화당 최대 RSS는 시작 순간 약 +30MB였고, 정리 후 RSS는 227MB 대 228MB로 같았다. 데몬은 +20MB였다.
- x64(에뮬레이션): 필터 경로를 찾고 상주 시작에 성공했으며, 원본과 파일이 같았다. 실제 차단은 위 함정 때문에 미확인이다.

## 2. 등록 Linux 작업 머신 검증 (릴리스 후)

1. **버전과 조건 확인**: 데몬을 실행하는 사용자와 Node 환경에서 업데이트한다.
   ```bash
   npm install -g '@buzzni/happy-cli@<릴리스 버전>' --prefer-online
   happy --version
   node -p "typeof require('node:module').registerHooks"   # function 이어야 상주 경로를 쓴다
   uname -m                                               # x86_64 또는 aarch64
   ls "$(npm root -g)/@buzzni/happy-cli/dist/vendor/seccomp"
   ```
2. **데몬 재시작**: 기존 운영 방식(서비스 등)으로 다시 띄운다. 데몬과 같은 Happy 홈에서 `happy daemon status`를 보고, `daemon.state.json`의 `startedWithCliVersion`이 업데이트한 버전인지 확인한다. 기본 홈은 `~/.happy`이고, `HAPPY_HOME_DIR`를 쓰면 그 홈을 본다.
3. **상주 경로 확인**: Saycode에서 이 머신의 프로젝트에 Claude·Codex 새 대화를 연다. 대화 프로세스 PID로 `ps -o command= -p <pid>`를 확인한다. `bin/happy-resident-session.mjs`이면 상주 경로이고, `dist/index.mjs`이면 기존 경로다. Happy 홈의 `logs/daemon-session-startup.log`에 `[timing] resident Happy modules ready`가 있는지도 본다. 데몬이 막 켜진 직후의 첫 대화는 기존 경로일 수 있다.
4. **대화**: 각 대화에 `2+3의 답을 숫자만 적어줘` → `5`, 이어서 `방금 답에 1을 더한 값도 숫자만 적어줘` → `6`이 나오고, 응답이 끝나면 작업 표시가 해제돼야 한다.
5. **샌드박스**: 샌드박스가 켜진 프로젝트 대화에서 Bash로 실행시킨다.
   - `echo inside > inside.txt`: 성공해야 한다.
   - `echo outside > ~/<임시 이름>.txt`: 막혀야 한다.
   - `python3 -c "import socket; socket.socket(socket.AF_UNIX)"`: `Operation not permitted`여야 한다.
   - 홈에 파일이 생기지 않았는지 확인한다.
6. **되돌리기**: 문제가 있으면 데몬 환경에 `HAPPY_DISABLE_RESIDENT_MODULES=1`을 주고 다시 시작한다. 같은 빌드가 기존 경로로 돌아간다. 이전 버전으로 되돌려도 된다.

기록에는 가상 질문, 시각, PID, 버전만 남긴다. 로그인 파일, 인증값, 실제 대화 내용은 복사하지 않는다.
