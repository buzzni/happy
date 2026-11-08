/**
 * Skill Lock Guard
 *
 * Decides whether one Claude tool call writes into a skill the user locked (aplus-dev-studio-desktop
 * specs/skill-lock R2). Loaded by tool_policy_file_guard.cjs, which already runs as the PreToolUse hook for
 * Edit/Write/MultiEdit/NotebookEdit/Bash — a hook deny holds under bypassPermissions too.
 *
 * Locks live in `<HAPPY_HOME_DIR>/skill-locks.json` v1 (`{ version: 1, locked: [{ dir, name }] }`), written by
 * Saycode Desktop. Fields this reader does not know are ignored, so a later format that keeps `locked[].dir`
 * still locks here.
 *
 * The Bash check reads the command's write targets: redirections, tee, cp/mv/rm/sed -i and friends, git
 * paths, archive extraction, inline interpreter code, `cd` before a relative path, variables assigned earlier
 * in the command, globs and wrappers (ported from hermes-agent tools/skill_lock.py). Reading a skill and
 * running its scripts stay allowed. A policy check, not a sandbox: what a script writes through its own logic,
 * and paths the shell builds while running (`$(…)`, joined pieces), are not seen.
 */

const fs = require('fs');
const path = require('path');

const NO_BYPASS = '다른 이름으로 복사하거나 스크립트·자동화 도구·셸 명령 등 다른 방법으로 우회하지 마라.';

function skillRefusal(name) {
    return `스킬 잠금으로 막힘: '${name}' 스킬은 사용자가 잠가 에이전트가 바꿀 수 없다(파일 도구·터미널 모두). 대신: 바꾸려던 내용을 사용자에게 알리고 요청하라. ${NO_BYPASS}`;
}

const SKILL_LOCK_FILE_MESSAGE = '스킬 잠금으로 막힘: 스킬 잠금 설정 파일(과 그 폴더)은 에이전트가 바꾸거나 지울 수 없다 — 잠금은 Saycode 설정 화면에서 사용자가 바꾼다. 대신: 필요한 변경을 사용자에게 요청하라. 이 제한을 스크립트·자동화 도구·셸 명령 등 다른 방법으로 우회하지 마라.';

const ALL_SKILLS_REFUSAL = `스킬 잠금으로 막힘: 스킬 잠금 설정 파일을 읽을 수 없어, 사람이 보고 있지 않은 이 실행에서는 모든 스킬 폴더를 잠긴 것으로 다룬다. 대신: 사용자에게 Saycode 설정의 스킬 잠금을 다시 저장해 달라고 요청하라. ${NO_BYPASS}`;

// ── lock file ────────────────────────────────────────────────────────────────────────────────────

/** `absent` (no file), `ok` (the locked dirs) or `corrupt` (unreadable or not the v1 shape). */
function readSkillLocks(file) {
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (error) {
        return error && error.code === 'ENOENT' ? { kind: 'absent' } : { kind: 'corrupt' };
    }
    try {
        const value = JSON.parse(text);
        if (!value || typeof value !== 'object' || !Number.isInteger(value.version) || value.version < 1 || !Array.isArray(value.locked)) {
            return { kind: 'corrupt' };
        }
        const dirs = [];
        for (const entry of value.locked) {
            if (!entry || typeof entry.dir !== 'string' || !path.isAbsolute(entry.dir)) return { kind: 'corrupt' };
            dirs.push({ dir: entry.dir, name: typeof entry.name === 'string' && entry.name ? entry.name : path.basename(entry.dir) });
        }
        return { kind: 'ok', dirs };
    } catch {
        return { kind: 'corrupt' };
    }
}

// ── paths ────────────────────────────────────────────────────────────────────────────────────────

/** A directory named `skills` right under `.claude`, `.agents` or `.codex`: where agents load skills from. */
const SKILLS_ROOT = /[\\/]\.(?:claude|agents|codex)[\\/]skills(?=$|[\\/])/;

function stripSlash(value) {
    return value.length > 1 ? value.replace(/[\\/]+$/, '') : value;
}

function inside(child, parent) {
    const c = stripSlash(child);
    const p = stripSlash(parent);
    if (c === p) return true;
    if (p === path.parse(p).root) return c.startsWith(p);
    return c.startsWith(p + '/') || c.startsWith(p + '\\');
}

/** realpath of the deepest existing ancestor, with the rest appended: a path that does not exist yet still resolves symlinked parents. */
function realish(abs) {
    let head = abs;
    const rest = [];
    for (;;) {
        try {
            return path.join(fs.realpathSync.native(head), ...rest.reverse());
        } catch {
            const parent = path.dirname(head);
            if (parent === head) return abs;
            rest.push(path.basename(head));
            head = parent;
        }
    }
}

function globToRegExp(component) {
    let source = '';
    for (let i = 0; i < component.length; i++) {
        const ch = component[i];
        if (ch === '*') source += '.*';
        else if (ch === '?') source += '.';
        // The shell's negated class `[!a]` is `[^a]` to a regular expression.
        else if (ch === '[') source += component[i + 1] === '!' ? (i++, '[^') : '[';
        else if (ch === ']') source += ch;
        else source += ch.replace(/[.+^${}()|\\]/g, '\\$&');
    }
    try {
        return new RegExp(`^${source}$`);
    } catch {
        return /^$/;
    }
}

const hasGlob = (value) => /[*?[]/.test(value);

/**
 * What one call is checked against. `ancestor`: '' — only a path at or inside a locked skill; 'any' — also a
 * directory above one (recursive deletes, moves, permission changes); 'skills' — above one only inside a
 * skills root (a recursive copy or an extraction there can merge into the skill). The lock file itself (`record`)
 * counts as locked too, and so does any directory above it for 'any': removing it would lift every lock.
 */
function createScope(input) {
    const fold = input.caseInsensitive ? (value) => value.toLowerCase() : (value) => value;
    const realpath = input.realpath || realish;
    // The OS resolves `..` after following symlinks, so the real path is taken before normalizing.
    const real = (value) => fold(stripSlash(path.resolve(realpath(value))));
    const roots = input.allSkills ? [] : input.dirs.map((entry) => ({
        name: entry.name,
        dir: real(entry.dir),
        // Inline code names the path as written, which may be a symlink to the real directory.
        written: fold(stripSlash(path.resolve(entry.dir))),
    }));
    if (input.allSkills) {
        for (const base of [input.home, input.cwd]) {
            for (const agent of ['.claude', '.agents', '.codex']) {
                const dir = path.join(base, agent, 'skills');
                roots.push({ name: dir, dir: real(dir), written: fold(dir) });
            }
        }
    }
    const record = input.record ? real(input.record) : null;
    const refusal = (root) => (input.allSkills ? ALL_SKILLS_REFUSAL : skillRefusal(root.name));

    function hitOne(candidate, ancestor) {
        if (record && (candidate === record || (ancestor === 'any' && candidate !== path.parse(candidate).root && inside(record, candidate)))) {
            return SKILL_LOCK_FILE_MESSAGE;
        }
        if (input.allSkills && SKILLS_ROOT.test(candidate)) return ALL_SKILLS_REFUSAL;
        for (const root of roots) {
            if (inside(candidate, root.dir)) return refusal(root);
            if (ancestor && candidate !== path.parse(candidate).root && inside(root.dir, candidate)
                && (ancestor === 'any' || SKILLS_ROOT.test(candidate))) return refusal(root);
        }
        return null;
    }

    /**
     * Three readings of one path: fully resolved (where a write lands), resolved up to the parent (a symlink
     * inside a locked skill is itself removed or replaced), and as written (a skill installed as a symlink still
     * sits under a skills root — the fail-closed reading in R4 needs that).
     */
    function hitResolved(resolved, ancestor) {
        const asWritten = fold(stripSlash(path.resolve(resolved)));
        const parentReal = fold(stripSlash(path.join(real(path.dirname(resolved)), path.basename(resolved))));
        return hitOne(real(resolved), ancestor) || hitOne(parentReal, ancestor) || hitOne(asWritten, ancestor);
    }

    /** A glob is matched component by component against each locked dir; its literal prefix is resolved first. */
    function hitGlob(pattern, ancestor) {
        const parts = path.resolve(pattern).split(/[\\/]+/);
        const firstGlob = parts.findIndex(hasGlob);
        const prefix = parts.slice(0, firstGlob).join('/') || '/';
        const readings = [fold(pattern), [real(prefix), ...parts.slice(firstGlob)].join('/')];
        for (const reading of readings) {
            const readingParts = fold(reading).split(/[\\/]+/);
            for (const target of [...roots.map((root) => ({ root, dir: root.dir })), ...roots.map((root) => ({ root, dir: root.written })),
                ...(record ? [{ root: null, dir: record }] : [])]) {
                const targetParts = target.dir.split(/[\\/]+/);
                const n = Math.min(readingParts.length, targetParts.length);
                let matches = true;
                for (let i = 0; i < n && matches; i++) matches = globToRegExp(readingParts[i]).test(targetParts[i]);
                if (!matches) continue;
                const reason = target.root ? refusal(target.root) : SKILL_LOCK_FILE_MESSAGE;
                if (readingParts.length >= targetParts.length) return reason;
                if (ancestor === 'any' || (ancestor === 'skills' && target.root && SKILLS_ROOT.test(readingParts.join('/')))) return reason;
            }
            if (input.allSkills && SKILLS_ROOT.test(fold(reading))) return ALL_SKILLS_REFUSAL;
        }
        return null;
    }

    return {
        hitResolved,
        /** A shell word (or tool path), expanded the way the shell would before it reaches the command. */
        hit(word, cwd, vars, ancestor = '') {
            if (typeof word !== 'string' || word.length === 0) return null;
            const resolved = joinPath(cwd, expand(word, vars, input.home));
            return hasGlob(resolved) ? hitGlob(resolved, ancestor) : hitResolved(resolved, ancestor);
        },
        roots,
        record,
        fold,
    };
}

/** cwd + word without normalizing `..` away: the real path is taken first (see createScope). */
function joinPath(cwd, word) {
    return path.isAbsolute(word) ? word : `${cwd.replace(/[\\/]+$/, '')}/${word}`;
}

const VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

function expand(word, vars, home) {
    const substituted = word.replace(VAR, (match, braced, bare) => {
        const value = vars[braced || bare];
        return typeof value === 'string' ? value : match;
    });
    return substituted === '~' || substituted.startsWith('~/') ? home + substituted.slice(1) : substituted;
}

// ── shell words ──────────────────────────────────────────────────────────────────────────────────

const OPERATOR_CHARS = ';&|<>()';
const OPERATORS = ['&>>', ';;&', '<<<', '<<-', '>>', '&&', '||', '|&', ';;', ';&', '&>', '>|', '>&', '<&', '<<', '<>', ';', '&', '|', '(', ')', '<', '>'];

/**
 * Shell-ish tokens: quotes removed, an unquoted newline becomes `;`, runs of `;&|<>()` become operator tokens
 * (`{ op: true }`) and a bare fd number right before `>`/`<` joins its operator (`2>`). Unbalanced quotes fall
 * back to whitespace words.
 */
function tokenize(command) {
    const tokens = [];
    let word = '';
    let started = false;
    let quotedWord = false;
    let i = 0;
    const flush = () => {
        if (started) tokens.push({ text: word, op: false, quoted: quotedWord });
        word = '';
        started = false;
        quotedWord = false;
    };
    while (i < command.length) {
        const ch = command[i];
        if (ch === "'") {
            const end = command.indexOf("'", i + 1);
            if (end < 0) return command.split(/\s+/).filter(Boolean).map((text) => ({ text, op: false, quoted: false }));
            word += command.slice(i + 1, end);
            started = true;
            quotedWord = true;
            i = end + 1;
            continue;
        }
        if (ch === '"') {
            let j = i + 1;
            let text = '';
            while (j < command.length && command[j] !== '"') {
                if (command[j] === '\\' && j + 1 < command.length && '"\\$`\n'.includes(command[j + 1])) {
                    text += command[j + 1];
                    j += 2;
                } else {
                    text += command[j];
                    j += 1;
                }
            }
            if (j >= command.length) return command.split(/\s+/).filter(Boolean).map((t) => ({ text: t, op: false, quoted: false }));
            word += text;
            started = true;
            quotedWord = true;
            i = j + 1;
            continue;
        }
        if (ch === '\\' && i + 1 < command.length) {
            if (command[i + 1] !== '\n') {
                word += command[i + 1];
                started = true;
            }
            i += 2;
            continue;
        }
        if (ch === '\n') {
            flush();
            tokens.push({ text: ';', op: true });
            i += 1;
            continue;
        }
        if (/\s/.test(ch)) {
            flush();
            i += 1;
            continue;
        }
        if (OPERATOR_CHARS.includes(ch)) {
            // One operator at a time, longest first: `true&&>f` is `&&` then `>`, `(>f)` is `(` then `>`.
            const op = OPERATORS.find((candidate) => command.startsWith(candidate, i));
            i += op.length;
            // A bare fd number right before a redirection belongs to it (`2>`), not to the command's words.
            if ((op[0] === '>' || op[0] === '<') && started && !quotedWord && /^\d+$/.test(word)) {
                word = '';
                started = false;
            }
            flush();
            tokens.push({ text: op, op: true });
            continue;
        }
        word += ch;
        started = true;
        i += 1;
    }
    flush();
    return tokens;
}

/** One simple command per entry: its words, the files its redirections write, and the operator that ended it. */
function segments(tokens) {
    const out = [];
    let argv = [];
    let targets = [];
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (!token.op) {
            argv.push(token.text);
            continue;
        }
        const op = token.text;
        if (/^(?:>>?|>\||&>>?|>&|<>)$/.test(op)) {
            const next = tokens[i + 1];
            if (next && !next.op) {
                i += 1;
                // `2>&1`, `>&-`: a descriptor, not a file.
                if (!(op === '>&' && /^(?:\d+|-)$/.test(next.text)) && next.text !== '/dev/null') targets.push(next.text);
            }
            continue;
        }
        if (/^(?:<|<<|<<<|<<-|<&)$/.test(op)) {
            if (tokens[i + 1] && !tokens[i + 1].op) i += 1;
            continue;
        }
        // Any other operator run (`;`, `&&`, `|`, `(`, `)`, `;;`, and odd mixes) separates commands.
        out.push({ argv, targets, separator: op });
        argv = [];
        targets = [];
    }
    out.push({ argv, targets, separator: '' });
    return out;
}

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;

const WRAPPER_OPTIONS_WITH_ARG = {
    sudo: new Set(['-u', '-g', '-C', '-h', '-p', '-r', '-t', '-U', '-D']),
    env: new Set(['-u', '-C', '-S', '--unset', '--chdir', '--split-string']),
    nice: new Set(['-n', '--adjustment']),
    xargs: new Set(['-n', '-I', '-L', '-P', '-d', '-E', '-s', '-a']),
    timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
    stdbuf: new Set(['-i', '-o', '-e']),
    ionice: new Set(['-c', '-n', '-p']),
};
const WRAPPERS = new Set(['sudo', 'env', 'command', 'builtin', 'exec', 'nohup', 'setsid', 'time', 'nice', 'xargs', 'timeout', 'stdbuf', 'ionice', 'caffeinate', 'doas']);

/** Words that open or close a shell block; the command follows them (`if true; then rm f; fi`). */
const RESERVED = new Set(['if', 'then', 'elif', 'else', 'fi', 'do', 'done', 'while', 'until', '{', '}', '!', 'esac', 'time', 'coproc']);
/** Their words are a list, not a command (`for f in a b`). */
const LIST_HEADS = new Set(['for', 'case', 'select', 'function']);

/**
 * The command a simple command really runs, past block words, `VAR=…` prefixes and wrappers (`sudo`, `env`,
 * `nohup`, `xargs`…). `env -C dir` moves the working directory, and assignments reach the command's environment
 * (`env D=… bash -c '… $D …'`) — both apply to this command only.
 */
function unwrap(argv, cwd, vars, home) {
    let rest = argv;
    let where = cwd;
    const env = { ...vars };
    const assign = (word) => {
        const [, name, value] = ASSIGNMENT.exec(word);
        env[name] = expand(value, env, home);
    };
    while (rest.length > 0) {
        if (RESERVED.has(rest[0])) {
            rest = rest.slice(1);
            continue;
        }
        if (LIST_HEADS.has(rest[0])) return { argv: [], cwd: where, vars: env };
        if (ASSIGNMENT.test(rest[0])) {
            assign(rest[0]);
            rest = rest.slice(1);
            continue;
        }
        const head = path.basename(rest[0]);
        if (!WRAPPERS.has(head)) break;
        const takesValue = WRAPPER_OPTIONS_WITH_ARG[head] || new Set();
        rest = rest.slice(1);
        while (rest.length > 0 && (rest[0].startsWith('-') || (head === 'env' && ASSIGNMENT.test(rest[0])))) {
            const flag = rest[0];
            if (head === 'env' && ASSIGNMENT.test(flag)) assign(flag);
            if (head === 'env' && (flag === '-C' || flag === '--chdir') && rest.length > 1) where = joinPath(where, expand(rest[1], env, home));
            if (head === 'env' && flag.startsWith('--chdir=')) where = joinPath(where, expand(flag.slice('--chdir='.length), env, home));
            rest = takesValue.has(flag) ? rest.slice(2) : rest.slice(1);
        }
        if (head === 'timeout' && rest.length > 0) rest = rest.slice(1); // the duration
    }
    return { argv: rest, cwd: where, vars: env };
}

const operands = (args) => args.filter((arg) => arg && !arg.startsWith('-'));

// ── verbs ────────────────────────────────────────────────────────────────────────────────────────

/** Every path operand is written, removed or renamed. */
const WRITES_EVERY_OPERAND = new Set([
    'rm', 'rmdir', 'unlink', 'truncate', 'shred', 'touch', 'chmod', 'chown', 'chgrp', 'chattr', 'chflags',
    'setfacl', 'mkdir', 'mv', 'patch', 'dos2unix', 'unix2dos', 'xattr', 'ed', 'ex', 'vi', 'vim', 'nvim', 'nano',
    'emacs', 'tee', 'srm', 'trash']);
/** Only the last operand (the destination) is written. */
const WRITES_LAST_OPERAND = new Set(['cp', 'install', 'ln', 'rsync', 'scp', 'ditto']);
/** Reach into a directory operand recursively: a directory above a locked skill counts. */
const RECURSIVE = new Set(['rm', 'mv', 'chmod', 'chown', 'chgrp', 'chattr', 'chflags', 'setfacl', 'rsync', 'srm', 'trash']);
const INPLACE_EDITORS = new Set(['sed', 'gsed', 'perl', 'ruby']);
const INTERPRETERS = /^(?:python[0-9.]*|node|nodejs|deno|bun|ruby|perl|php|bash|sh|zsh|dash|ksh|fish|pwsh|powershell|osascript)$/;
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish']);
const CODE_FLAGS = new Set(['-c', '-e', '-E', '--eval', '-p', '--print', '-Command', '-command', '-r']);
const RECURSIVE_COPY_FLAG = /^(?:-[A-Za-z]*[rRa][A-Za-z]*|--recursive|--archive)$/;
/** Git commands that rewrite the given paths in the working tree. */
const GIT_PATH_WRITES = new Set(['checkout', 'restore', 'rm', 'mv', 'clean', 'reset', 'stash', 'apply', 'am']);
/** Without paths these still discard or delete working-tree files below where they run. */
const GIT_TREE_DISCARDS = new Set(['clean', 'stash']);

/**
 * Inline code that writes: open() with a write/append/create mode, pathlib/fs write calls, deletes, renames,
 * copies, and shell write forms. A plain open(path) or read stays allowed.
 */
const WRITEISH_CODE = new RegExp(
    String.raw`open\s*\([^)]*['"][rbt]*[wax+][^'"]*['"]|\.write(?:_text|_bytes|lines)?\s*\(|`
    + String.raw`\b(?:unlink|rmtree|removedirs|remove|rmdir|rename|truncate|chmod|chown|mkdir|makedirs|symlink|`
    + String.raw`copyfile|copytree|copy2?|move|touch|rm)\s*\(|\bos\.replace\s*\(|\.replace\s*\(\s*(?:Path|['"]/)|`
    + String.raw`(?:write|append)File(?:Sync)?|(?:rm|unlink|rename|mkdir|copyFile|cp|truncate)Sync|Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item|`
    + String.raw`(?:^|[\s;|&])>{1,2}|\bsed\s+-i|\b(?:mv|rm|cp|tee|touch)\s`, 'i');

function createChecker(scope, env) {
    function codeRefusal(code, cwd) {
        if (!WRITEISH_CODE.test(code)) return null;
        const cwdHit = scope.hitResolved(cwd, '');
        if (cwdHit) return cwdHit;
        const text = scope.fold(code.replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])|~(?=\/)/g, env.home));
        if (env.allSkills && /\.(?:claude|agents|codex)[\\/]skills(?:$|[\\/'"\s])/.test(text)) return ALL_SKILLS_REFUSAL;
        for (const root of scope.roots) {
            if (text.includes(root.dir) || text.includes(root.written) || text.includes(`skills/${path.basename(root.written)}`)) {
                return env.allSkills ? ALL_SKILLS_REFUSAL : skillRefusal(root.name);
            }
        }
        return null;
    }

    function firstHit(words, cwd, vars, ancestor) {
        for (const word of words) {
            const reason = scope.hit(word, cwd, vars, ancestor);
            if (reason) return reason;
        }
        return null;
    }

    function fileVerbs(verb, args, cwd, vars) {
        if (WRITES_EVERY_OPERAND.has(verb)) return firstHit(operands(args), cwd, vars, RECURSIVE.has(verb) ? 'any' : '');
        // `install -d a b` creates every operand as a directory.
        if (verb === 'install' && args.some((arg) => arg === '-d' || arg === '--directory' || /^-[A-Za-z]*d[A-Za-z]*$/.test(arg))) return firstHit(operands(args), cwd, vars, '');
        if (verb === 'dd') return firstHit(args.filter((arg) => arg.startsWith('of=')).map((arg) => arg.slice(3)), cwd, vars, '');
        if (!WRITES_LAST_OPERAND.has(verb)) return null;
        let target = null;
        const rest = [];
        for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            if (arg.startsWith('--target-directory=')) target = arg.slice('--target-directory='.length);
            else if ((arg === '-t' || arg === '--target-directory') && i + 1 < args.length) target = args[++i];
            else if (/^-t./.test(arg)) target = arg.slice(2);
            else rest.push(arg);
        }
        const ops = operands(rest);
        // `ln -s <target>` alone links into the working directory.
        const dest = target !== null ? target : ops.length > 1 ? ops[ops.length - 1] : verb === 'ln' && ops.length === 1 ? '.' : null;
        if (dest === null) return null;
        const merges = verb === 'rsync' || verb === 'ditto' || rest.some((arg) => RECURSIVE_COPY_FLAG.test(arg));
        return scope.hit(dest, cwd, vars, merges ? 'skills' : '');
    }

    function inplace(verb, args, cwd, vars) {
        if (!INPLACE_EDITORS.has(verb)) return null;
        if (!args.some((arg) => arg.startsWith('--in-place') || (/^-[A-Za-z]*i/.test(arg) && !arg.startsWith('--')))) return null;
        return firstHit(operands(args), cwd, vars, '');
    }

    function find(verb, args, cwd, vars, depth) {
        if (verb !== 'find') return null;
        const starts = [];
        for (const arg of args) {
            if (arg.startsWith('-') || arg === '(' || arg === '!') break;
            starts.push(arg);
        }
        let writes = args.includes('-delete');
        let group = null;
        const probeFile = scope.roots.length > 0 ? path.join(scope.roots[0].dir, 'SKILL.md') : null;
        for (const arg of args) {
            if (['-exec', '-execdir', '-ok', '-okdir'].includes(arg)) group = [];
            else if (group && (arg === ';' || arg === '+' || arg === '\\;')) {
                if (probeFile && group.length > 0 && argvRefusal(group.map((w) => (w === '{}' ? probeFile : w)), cwd, vars, depth)) writes = true;
                group = null;
            } else if (group) group.push(arg);
        }
        if (group && probeFile && group.length > 0 && argvRefusal(group.map((w) => (w === '{}' ? probeFile : w)), cwd, vars, depth)) writes = true;
        return writes ? firstHit(starts.length > 0 ? starts : ['.'], cwd, vars, 'any') : null;
    }

    /**
     * Git rewrites files at the paths it is given (`checkout -- p`, `restore p`, `rm`, `mv`, `clean`, `stash`),
     * or anywhere when it runs inside a locked skill. Commits, branch switches and merges at a project root that
     * merely contains a locked skill are not refused (spec R3: changing revisions is not seen).
     */
    function git(verb, args, cwd, vars) {
        if (verb !== 'git') return null;
        let where = cwd;
        const rest = [...args];
        while (rest.length > 0 && rest[0].startsWith('-')) {
            const flag = rest.shift();
            if (flag === '-C' && rest.length > 0) where = joinPath(cwd, expand(rest.shift(), vars, env.home));
            else if (['-c', '--git-dir', '--work-tree', '--namespace'].includes(flag) && rest.length > 0) rest.shift();
        }
        const sub = rest.shift();
        if (!sub || !GIT_PATH_WRITES.has(sub)) return null;
        const inSkill = scope.hitResolved(where, '');
        if (inSkill) return inSkill;
        const dashDash = rest.indexOf('--');
        const valued = new Set(['-s', '--source', '-m', '--message', '--pathspec-from-file']);
        const words = rest.filter((arg, i) => !valued.has(rest[i - 1]));
        const paths = dashDash >= 0 ? rest.slice(dashDash + 1) : operands(words).filter((arg) => (
            // `checkout <branch>`, `reset <commit>`, `stash <verb>` name revisions: only an existing path (or a glob) is a path there.
            !['checkout', 'reset', 'stash'].includes(sub) || hasGlob(arg) || fs.existsSync(path.resolve(where, expand(arg, vars, env.home)))));
        const pathHit = firstHit(sub === 'stash' ? [] : paths, where, vars, 'any');
        if (pathHit) return pathHit;
        const discardsAll = GIT_TREE_DISCARDS.has(sub) && (sub !== 'stash' || !rest[0] || ['push', 'save', '-u', '--include-untracked', '-a', '--all'].includes(rest[0]));
        const hardReset = sub === 'reset' && rest.includes('--hard');
        return (discardsAll || hardReset) && paths.length === 0 ? scope.hitResolved(where, 'any') : null;
    }

    function extract(verb, args, cwd, vars) {
        if (!['tar', 'gtar', 'bsdtar', 'unzip', '7z', '7za'].includes(verb)) return null;
        let dest = cwd;
        for (let i = 0; i < args.length - 1; i++) {
            if (['-C', '--directory', '-d'].includes(args[i])) dest = joinPath(cwd, expand(args[i + 1], vars, env.home));
            if (args[i].startsWith('-o') && (verb === '7z' || verb === '7za')) dest = joinPath(cwd, expand(args[i].slice(2), vars, env.home));
        }
        const bundled = args.length > 0 && !args[0].startsWith('-') && args[0].includes('x');
        // `unzip -p|-l|-t|-v|-Z` print, list or test; nothing is written.
        const extracting = (verb === 'unzip' && !args.some((arg) => /^-[A-Za-z]*[pltvZ]/.test(arg))) || ((verb === '7z' || verb === '7za') && args[0] === 'x') || bundled
            || args.some((arg) => arg === '--extract' || arg === '-x' || (/^-[A-Za-z]*x/.test(arg) && !arg.startsWith('--')));
        return extracting ? scope.hitResolved(dest, 'skills') : null;
    }

    function interpreter(verb, args, cwd, vars, depth) {
        if (verb === 'eval') return depth < 3 ? commandRefusal(args.join(' '), cwd, vars, depth + 1) : null;
        if (!INTERPRETERS.test(verb)) return null;
        for (let i = 0; i < args.length - 1; i++) {
            if (!CODE_FLAGS.has(args[i]) && !/^-[A-Za-z]*c$/.test(args[i])) continue;
            const code = args[i + 1];
            const reason = SHELLS.has(verb) && depth < 3 ? commandRefusal(code, cwd, vars, depth + 1) : codeRefusal(code, cwd);
            if (reason) return reason;
        }
        return null;
    }

    function argvRefusal(argv, cwd, vars, depth) {
        const verb = path.basename(argv[0]);
        const args = argv.slice(1);
        return fileVerbs(verb, args, cwd, vars) || inplace(verb, args, cwd, vars) || find(verb, args, cwd, vars, depth)
            || git(verb, args, cwd, vars) || extract(verb, args, cwd, vars) || interpreter(verb, args, cwd, vars, depth);
    }

    function commandRefusal(command, startCwd, startVars, depth) {
        // A heredoc-fed interpreter body: judge the whole text as code.
        if (command.includes('<<')) {
            const reason = codeRefusal(command, startCwd);
            if (reason) return reason;
        }
        let cwd = startCwd;
        const vars = { ...startVars };
        const subshells = [];
        for (const segment of segments(tokenize(command))) {
            let argv = segment.argv;
            const words = argv[0] === 'export' || argv[0] === 'local' || argv[0] === 'declare' ? argv.slice(1) : argv;
            if (words.length > 0 && words.every((word) => ASSIGNMENT.test(word))) {
                for (const word of words) {
                    const [, name, value] = ASSIGNMENT.exec(word);
                    vars[name] = expand(value, vars, env.home);
                }
                argv = [];
            }
            for (const target of segment.targets) {
                const reason = scope.hit(target, cwd, vars, '');
                if (reason) return reason;
            }
            const command = unwrap(argv, cwd, vars, env.home);
            argv = command.argv;
            if (argv.length > 0 && (argv[0] === 'cd' || argv[0] === 'pushd')) {
                const to = argv.slice(1).find((arg) => !arg.startsWith('-'));
                if (to === undefined) cwd = env.home;
                else if (to !== '-') cwd = joinPath(cwd, expand(to, vars, env.home));
            } else if (argv.length > 0) {
                const reason = argvRefusal(argv, command.cwd, command.vars, depth);
                if (reason) return reason;
            }
            for (const ch of segment.separator) {
                if (ch === '(') subshells.push(cwd);
                else if (ch === ')' && subshells.length > 0) cwd = subshells.pop();
            }
        }
        return null;
    }

    return { commandRefusal };
}

/**
 * The refusal for this hook payload, or null. `locks`: `{ dirs }` from the lock file, or `{ allSkills: true }`
 * when it is corrupt in an unattended turn (every skill root counts as locked, spec R4); `record` — the lock
 * file, protected along with the directories above it while anything is locked.
 */
function skillLockRefusal(payload, locks, env) {
    const input = (payload && payload.tool_input) || {};
    const cwd = (payload && payload.cwd) || process.cwd();
    const allSkills = locks.allSkills === true;
    if (!allSkills && (!locks.dirs || locks.dirs.length === 0)) return null;
    const scope = createScope({ dirs: locks.dirs || [], allSkills, record: locks.record, cwd, home: env.home, caseInsensitive: env.caseInsensitive, realpath: env.realpath });
    const vars = { ...(env.vars || {}), HOME: env.home };
    if (payload.tool_name === 'Bash') {
        if (typeof input.command !== 'string') return null;
        return createChecker(scope, { home: env.home, allSkills }).commandRefusal(input.command, cwd, vars, 0);
    }
    const targets = [input.file_path, input.notebook_path].filter((value) => typeof value === 'string' && value.length > 0);
    for (const target of targets) {
        const reason = scope.hitResolved(joinPath(cwd, expand(target, vars, env.home)), '');
        if (reason) return reason;
    }
    return null;
}

module.exports = { readSkillLocks, skillLockRefusal, tokenize, ALL_SKILLS_REFUSAL, SKILL_LOCK_FILE_MESSAGE };
