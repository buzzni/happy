/**
 * Gitignore-aware workspace walker (Node-only, pure).
 *
 * ⚠️ Mirror of aplus-dev-studio/packages/web-ui/src/lib/gitignoreWalker.ts —
 * keep the two copies byte-identical except for indentation when adding
 * features. See aplus-dev-studio's specs/gitignore-aware-filtering/ for
 * the larger plan.
 *
 * Filters filesystem traversals by applying preset presets ∪ the
 * cascading rules found in `.gitignore` files at every directory
 * level. The daemon uses the low-level `createGitignoreContext` +
 * `enterDirectory` pair from inside its existing `getDirectoryTree`
 * recursion — keeps the tree-building code unchanged structurally.
 *
 * Semantics:
 *   - preset matcher (file-ignore-presets) wins over `.gitignore`
 *     !negation. If someone writes `!node_modules` we still skip it.
 *   - Gitignored directories are never descended (standard git rule).
 *   - Symbolic links are skipped wholesale.
 *   - The `.gitignore` file itself is always listed so users can edit it.
 */

import ignore, { type Ignore } from 'ignore'
import { readdir, readFile, stat } from 'fs/promises'
import { join } from 'path'
import type { Stats } from 'fs'
import type { IgnoreMatcher } from './ignorePresets'

interface GitignoreScope {
    /** Relative path of the directory that owns this .gitignore ('' for root). */
    dirRel: string
    ig: Ignore
}

export interface GitignoreContext {
    /** True if a path (relative to the walk root) should be filtered. */
    ignores(relPath: string, isDirectory: boolean): boolean
    /** Returns a new context with an additional `.gitignore` layered on. */
    withGitignore(dirRel: string, gitignoreContents: string): GitignoreContext
}

export function createGitignoreContext(presetMatcher: IgnoreMatcher): GitignoreContext {
    return makeContext([], presetMatcher)
}

function makeContext(scopes: readonly GitignoreScope[], presetMatcher: IgnoreMatcher): GitignoreContext {
    return {
        ignores(relPath: string, isDirectory: boolean): boolean {
            if (presetMatcher.shouldIgnore(relPath)) return true
            for (const scope of scopes) {
                const scoped = pathRelativeToScope(relPath, scope.dirRel)
                if (scoped === null) continue
                const checkable = isDirectory ? `${scoped}/` : scoped
                if (scope.ig.ignores(checkable)) return true
            }
            return false
        },
        withGitignore(dirRel: string, gitignoreContents: string): GitignoreContext {
            const ig = ignore().add(gitignoreContents)
            return makeContext([...scopes, { dirRel, ig }], presetMatcher)
        },
    }
}

function pathRelativeToScope(relPath: string, dirRel: string): string | null {
    if (dirRel === '') return relPath
    if (relPath === dirRel) return ''
    if (relPath.startsWith(`${dirRel}/`)) return relPath.slice(dirRel.length + 1)
    return null
}

/**
 * Reads `.gitignore` at the given directory (if present) and returns a
 * context that layers its rules on top of the input. Returns the input
 * context unchanged when there is no `.gitignore` or the directory is
 * unreadable — callers can drop-in replace their context without
 * checking.
 */
export async function enterDirectory(
    ctx: GitignoreContext,
    absDir: string,
    relDir: string,
): Promise<GitignoreContext> {
    try {
        const contents = await readFile(join(absDir, '.gitignore'), 'utf-8')
        return ctx.withGitignore(relDir, contents)
    } catch {
        return ctx
    }
}

export interface WalkWorkspaceOptions {
    root: string
    presetMatcher: IgnoreMatcher
    /** Called per file that survived the filter. Returning `false` stops the walk. */
    onFile?: (absPath: string, relPath: string, stats: Stats) => boolean | void | Promise<boolean | void>
    /** Called per directory that survived the filter (before descending). */
    onDirectory?: (absPath: string, relPath: string) => void | Promise<void>
    /** Max descent levels below root. 0 = only direct children. Unlimited if omitted. */
    maxDepth?: number
    /** Visit only paths that sort after this relPath (compareRelPaths), to resume a walk. */
    after?: string
}

/**
 * The order walkWorkspace visits paths in: segment by segment, by UTF-16 code
 * unit. Comparing segments rather than whole strings keeps a directory's
 * contents together ('a/z' before 'a-b', although '/' sorts after '-').
 */
export function compareRelPaths(a: string, b: string): number {
    const as = a.split('/')
    const bs = b.split('/')
    for (let i = 0; i < Math.min(as.length, bs.length); i++) {
        if (as[i] !== bs[i]) return as[i] < bs[i] ? -1 : 1
    }
    return as.length - bs.length
}

export async function walkWorkspace(opts: WalkWorkspaceOptions): Promise<void> {
    const rootCtx = createGitignoreContext(opts.presetMatcher)
    await walkDir(opts.root, '', rootCtx, opts, 0)
}

/** How many files of a directory walkDir stats ahead of the one it is visiting. */
const STAT_AHEAD = 64

/** Answers false once onFile asked the walk to stop. */
async function walkDir(
    absDir: string,
    relDir: string,
    ctx: GitignoreContext,
    opts: WalkWorkspaceOptions,
    depth: number,
): Promise<boolean> {
    const localCtx = await enterDirectory(ctx, absDir, relDir)

    let entries
    try {
        entries = await readdir(absDir, { withFileTypes: true })
    } catch {
        return true
    }
    entries.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))

    const kept = entries.flatMap((entry) => {
        if (entry.isSymbolicLink()) return []
        const entryRel = relDir ? `${relDir}/${entry.name}` : entry.name
        const isDir = entry.isDirectory()
        // A directory on the way to `after` is re-entered; anything else at or
        // before it was already visited.
        if (opts.after !== undefined && !(isDir && opts.after.startsWith(`${entryRel}/`))
            && compareRelPaths(entryRel, opts.after) <= 0) return []
        if (localCtx.ignores(entryRel, isDir)) return []
        return [{ entry, entryRel, entryAbs: join(absDir, entry.name), isDir }]
    })
    // Stat the next few files ahead of the one in use: one at a time, a large
    // walk spends most of its time waiting on each stat in turn. Only a window
    // ahead, because a walk that stops (a page of listFilesPage) throws away
    // whatever it started, and the next page walks the same path again.
    const fileStats: (Promise<Stats | null> | null)[] = []
    const statAhead = (end: number) => {
        for (let j = fileStats.length; j < Math.min(end, kept.length); j++) {
            const { entry, entryAbs } = kept[j]
            fileStats.push(entry.isFile() && opts.onFile ? stat(entryAbs).catch(() => null) : null)
        }
    }

    for (const [i, { entry, entryRel, entryAbs, isDir }] of kept.entries()) {
        if (isDir) {
            if (opts.onDirectory) await opts.onDirectory(entryAbs, entryRel)
            if (opts.maxDepth === undefined || depth < opts.maxDepth) {
                if (!await walkDir(entryAbs, entryRel, localCtx, opts, depth + 1)) return false
            }
        } else if (entry.isFile() && opts.onFile) {
            statAhead(i + STAT_AHEAD)
            const stats: Stats | null = await fileStats[i]
            if (!stats) continue
            if (await opts.onFile(entryAbs, entryRel, stats) === false) return false
        }
    }
    return true
}
