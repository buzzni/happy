/**
 * Centralized ignore patterns for file viewer + sync + deploy.
 *
 * ⚠️ Mirror of aplus-dev-studio/packages/web-ui/src/lib/ignorePresets.ts —
 * keep the two copies byte-identical except for indentation/style when
 * adding or removing presets. See aplus-dev-studio's
 * specs/file-ignore-presets/ for the motivation and the full roll-out.
 *
 * The daemon uses this matcher to filter its `getDirectoryTree` RPC
 * response so remote workspaces never ship .git / node_modules /
 * __pycache__ etc. across the wire in the first place. No React / DOM
 * deps — pure module.
 */

export type PresetName =
    | 'common'
    | 'node'
    | 'python'
    | 'rust'
    | 'jvm'
    | 'go'
    | 'mobile'
    | 'editor'
    | 'agent'
    | 'workspace-self'

export const PRESET_NAMES: readonly PresetName[] = [
    'common',
    'node',
    'python',
    'rust',
    'jvm',
    'go',
    'mobile',
    'editor',
    'agent',
    'workspace-self',
]

interface Preset {
    /** Exact segment matches (directory or file name). */
    segments: readonly string[]
    /** Basename globs — wildcard `*` only, matched against the final path segment. */
    globs: readonly string[]
    /**
     * Rooted multi-segment path prefixes — match when the path's leading
     * segments equal the prefix's segments. Use for daemon-mirror path
     * classes where a single segment isn't safe to ban (e.g. `home/` is
     * too broad; `home/coder/workspace/` is the actual leak surface).
     * aplus-dev-studio's specs/workspace-cross-project-pollution/ Phase 2.
     */
    pathPrefixes?: readonly string[]
}

const PRESETS: Record<PresetName, Preset> = {
    common: {
        segments: ['.git', '.svn', '.hg', '.DS_Store', 'Thumbs.db'],
        globs: [],
    },
    node: {
        segments: [
            'node_modules',
            '.next',
            '.nuxt',
            '.svelte-kit',
            'dist',
            'build',
            '.turbo',
            '.cache',
            '.parcel-cache',
        ],
        globs: [],
    },
    python: {
        segments: [
            '__pycache__',
            '.venv',
            'venv',
            '.pytest_cache',
            '.mypy_cache',
            '.ruff_cache',
            '.tox',
        ],
        globs: ['*.pyc'],
    },
    rust: {
        segments: ['target'],
        globs: [],
    },
    jvm: {
        segments: ['.gradle'],
        globs: ['*.iml'],
    },
    go: {
        // `vendor` is intentionally omitted — it's frequently a real source dir
        // in Go projects. Re-enable per-project once override UX exists.
        segments: ['bin'],
        globs: [],
    },
    mobile: {
        segments: ['Pods', 'DerivedData'],
        globs: ['*.xcuserstate'],
    },
    editor: {
        segments: ['.idea', '.vscode'],
        globs: ['*.swp', '*~'],
    },
    agent: {
        // AI coding tool state dirs that leak agent memory/sessions if deployed.
        segments: ['.claude', '.omc', '.happy', '.codex', '.cursor', '.aider'],
        globs: [],
    },
    'workspace-self': {
        // The daemon-mirror path (`home/coder/workspace/...`) appearing inside
        // a project's own workspace tree is a pollution artifact, never source
        // intent. Banning the segment `home/` alone would be too broad (real
        // projects use it as a Next.js route etc.) — the prefix anchors at the
        // rooted multi-segment shape so `home/dashboard/page.tsx` stays visible.
        // Pair with deploy.ts's V7 detection (Phase 1) for explicit block +
        // auto-fix at deploy time. specs/workspace-cross-project-pollution/.
        segments: [],
        globs: [],
        pathPrefixes: ['home/coder/workspace'],
    },
}

export interface IgnoreMatcherOptions {
    /** Active presets. Defaults to all. */
    presets?: readonly PresetName[]
}

export interface IgnoreMatcher {
    shouldIgnore(path: string): boolean
    /** Flat union of segment literals across active presets. For tar/CLI consumers. */
    getSegmentLiterals(): readonly string[]
    /** Flat union of basename globs. */
    getGlobBasenames(): readonly string[]
}

export function createIgnoreMatcher(options: IgnoreMatcherOptions = {}): IgnoreMatcher {
    const active = options.presets ?? PRESET_NAMES
    const segmentSet = new Set<string>()
    const globs: string[] = []
    // Pre-split each pathPrefix into its segment list once at construction so
    // shouldIgnore can do a cheap O(prefix-length) compare per call instead of
    // re-splitting on every match. Stored as raw segments — segment-boundary
    // matching is the whole point.
    const prefixSegmentLists: string[][] = []
    for (const name of active) {
        const preset = PRESETS[name]
        if (!preset) continue
        for (const s of preset.segments) segmentSet.add(s)
        for (const g of preset.globs) {
            if (!globs.includes(g)) globs.push(g)
        }
        if (preset.pathPrefixes) {
            for (const p of preset.pathPrefixes) {
                prefixSegmentLists.push(splitSegments(p))
            }
        }
    }
    const globRegexes = globs.map(compileGlob)
    const segmentLiterals = Array.from(segmentSet)

    function shouldIgnore(path: string): boolean {
        const segments = splitSegments(path)
        if (segments.length === 0) return false
        for (const seg of segments) {
            if (segmentSet.has(seg)) return true
        }
        const basename = segments[segments.length - 1]
        for (const re of globRegexes) {
            if (re.test(basename)) return true
        }
        // Rooted prefix match: the path's first N segments must equal the
        // prefix's N segments. `path.length >= prefix.length` covers both the
        // exact-equality case (`home/coder/workspace` itself) and the deeper
        // case (`home/coder/workspace/foo/bar`).
        for (const prefix of prefixSegmentLists) {
            if (segments.length < prefix.length) continue
            let matched = true
            for (let i = 0; i < prefix.length; i++) {
                if (segments[i] !== prefix[i]) { matched = false; break }
            }
            if (matched) return true
        }
        return false
    }

    return {
        shouldIgnore,
        getSegmentLiterals: () => segmentLiterals,
        getGlobBasenames: () => globs,
    }
}

function splitSegments(path: string): string[] {
    return path.split('/').filter((s) => s.length > 0 && s !== '.')
}

function compileGlob(glob: string): RegExp {
    const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
    return new RegExp(`^${escaped}$`)
}
