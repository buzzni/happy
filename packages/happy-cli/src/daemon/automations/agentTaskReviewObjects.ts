import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const FETCH_TIMEOUT_MS = 120_000;
const FETCH_MAX_BUFFER = 2 * 1024 * 1024;

// 셸이 아니라 execFile 로 넘기지만, remote 에 그대로 전달되는 값이므로 형태를
// 좁혀 받는다. git 객체 이름은 40(SHA-1)~64(SHA-256) hex 다.
const SHA_PATTERN = /^[0-9a-f]{40,64}$/i;

export interface ReviewObjectCommand {
  executable: 'git';
  args: string[];
  cwd: string;
  environmentVariables?: Record<string, string>;
}

export type ReviewObjectCommandResult =
  | { ok: true; stdout: string }
  | { ok: false; error: string };

/**
 * pr_review dispatch input 에서 확보해야 할 커밋을 고른다.
 *
 * 2026-08-31 프로덕션 — 프로젝트 워크스페이스가 `+refs/heads/<기본브랜치>` 단일
 * refspec 의 shallow clone 이라 PR 커밋이 존재하지 않았고, AgentTask 리뷰가
 * "호출부 검증과 소스 SHA 테스트를 실행하지 못했다" 고 보고했다. preset 은 워커가
 * 스스로 PR 을 checkout 하거나 GitHub 를 조회하는 것을 금지하므로, 워커가 아니라
 * 이 자리에서 객체를 준비해 줘야 한다.
 */
export function reviewShasFromDispatchInput(input: unknown): string[] {
  if (!input || typeof input !== 'object') return [];
  const record = input as Record<string, unknown>;
  const shas = [record.baseSha, record.headSha]
    .filter((value): value is string => typeof value === 'string' && SHA_PATTERN.test(value));
  return [...new Set(shas)];
}

async function defaultRunCommand(command: ReviewObjectCommand): Promise<ReviewObjectCommandResult> {
  try {
    const result = await execFileAsync(command.executable, command.args, {
      cwd: command.cwd,
      env: command.environmentVariables
        ? { ...process.env, ...command.environmentVariables }
        : process.env,
      timeout: FETCH_TIMEOUT_MS,
      maxBuffer: FETCH_MAX_BUFFER,
    });
    return { ok: true, stdout: result.stdout };
  } catch (error) {
    const failure = error as { stderr?: string; message?: string };
    return { ok: false, error: failure.stderr?.trim() || failure.message || 'command failed' };
  }
}

/**
 * base/head 커밋을 워크스페이스에 확보한다. checkout 은 하지 않는다 — 객체만 있으면
 * `git show`·`git diff` 로 변경 주변 코드와 호출부를 읽을 수 있고, 사용자의 작업
 * 사본을 건드리지 않는다.
 *
 * 실패해도 리뷰 자체는 immutable diff artifact 로 진행할 수 있으므로 호출부는 멈추지
 * 않는다. 다만 사유는 반드시 드러낸다 — 조용히 넘어가면 리뷰 품질이 낮아진 이유를
 * 아무도 모른다 (AGENTS.md §1.13).
 */
export async function ensureAgentTaskReviewObjects(input: {
  directory: string;
  shas: string[];
  runCommand?: (command: ReviewObjectCommand) => Promise<ReviewObjectCommandResult>;
  has?: (sha: string) => Promise<boolean>;
  environmentVariables?: Record<string, string>;
}): Promise<{ ok: true; fetched: string[] } | { ok: false; error: string }> {
  if (input.shas.length === 0) return { ok: true, fetched: [] };
  const runCommand = input.runCommand ?? defaultRunCommand;
  const has = input.has ?? (async (sha: string) => (await runCommand({
    executable: 'git',
    args: ['cat-file', '-e', `${sha}^{commit}`],
    cwd: input.directory,
    ...(input.environmentVariables ? { environmentVariables: input.environmentVariables } : {}),
  })).ok);

  const missing: string[] = [];
  for (const sha of input.shas) {
    if (!await has(sha)) missing.push(sha);
  }
  if (missing.length === 0) return { ok: true, fetched: [] };

  // 옵션은 최소로 둔다. `--no-write-fetch-head` 는 git 2.29+ 전용이라 2.25 를 쓰는
  // 프로덕션 머신에서 usage 만 출력하고 아무것도 받아오지 않는다 — 확인 없이 붙였다가
  // "성공했는데 객체가 없는" 조용한 실패를 만들 뻔했다.
  const fetched = await runCommand({
    executable: 'git',
    args: ['fetch', '--no-tags', 'origin', ...missing],
    cwd: input.directory,
    ...(input.environmentVariables ? { environmentVariables: input.environmentVariables } : {}),
  });
  if (!fetched.ok) return { ok: false, error: fetched.error };
  return { ok: true, fetched: missing };
}

/**
 * pr_review dispatch input 에서 worktree 요청을 만든다.
 *
 * 2026-09-01 프로덕션 — AgentTask 리뷰만 프로젝트 디렉터리에서 그대로 돌아 HEAD 가
 * 리뷰 대상과 달랐고, 워커가 "대상 SHA 테스트를 실행하지 못했다" 고 보고했다.
 * start-session 리뷰는 이미 전용 worktree 를 받는다 — 같은 대우를 해준다.
 *
 * SHA 는 planned 이벤트가 아니라 dispatch input 에서 가져와야 한다. 큐에서 나온
 * task 는 지금 감지한 PR 과 다른 PR 일 수 있다.
 */
export function reviewWorktreeRequestFromDispatchInput(
  input: unknown,
): { pullRequest: { number: number; expectedHeadSha: string } } | null {
  if (!input || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  const number = record.prNumber;
  const headSha = record.headSha;
  if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) return null;
  if (typeof headSha !== 'string' || !SHA_PATTERN.test(headSha)) return null;
  return { pullRequest: { number, expectedHeadSha: headSha } };
}
