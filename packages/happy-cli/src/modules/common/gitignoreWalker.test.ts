/**
 * Tests for the gitignore-aware walker.
 *
 * ⚠️ Mirror of aplus-dev-studio/packages/web-ui/src/lib/gitignoreWalker.spec.ts —
 * update both files together when a rule changes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Counts the walker's stat calls (adapted from the AgentTask review fix, buzzni/happy#1043).
const statCalls = vi.hoisted(() => ({ count: 0 }))
vi.mock('fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs/promises')>()
    return { ...actual, stat: (...args: Parameters<typeof actual.stat>) => { statCalls.count++; return actual.stat(...args) } }
})
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import {
    walkWorkspace,
    compareRelPaths,
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

    /*
     * aplus-dev-studio specs/remote-file-list-pages R4 — a page resumes from the
     * last relPath it returned, so the walk order must be the same every time and
     * agree with compareRelPaths.
     */
    describe('ordered, resumable walk', () => {
        async function walkInOrder(opts: Partial<Parameters<typeof walkWorkspace>[0]> = {}): Promise<string[]> {
            const files: string[] = []
            await walkWorkspace({ root, presetMatcher, onFile: (_abs, rel) => { files.push(rel) }, ...opts })
            return files
        }

        beforeEach(async () => {
            for (const rel of ['b.txt', 'a/z.txt', 'a/b/c.txt', 'a.txt', 'a-b/x.txt', 'C.txt']) await write(rel)
        })

        it('visits files in path-segment order', async () => {
            const files = await walkInOrder()

            expect(files).toEqual(['C.txt', 'a/b/c.txt', 'a/z.txt', 'a-b/x.txt', 'a.txt', 'b.txt'])
            expect([...files].sort(compareRelPaths)).toEqual(files)
        })

        it('resumes after a file, including one inside a directory it has to re-enter', async () => {
            await expect(walkInOrder({ after: 'a/b/c.txt' })).resolves.toEqual(['a/z.txt', 'a-b/x.txt', 'a.txt', 'b.txt'])
            await expect(walkInOrder({ after: 'a-b/x.txt' })).resolves.toEqual(['a.txt', 'b.txt'])
        })

        it('resumes after a file that no longer exists', async () => {
            await expect(walkInOrder({ after: 'a/m.txt' })).resolves.toEqual(['a/z.txt', 'a-b/x.txt', 'a.txt', 'b.txt'])
        })

        it('stops when onFile returns false', async () => {
            const files: string[] = []
            await walkWorkspace({ root, presetMatcher, onFile: (_abs, rel) => { files.push(rel); return files.length < 2 } })

            expect(files).toEqual(['C.txt', 'a/b/c.txt'])
        })

        it('stats only the files near where it stops, not the rest of each directory', async () => {
            // Each page of listFilesPage walks from the root and stops at its limit, so
            // stat work past the stop point is repeated on every page.
            for (let i = 0; i < 300; i++) await write(`a/f${String(i).padStart(3, '0')}.txt`)
            for (let i = 0; i < 300; i++) await write(`z${String(i).padStart(3, '0')}.txt`)
            statCalls.count = 0

            const files: string[] = []
            await walkWorkspace({ root, presetMatcher, onFile: (_abs, rel) => { files.push(rel); return false } })

            expect(files).toEqual(['C.txt'])
            expect(statCalls.count).toBeLessThan(200)

            statCalls.count = 0
            const resumed: string[] = []
            await walkWorkspace({ root, presetMatcher, after: 'a/b/c.txt', onFile: (_abs, rel) => { resumed.push(rel); return resumed.length < 5 } })

            expect(resumed).toEqual(['a/f000.txt', 'a/f001.txt', 'a/f002.txt', 'a/f003.txt', 'a/f004.txt'])
            expect(statCalls.count).toBeLessThan(200)
        })
    })
})

describe('compareRelPaths', () => {
    it('orders by segment, so a directory sorts by its own name', () => {
        expect(['a.txt', 'a/z', 'a-b/x'].sort(compareRelPaths)).toEqual(['a/z', 'a-b/x', 'a.txt'])
        expect(compareRelPaths('a/b', 'a/b')).toBe(0)
        expect(compareRelPaths('a', 'a/b')).toBeLessThan(0)
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
