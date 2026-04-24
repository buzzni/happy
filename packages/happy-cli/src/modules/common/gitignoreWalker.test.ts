/**
 * Tests for the gitignore-aware walker.
 *
 * ⚠️ Mirror of aplus-dev-studio/packages/web-ui/src/lib/gitignoreWalker.spec.ts —
 * update both files together when a rule changes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import {
    walkWorkspace,
    createGitignoreContext,
    enterDirectory,
    type GitignoreContext,
} from './gitignoreWalker'
import { createIgnoreMatcher } from './ignorePresets'

describe('walkWorkspace', () => {
    let root: string
    const presetMatcher = createIgnoreMatcher()

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'gitignore-walker-test-'))
    })
    afterEach(async () => {
        await rm(root, { recursive: true, force: true })
    })

    async function write(rel: string, contents = ''): Promise<void> {
        const abs = join(root, rel)
        await mkdir(dirname(abs), { recursive: true })
        await writeFile(abs, contents)
    }

    async function collectFiles(opts: Partial<Parameters<typeof walkWorkspace>[0]> = {}): Promise<string[]> {
        const files: string[] = []
        await walkWorkspace({
            root,
            presetMatcher,
            onFile: (_abs, rel) => {
                files.push(rel)
            },
            ...opts,
        })
        return files.sort()
    }

    it('walks a simple tree with no .gitignore', async () => {
        await write('src/index.ts')
        await write('README.md')
        expect(await collectFiles()).toEqual(['README.md', 'src/index.ts'])
    })

    it('keeps the .gitignore file itself visible (users must edit it)', async () => {
        await write('.gitignore', 'logs/\n')
        await write('src/main.ts')
        await write('logs/app.log')
        const files = await collectFiles()
        expect(files).toContain('.gitignore')
        expect(files).toContain('src/main.ts')
        expect(files).not.toContain('logs/app.log')
    })

    it('drops files under a gitignored directory at any depth', async () => {
        await write('.gitignore', 'tmp/\n')
        await write('tmp/a/b/c/deep.txt')
        await write('src/main.ts')
        const files = await collectFiles()
        expect(files.some((f) => f.startsWith('tmp/'))).toBe(false)
        expect(files).toContain('src/main.ts')
    })

    it('drops files matched by basename glob in .gitignore', async () => {
        await write('.gitignore', '*.log\n')
        await write('src/main.ts')
        await write('debug.log')
        await write('nested/app.log')
        const files = await collectFiles()
        expect(files).not.toContain('debug.log')
        expect(files).not.toContain('nested/app.log')
        expect(files).toContain('src/main.ts')
    })

    it('scopes nested .gitignore to its subdirectory', async () => {
        await write('src/.gitignore', 'local-cache/\n')
        await write('src/main.ts')
        await write('src/local-cache/blob.bin')
        // cache/ at root is NOT mentioned in any .gitignore → must survive
        await write('cache/kept.txt')
        const files = await collectFiles()
        expect(files).toContain('cache/kept.txt')
        expect(files).toContain('src/main.ts')
        expect(files).not.toContain('src/local-cache/blob.bin')
    })

    it('honours !negation within the same .gitignore', async () => {
        // "artifacts" is intentionally not in any preset — the test is about
        // gitignore semantics, not the preset baseline.
        await write('.gitignore', 'artifacts/*\n!artifacts/keep.txt\n')
        await write('artifacts/artifact.bin')
        await write('artifacts/keep.txt')
        const files = await collectFiles()
        expect(files).toContain('artifacts/keep.txt')
        expect(files).not.toContain('artifacts/artifact.bin')
    })

    it('preset wins over gitignore !negation (preset is the safety baseline)', async () => {
        // User mistakenly tries to re-include node_modules via .gitignore
        await write('.gitignore', '!node_modules\n')
        await write('node_modules/foo/index.js')
        await write('src/main.ts')
        const files = await collectFiles()
        expect(files.some((f) => f.startsWith('node_modules/'))).toBe(false)
        expect(files).toContain('src/main.ts')
    })

    it('skips symbolic links entirely', async () => {
        await write('real/file.txt')
        await symlink(join(root, 'real'), join(root, 'link'))
        const files = await collectFiles()
        expect(files).toEqual(['real/file.txt'])
    })

    it('respects maxDepth (0 = only root-level files)', async () => {
        await write('top.txt')
        await write('a/nested.txt')
        await write('a/b/deep.txt')
        const files = await collectFiles({ maxDepth: 0 })
        expect(files).toEqual(['top.txt'])
    })

    it('respects maxDepth (1 = root + one level down)', async () => {
        await write('top.txt')
        await write('a/nested.txt')
        await write('a/b/deep.txt')
        const files = await collectFiles({ maxDepth: 1 })
        expect(files).toEqual(['a/nested.txt', 'top.txt'])
    })

    it('calls onDirectory for directories that are kept', async () => {
        await write('.gitignore', 'build/\n')
        await write('src/main.ts')
        await write('build/artifact.bin')
        const dirs: string[] = []
        await walkWorkspace({
            root,
            presetMatcher,
            onDirectory: (_abs, rel) => {
                dirs.push(rel)
            },
        })
        expect(dirs.sort()).toEqual(['src'])
    })
})

describe('createGitignoreContext', () => {
    const presetMatcher = createIgnoreMatcher()

    it('starts with no gitignore rules — preset only', () => {
        const ctx = createGitignoreContext(presetMatcher)
        expect(ctx.ignores('src/index.ts', false)).toBe(false)
        expect(ctx.ignores('node_modules', true)).toBe(true) // preset
        expect(ctx.ignores('logs', true)).toBe(false) // no gitignore yet
    })

    it('withGitignore adds rules scoped to the given subdirectory', () => {
        const root = createGitignoreContext(presetMatcher)
        const withRoot = root.withGitignore('', 'logs/\n*.log\n')
        expect(withRoot.ignores('logs', true)).toBe(true)
        expect(withRoot.ignores('debug.log', false)).toBe(true)
        expect(withRoot.ignores('src/app.log', false)).toBe(true)
        expect(withRoot.ignores('src/main.ts', false)).toBe(false)
    })

    it('nested gitignore scope does not leak upward', () => {
        const root = createGitignoreContext(presetMatcher)
        const withSrc = root.withGitignore('src', 'local-cache/\n')
        expect(withSrc.ignores('src/local-cache', true)).toBe(true)
        expect(withSrc.ignores('local-cache', true)).toBe(false) // not under src/
    })

    it('preset beats gitignore !negation', () => {
        const ctx = createGitignoreContext(presetMatcher).withGitignore('', '!node_modules\n')
        expect(ctx.ignores('node_modules', true)).toBe(true)
    })

    it('returns a NEW context from withGitignore (pure, non-mutating)', () => {
        const a = createGitignoreContext(presetMatcher)
        const b = a.withGitignore('', 'logs/\n')
        expect(a.ignores('logs', true)).toBe(false)
        expect(b.ignores('logs', true)).toBe(true)
    })
})

describe('enterDirectory', () => {
    let root: string
    const presetMatcher = createIgnoreMatcher()

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'enter-dir-test-'))
    })
    afterEach(async () => {
        await rm(root, { recursive: true, force: true })
    })

    it('reads .gitignore when present and layers it onto the context', async () => {
        await writeFile(join(root, '.gitignore'), 'logs/\n')
        const initial = createGitignoreContext(presetMatcher)
        const next = await enterDirectory(initial, root, '')
        expect(next.ignores('logs', true)).toBe(true)
    })

    it('returns the same context object when no .gitignore is present', async () => {
        const initial = createGitignoreContext(presetMatcher)
        const next = await enterDirectory(initial, root, '')
        expect(next).toBe(initial)
    })

    it('handles a non-existent directory silently (falls back to the input context)', async () => {
        const initial: GitignoreContext = createGitignoreContext(presetMatcher)
        const next = await enterDirectory(initial, join(root, 'does-not-exist'), 'ghost')
        expect(next).toBe(initial)
    })
})
