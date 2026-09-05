/**
 * 자동화 worktree 를 지워도 되는지 판정한다.
 *
 * 2026-09-04 프로덕션 — worktree 45개(23GB)가 지워지지 않고 쌓였다. 정리는
 * `git status --porcelain` 이 한 줄이라도 있으면 dirty 로 보고 보존하는데, 실제
 * 사유가 작업물이 아니었다:
 *
 *   ?? memory/        에이전트가 세션 중 만든 메모리 디렉토리
 *    M vendor/happy   서브모듈 gitlink — 브랜치마다 달라 항상 modified
 *
 * 리뷰가 정상 종료해도 매번 dirty 라 영영 안 지워졌고, 그 자동화는 worktree 게이트
 * (pendingGithubWorktreeAutomationIds)에 걸려 다음 이벤트를 처리하지 못했다. 한
 * 자동화가 worktree 30개를 깔고 앉아 있었다.
 *
 * 판정은 여전히 보수적이다 — 무해하다고 아는 것만 무시하고, 하나라도 진짜 변경이
 * 섞여 있으면 지킨다. 목록을 넓힐 때는 "잃어도 되는가" 를 기준으로 판단할 것.
 */

/** 에이전트가 남기는 산출물. 저장소 내용이 아니다. */
const SCRATCH_UNTRACKED = [
  'memory/',
  '.omc/',
  'node_modules/',
  // 2026-09-05 — 리뷰 워커가 제출을 끝낸 뒤 `.agenttask-3446-result.json` 을 루트에
  // 남겼다. 그 한 줄로 정리가 거부되고 자동화가 worktree 게이트에 걸려 그 저장소의
  // 리뷰가 통째로 멈췄다. 결과는 이미 서버에 있으므로 파일에는 잃을 것이 없다.
  // 루트의 것만 무시한다 — 하위 경로에 같은 이름이 있으면 그건 저장소 내용이다.
  '.agenttask-',
];

/**
 * gitlink 자체가 다른 커밋을 가리키는 경우. 서브모듈 *안의* 변경은 별개이므로
 * 경로가 정확히 일치할 때만 무시한다.
 */
const GITLINK_PATHS = [
  'vendor/happy',
];

function isIgnorableEntry(line: string): boolean {
  const status = line.slice(0, 2);
  const path = line.slice(3).trim();
  if (path.length === 0) return false;
  if (status === '??') {
    return SCRATCH_UNTRACKED.some((prefix) => path === prefix || path.startsWith(prefix));
  }

  if (status === ' M' || status === 'M ') {
    return GITLINK_PATHS.includes(path);
  }
  return false;
}

/**
 * `git status --porcelain --untracked-files=all` 출력에 잃으면 안 되는 변경이
 * 있는지 본다.
 */
export function hasUnsavedWorktreeChanges(porcelainStatus: string): boolean {
  return unsavedEntries(porcelainStatus).length > 0;
}

/** 한 로그 줄에 담을 만큼만. 목록이 길다는 사실 자체가 이미 신호다. */
const MAX_DESCRIBED_PATHS = 10;

/**
 * 정리를 막고 있는 경로들. 2026-09-05 에는 로그가 "dirty" 라고만 해서, 무엇 때문에
 * 그 저장소의 리뷰 큐가 멈췄는지 알아내려면 사람이 직접 git status 를 쳐야 했다.
 */
export function describeUnsavedWorktreeChanges(porcelainStatus: string): string[] {
  return unsavedEntries(porcelainStatus)
    .slice(0, MAX_DESCRIBED_PATHS)
    .map((line) => line.slice(3).trim());
}

function unsavedEntries(porcelainStatus: string): string[] {
  return porcelainStatus
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.trim().length > 0)
    .filter((line) => !isIgnorableEntry(line));
}
