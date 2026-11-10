import { execFile } from 'node:child_process'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { unsavedUntrackedPaths } from './worktreeDirtyState'

/*
 * 데몬이 더는 보존하지 않기로 한 자동화 worktree 의 남은 변경을 지우기 전에 남긴다.
 *
 * 2026-11-09 프로덕션 — dirty 를 "사람이 회수할 때까지" 기한 없이 지키던 worktree 가
 * 59일·63개(38GB)까지 쌓였다. 대부분 리뷰 워커의 lockfile 갱신·재현 테스트였고, 나머지는
 * 사용 한도에 걸려 커밋 전에 멈춘 review_apply 였다. 아무도 회수하지 않았다. 지우되,
 * 되살릴 수 있게 패치와 새 파일을 남긴다.
 */

type RunGit = (args: string[], cwd: string) => Promise<string>

const execFileAsync = promisify(execFile)

/** 보관본을 이만큼 지나면 지운다. 보관 자체가 다시 새는 곳이 되지 않도록. */
export const GITHUB_WORKTREE_ARCHIVE_RETENTION_MS = 30 * 24 * 60 * 60_000

/**
 * `changes.patch` 는 HEAD 기준 staged+unstaged 변경이고 `git apply --index` 로 되살린다.
 * 사용자 diff 설정(noprefix·색·외부 diff)이 끼지 않게 형식을 고정하고, 크기 상한이 있는
 * 명령 출력 대신 git 이 파일로 직접 쓴다. `info.json` 을 마지막에 써서 완성 표시로 삼는다.
 */
export async function archiveGithubWorktreeChanges(input: {
  repositoryRoot: string
  worktreePath: string
  archiveTo: string
  porcelainStatus: string
  runGit: RunGit
}): Promise<void> {
  const { worktreePath, archiveTo } = input
  await mkdir(archiveTo, { recursive: true, mode: 0o700 })
  const head = (await input.runGit(['rev-parse', 'HEAD'], worktreePath)).trim()
  await input.runGit([
    'diff', '--binary', '--no-renames', '--no-color', '--no-ext-diff', '--no-textconv',
    '--src-prefix=a/', '--dst-prefix=b/', '--ignore-submodules=all',
    `--output=${join(archiveTo, 'changes.patch')}`, 'HEAD',
  ], worktreePath)
  const untracked = await input.runGit(['ls-files', '--others', '--exclude-standard', '-z'], worktreePath)
  for (const path of unsavedUntrackedPaths(untracked)) {
    await cp(join(worktreePath, path), join(archiveTo, 'untracked', path), { recursive: true })
  }
  await writeFile(join(archiveTo, 'status.txt'), input.porcelainStatus)
  await writeFile(join(archiveTo, 'info.json'), `${JSON.stringify({
    repositoryRoot: input.repositoryRoot, worktreePath, head, archivedAt: new Date().toISOString(),
  }, null, 2)}\n`)
}

/**
 * Chat 재개가 보관하고 지운 worktree 를 기록된 커밋으로 되살렸을 때, 보관한 변경을 다시 얹는다.
 * 그러지 않으면 재개한 세션은 깨끗한 트리에서 깨어나고, 했다고 기억하는 수정은 보관본에만 남는다.
 * 보관본이 없거나 다른 worktree·커밋의 것이면 false. 얹은 뒤에는 보관본을 지운다 — 변경은 이제
 * worktree 에 있고, 남겨 두면 다음 재개에 다시 얹힌다. 얹다가 실패하면 보관본은 그대로 둔다.
 */
export async function restoreArchivedGithubWorktreeChanges(input: {
  archiveFrom: string
  worktreePath: string
}): Promise<boolean> {
  const { archiveFrom, worktreePath } = input
  const info = await readFile(join(archiveFrom, 'info.json'), 'utf8')
    .then((text) => JSON.parse(text) as { worktreePath?: unknown; head?: unknown }, () => null)
  if (typeof info?.worktreePath !== 'string' || resolve(info.worktreePath) !== resolve(worktreePath)) return false
  const { stdout: head } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf8', windowsHide: true })
  if (info.head !== head.trim()) return false
  const patch = join(archiveFrom, 'changes.patch')
  if ((await stat(patch)).size > 0) await execFileAsync('git', ['apply', '--index', patch], { cwd: worktreePath, windowsHide: true })
  const untracked = join(archiveFrom, 'untracked')
  if (await stat(untracked).then(() => true, () => false)) await cp(untracked, worktreePath, { recursive: true })
  await rm(archiveFrom, { recursive: true, force: true })
  return true
}

/** `archiveRoot` 아래에서 보관 기간이 지난 보관본을 지운다. 없으면 아무 일도 하지 않는다. */
export async function pruneGithubWorktreeArchives(archiveRoot: string, now: number): Promise<void> {
  const entries = await readdir(archiveRoot, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const path = join(archiveRoot, entry.name)
    if (now - (await stat(path)).mtimeMs >= GITHUB_WORKTREE_ARCHIVE_RETENTION_MS) {
      await rm(path, { recursive: true, force: true })
    }
  }
}
