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
    /** Called per file that survived the filter. */
    onFile?: (absPath: string, relPath: string, stats: Stats) => void | Promise<void>
    /** Called per directory that survived the filter (before descending). */
    onDirectory?: (absPath: string, relPath: string) => void | Promise<void>
    /** Max descent levels below root. 0 = only direct children. Unlimited if omitted. */
    maxDepth?: number
}

export async function walkWorkspace(opts: WalkWorkspaceOptions): Promise<void> {
    const rootCtx = createGitignoreContext(opts.presetMatcher)
    await walkDir(opts.root, '', rootCtx, opts, 0)
}

async function walkDir(
    absDir: string,
    relDir: string,
    ctx: GitignoreContext,
    opts: WalkWorkspaceOptions,
    depth: number,
): Promise<void> {
    const localCtx = await enterDirectory(ctx, absDir, relDir)

    let entries
    try {
        entries = await readdir(absDir, { withFileTypes: true })
    } catch {
        return
    }

    for (const entry of entries) {
        if (entry.isSymbolicLink()) continue

        const name = entry.name
        const entryRel = relDir ? `${relDir}/${name}` : name
        const entryAbs = join(absDir, name)
        const isDir = entry.isDirectory()

        if (localCtx.ignores(entryRel, isDir)) continue

        if (isDir) {
            if (opts.onDirectory) await opts.onDirectory(entryAbs, entryRel)
            if (opts.maxDepth === undefined || depth < opts.maxDepth) {
                await walkDir(entryAbs, entryRel, localCtx, opts, depth + 1)
            }
        } else if (entry.isFile() && opts.onFile) {
            let stats: Stats
            try {
                stats = await stat(entryAbs)
            } catch {
                continue
            }
            await opts.onFile(entryAbs, entryRel, stats)
        }
    }
}
