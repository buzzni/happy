import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { readSkillLocks, skillLockRefusal, ALL_SKILLS_REFUSAL } = require('../skill_lock_guard.cjs');

const HOME = '/Users/me';
const LOCKED = '/Users/me/.claude/skills/deep-research';
const PROJECT = '/Users/me/project';
const PROJECT_SKILL = '/Users/me/project/.claude/skills/review';
const ENV = { home: HOME, caseInsensitive: false, realpath: (value: string) => value, vars: {} };
const LOCKS = { dirs: [{ dir: LOCKED, name: 'deep-research' }, { dir: PROJECT_SKILL, name: 'review' }] };

const bash = (command: string, cwd = PROJECT) => ({ tool_name: 'Bash', tool_input: { command }, cwd });
const refusal = (payload: unknown, locks: unknown = LOCKS, env: unknown = ENV) => skillLockRefusal(payload, locks, env);

describe('skillLockRefusal — terminal writes into a locked skill', () => {
    it.each([
        // redirections
        `echo hi > ${LOCKED}/SKILL.md`,
        'echo hi >> ~/.claude/skills/deep-research/SKILL.md',
        'printf x 2> $HOME/.claude/skills/deep-research/err.log',
        'cat a &> ~/.claude/skills/deep-research/out',
        'echo x >| ~/.claude/skills/deep-research/SKILL.md',
        'cat > ~/.claude/skills/deep-research/SKILL.md <<EOF\nnew body\nEOF',
        // tee, cp, mv, rm, sed -i …
        'echo x | tee -a ~/.claude/skills/deep-research/SKILL.md',
        'cp /tmp/evil.md ~/.claude/skills/deep-research/SKILL.md',
        'cp -t ~/.claude/skills/deep-research /tmp/evil.md',
        'cp -r /tmp/new ~/.claude/skills',
        'mv ~/.claude/skills/deep-research /tmp/gone',
        'mv /tmp/x ~/.claude/skills/deep-research/SKILL.md',
        'rm -rf ~/.claude/skills/deep-research',
        'rm -rf ~/.claude',
        'rm ~/.claude/skills/deep-research/scripts/*.py',
        'rm -rf ~/.claude/skills/deep*',
        "sed -i '' 's/a/b/' ~/.claude/skills/deep-research/SKILL.md",
        "sed -i.bak -e 's/a/b/' .claude/skills/review/SKILL.md",
        "perl -pi -e 's/a/b/' ~/.claude/skills/deep-research/SKILL.md",
        'touch ~/.claude/skills/deep-research/new.md',
        'chmod -R 777 ~/.claude/skills',
        'ln -sf /tmp/evil ~/.claude/skills/deep-research/SKILL.md',
        'rsync -a /tmp/new/ ~/.claude/skills/',
        'dd if=/dev/zero of=$HOME/.claude/skills/deep-research/SKILL.md',
        'truncate -s 0 ~/.claude/skills/deep-research/SKILL.md',
        'vim ~/.claude/skills/deep-research/SKILL.md',
        // cd, variables, wrappers, compound commands
        'cd ~/.claude/skills/deep-research && echo x > SKILL.md',
        'cd ~/.claude/skills && rm -r deep-research',
        'pushd .claude/skills/review; sed -i s/a/b/ SKILL.md; popd',
        'D=~/.claude/skills/deep-research; rm $D/SKILL.md',
        'export D=$HOME/.claude/skills; echo x > "${D}/deep-research/SKILL.md"',
        'sudo -u me rm ~/.claude/skills/deep-research/SKILL.md',
        'env FOO=1 nohup cp /tmp/a ~/.claude/skills/deep-research/a',
        'timeout 5 tee ~/.claude/skills/deep-research/SKILL.md < /tmp/a',
        'true && (cd /tmp; echo ok) || echo x > .claude/skills/review/SKILL.md',
        'echo a\ncd .claude/skills/review\necho b > notes.md',
        // find, git, archives
        'find ~/.claude/skills -name "*.md" -delete',
        'find ~/.claude/skills -type f -exec sed -i s/a/b/ {} \\;',
        'git checkout -- .claude/skills/review/SKILL.md',
        'git checkout -- .',
        'git restore .claude/skills/review',
        'git -C ~/.claude/skills/deep-research reset --hard',
        'git clean -fdx',
        'tar xzf /tmp/skills.tgz -C ~/.claude/skills',
        'unzip -o /tmp/s.zip -d ~/.claude/skills/deep-research',
        // inline code
        `python3 -c "open('${LOCKED}/SKILL.md','w').write('x')"`,
        "python -c \"import pathlib; pathlib.Path('~/.claude/skills/deep-research/SKILL.md').expanduser().write_text('x')\"",
        "node -e \"require('fs').writeFileSync('.claude/skills/review/SKILL.md', '')\"",
        "node -e \"require('fs').rmSync(process.env.HOME + '/.claude/skills/deep-research', {recursive: true})\"",
        'bash -c "echo x > ~/.claude/skills/deep-research/SKILL.md"',
        "sh -lc 'cd ~/.claude/skills/deep-research && rm SKILL.md'",
        'eval "rm -rf ~/.claude/skills/deep-research"',
        "python3 - <<'PY'\nopen('/Users/me/.claude/skills/deep-research/SKILL.md', 'w').write('x')\nPY",
        "cd .claude/skills/review && python3 -c \"open('SKILL.md','a').write('x')\"",
    ])('refuses %s', (command) => {
        const reason = refusal(bash(command));
        expect(reason).toContain('스킬 잠금으로 막힘');
        expect(reason).toContain('우회하지 마라');
    });

    it('names the locked skill in the reason', () => {
        expect(refusal(bash('rm ~/.claude/skills/deep-research/SKILL.md'))).toContain("'deep-research'");
    });
});

describe('skillLockRefusal — what stays allowed', () => {
    it.each([
        'cat ~/.claude/skills/deep-research/SKILL.md',
        'grep -r todo ~/.claude/skills',
        'ls -la ~/.claude/skills/deep-research',
        'python3 ~/.claude/skills/deep-research/scripts/run.py --out /tmp/report.md',
        'bash ~/.claude/skills/deep-research/scripts/setup.sh',
        'cd ~/.claude/skills/deep-research && python3 scripts/run.py > /tmp/out.txt',
        'cp ~/.claude/skills/deep-research/SKILL.md /tmp/copy.md',
        'cp -r ~/.claude/skills/deep-research /tmp/backup',
        'echo x > ~/.claude/skills/other-skill/SKILL.md',
        'rm -rf ~/.claude/skills/other-skill',
        'echo x > /tmp/deep-research/SKILL.md',
        'rm -rf node_modules dist',
        'git commit -am "update"',
        'git checkout main',
        'git pull --rebase',
        'git add .claude/skills/review',
        'git status && git diff -- .claude/skills/review',
        'tar czf /tmp/backup.tgz ~/.claude/skills',
        'tar xzf /tmp/a.tgz -C /tmp/out',
        'node -e "console.log(require(\'fs\').readFileSync(\'.claude/skills/review/SKILL.md\', \'utf8\'))"',
        'python3 -c "print(open(\'/Users/me/.claude/skills/deep-research/SKILL.md\').read())"',
        'echo "rm -rf ~/.claude/skills/deep-research"',
        'find ~/.claude/skills -name "*.md"',
        'ls 2>&1 | head',
        'echo x > /dev/null',
        'cd ~/.claude/skills/deep-research; cd /tmp; echo x > SKILL.md',
        '(cd ~/.claude/skills/deep-research); echo x > SKILL.md',
    ])('allows %s', (command) => {
        expect(refusal(bash(command))).toBeNull();
    });

    it('allows anything when nothing is locked', () => {
        expect(refusal(bash('rm -rf ~/.claude/skills'), { dirs: [] })).toBeNull();
    });
});

describe('skillLockRefusal — file tools', () => {
    it.each([
        { tool_name: 'Write', tool_input: { file_path: `${LOCKED}/SKILL.md` }, cwd: PROJECT },
        { tool_name: 'Edit', tool_input: { file_path: '.claude/skills/review/SKILL.md' }, cwd: PROJECT },
        { tool_name: 'MultiEdit', tool_input: { file_path: '~/.claude/skills/deep-research/scripts/run.py' }, cwd: PROJECT },
        { tool_name: 'NotebookEdit', tool_input: { notebook_path: `${LOCKED}/nb.ipynb` }, cwd: PROJECT },
        { tool_name: 'Write', tool_input: { file_path: 'SKILL.md' }, cwd: LOCKED },
    ])('refuses %j', (payload) => {
        expect(refusal(payload)).toContain('스킬 잠금으로 막힘');
    });

    it.each([
        { tool_name: 'Write', tool_input: { file_path: '/Users/me/.claude/skills/other/SKILL.md' }, cwd: PROJECT },
        { tool_name: 'Edit', tool_input: { file_path: 'src/index.ts' }, cwd: PROJECT },
        { tool_name: 'Write', tool_input: { file_path: '/Users/me/.claude/skills/deep-research-2/SKILL.md' }, cwd: PROJECT },
    ])('allows %j', (payload) => {
        expect(refusal(payload)).toBeNull();
    });

    it('folds case where the file system ignores it', () => {
        const payload = { tool_name: 'Write', tool_input: { file_path: '/Users/me/.Claude/Skills/Deep-Research/SKILL.md' }, cwd: PROJECT };
        expect(refusal(payload)).toBeNull();
        expect(refusal(payload, LOCKS, { ...ENV, caseInsensitive: true })).toContain("'deep-research'");
    });
});

describe('skillLockRefusal — every skill locked (corrupt lock file, unattended turn)', () => {
    const ALL = { allSkills: true };
    it.each([
        'echo x > ~/.claude/skills/anything/SKILL.md',
        'mkdir -p ~/.agents/skills/new && touch ~/.agents/skills/new/SKILL.md',
        'rm -rf ~/.codex/skills',
        'rm -rf .claude',
        'cd .claude/skills/review && echo x > SKILL.md',
        "python3 -c \"open('.claude/skills/x/SKILL.md','w').write('')\"",
    ])('refuses %s', (command) => {
        expect(refusal(bash(command), ALL)).toBe(ALL_SKILLS_REFUSAL);
    });

    it('refuses a file tool aimed at any skill root and allows the rest', () => {
        expect(refusal({ tool_name: 'Write', tool_input: { file_path: '/Users/me/.claude/skills/x/SKILL.md' }, cwd: PROJECT }, ALL)).toBe(ALL_SKILLS_REFUSAL);
        expect(refusal({ tool_name: 'Write', tool_input: { file_path: '/Users/me/project/src/a.ts' }, cwd: PROJECT }, ALL)).toBeNull();
        expect(refusal(bash('cat ~/.claude/skills/x/SKILL.md'), ALL)).toBeNull();
    });
});

describe('symlinked skills', () => {
    it('refuses a write through the link to the locked directory', () => {
        const root = realpathSync(mkdtempSync(join(tmpdir(), 'skill-lock-')));
        try {
            const real = join(root, 'store', 'deep-research');
            mkdirSync(real, { recursive: true });
            writeFileSync(join(real, 'SKILL.md'), '# x');
            mkdirSync(join(root, 'home', '.claude', 'skills'), { recursive: true });
            symlinkSync(real, join(root, 'home', '.claude', 'skills', 'deep-research'));
            const env = { home: join(root, 'home'), caseInsensitive: false, vars: {} };
            const locks = { dirs: [{ dir: real, name: 'deep-research' }] };
            expect(skillLockRefusal(bash('echo x > ~/.claude/skills/deep-research/SKILL.md', join(root, 'home')), locks, env)).toContain("'deep-research'");
            expect(skillLockRefusal({ tool_name: 'Edit', tool_input: { file_path: join(root, 'home', '.claude', 'skills', 'deep-research', 'new.md') }, cwd: root }, locks, env)).toContain("'deep-research'");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('readSkillLocks', () => {
    const withFile = (content: string | null, check: (file: string) => void) => {
        const root = mkdtempSync(join(tmpdir(), 'skill-lock-file-'));
        try {
            const file = join(root, 'skill-locks.json');
            if (content !== null) writeFileSync(file, content);
            check(file);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    };

    it('reads the v1 shape and ignores fields it does not know', () => {
        withFile(JSON.stringify({ version: 1, locked: [{ dir: LOCKED, name: 'deep-research', source: 'org' }], extra: true }), (file) => {
            expect(readSkillLocks(file)).toEqual({ kind: 'ok', dirs: [{ dir: LOCKED, name: 'deep-research' }] });
        });
        withFile(JSON.stringify({ version: 2, locked: [{ dir: LOCKED }] }), (file) => {
            expect(readSkillLocks(file)).toEqual({ kind: 'ok', dirs: [{ dir: LOCKED, name: 'deep-research' }] });
        });
    });

    it('tells an absent file from a corrupt one', () => {
        withFile(null, (file) => expect(readSkillLocks(file)).toEqual({ kind: 'absent' }));
        for (const bad of ['{', '[]', '{"version":1}', '{"version":0,"locked":[]}', '{"version":1,"locked":[{"dir":"relative"}]}', '{"version":1,"locked":[null]}']) {
            withFile(bad, (file) => expect(readSkillLocks(file)).toEqual({ kind: 'corrupt' }));
        }
    });
});
