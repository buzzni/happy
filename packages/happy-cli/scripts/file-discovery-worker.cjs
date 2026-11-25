// Versioned, bounded IO. Never accepts shell commands or caller-supplied flags.
const fs = require('node:fs');
const path = require('node:path');
const ignore = require('ignore');
process.once('message', ({ allowedRoot, request: r, forkedAt }) => {
const LIMIT = 1024 * 1024;
const NOFOLLOW_ANY = 0x20000000; // Darwin fcntl.h; rejects symlinks in ALL components atomically.
const WINDOWS = process.platform === 'win32';
// Names Windows maps elsewhere: devices (CON, NUL, COM1…), alternate data streams (`a:b`), and the trailing dot/space it strips.
const WINDOWS_ALIAS = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$|:|[. ]$/i;
const excluded = new Set(['node_modules', 'dist', 'out', 'build', 'coverage']);
let base, root;
function fail(code) { const e = new Error(code); e.code = code; throw e; }
/**
 * Windows has no NOFOLLOW_ANY. Every component below the trusted base is lstat'ed first and none may be a link: lstat reports
 * symlinks and junctions alike as symbolic links, and a junction needs no privilege, so a project can carry one pointing anywhere.
 * The opened handle must then be the checked file, and the chain is checked again after the open. Unlike Darwin this is not atomic:
 * swapping a component between the checks needs a process already running as this user, which can read those files directly.
 */
function linkFreeChain(target, from) {
    const rel = path.relative(from, target), parts = rel.split(path.sep).filter(Boolean);
    if (parts[0] === '..' || path.isAbsolute(rel)) fail('outside-root');
    let current = from, stat = fs.lstatSync(from);
    for (const part of parts) {
        if (WINDOWS_ALIAS.test(part)) fail('invalid-request');
        current = path.join(current, part); stat = fs.lstatSync(current);
        if (stat.isSymbolicLink()) { const e = new Error('ELOOP'); e.code = 'ELOOP'; throw e; }
    }
    return stat;
}
/**
 * A walk opens a folder (whole chain checked) and then the entries it lists. On a Windows PC with security software each lstat cost
 * about as much as reading the file (630 vs 2,174 files read in 4.5s, 2026-11-25), so walked entries are not re-checked from the base:
 * `walkedFolder` checks only from that folder down (the folder's .gitignore), and `listed` trusts the folder listing's own link flag,
 * which the walk already skipped on (a listed file).
 */
function open(relative, directory = false, walkedFolder, listed = false) {
    if (typeof relative !== 'string' || relative.includes('\0') || relative.includes('\\') || path.isAbsolute(relative)
        || relative.split('/').some(p => p === '..' || p === '.')) fail('invalid-request');
    const target = relative ? path.join(root, relative) : root;
    const from = walkedFolder === undefined ? base : path.join(root, walkedFolder);
    if (WINDOWS && listed && WINDOWS_ALIAS.test(path.basename(target))) fail('invalid-request');
    const checked = WINDOWS && !listed ? linkFreeChain(target, from) : null;
    const fd = fs.openSync(target, WINDOWS ? fs.constants.O_RDONLY : fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | NOFOLLOW_ANY);
    const stat = fs.fstatSync(fd);
    if (checked && (stat.dev !== checked.dev || stat.ino !== checked.ino || linkFreeChain(target, from).ino !== checked.ino)) { fs.closeSync(fd); fail('changed'); }
    if (directory ? !stat.isDirectory() : !stat.isFile()) { fs.closeSync(fd); fail('not-file'); }
    return { fd, stat };
}
function read(relative, max, walkedFolder, listed) {
    const { fd, stat } = open(relative, false, walkedFolder, listed);
    try { if (stat.size > max) return null; const buf = Buffer.alloc(Math.min(stat.size, max)); return buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)); }
    finally { fs.closeSync(fd); }
}
function identity(s) { return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`; }
function execute() {
    if (process.platform !== 'darwin' && !WINDOWS) fail('unsupported');
    if (!r || r.version !== 1) fail('invalid-request');
    if (r.operation === 'capabilities') {
        const fd = fs.openSync(fs.realpathSync(allowedRoot), WINDOWS ? fs.constants.O_RDONLY : fs.constants.O_RDONLY | NOFOLLOW_ANY);
        fs.closeSync(fd); return { supported: true, platform: process.platform };
    }
    if (typeof r.root !== 'string' || !path.isAbsolute(r.root) || r.root.includes('\0')) fail('invalid-request');
    base = fs.realpathSync(allowedRoot);
    // Resolve only the trusted machine base; never realpath an untrusted requested target.
    const lexicalBase = path.resolve(allowedRoot), requested = path.resolve(r.root);
    const rel = path.relative(lexicalBase, requested);
    // path.sep, not '/': on Windows path.relative answers `..\outside`, which a '../' prefix check let through.
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) fail('outside-root');
    root = path.join(base, rel);
    const checked = open('', true); fs.closeSync(checked.fd);
    if (r.operation === 'stat' || r.operation === 'read') {
        const { fd, stat } = open(r.path);
        try {
            const key = identity(stat);
            if (r.operation === 'stat') return { size: stat.size, identity: key };
            if (!Number.isSafeInteger(r.offset) || r.offset < 0 || !Number.isSafeInteger(r.length) || r.length < 1 || r.length > 262144) fail('invalid-request');
            if (r.identity !== undefined && r.identity !== key) fail('changed');
            if (stat.size > 25 * LIMIT) fail('too-large');
            const buf = Buffer.alloc(Math.min(r.length, Math.max(0, stat.size - r.offset)));
            const bytes = fs.readSync(fd, buf, 0, buf.length, r.offset);
            if (identity(fs.fstatSync(fd)) !== key) fail('changed');
            return { content: buf.subarray(0, bytes).toString('base64'), identity: key, size: stat.size, offset: r.offset, eof: r.offset + bytes >= stat.size };
        } finally { fs.closeSync(fd); }
    }
    if (r.operation !== 'search' || typeof r.query !== 'string' || !r.query.trim() || r.query.includes('\0') || Buffer.byteLength(r.query) > 4096) fail('invalid-request');
    const matches = []; let partial = false, halted = false, reason, visited = 0, bytes = 100, sent = 0;
    // From the fork, not from this process's start: on a Windows PC starting node alone took ~2s of the parent's 5s, and the
    // parent then killed the walk and kept only its last progress report.
    const started = Number.isFinite(forkedAt) ? Math.min(forkedAt, Date.now()) : Date.now();
    function stop(why) { partial = true; halted = true; reason = why; }
    function unreadable() { partial = true; reason ??= 'unreadable'; }
    function walk(relative, inherited, depth) {
        if (halted) return;
        if (Date.now() - started >= 4500) { stop('time-limit'); return; }
        if (depth > 64 || ++visited > 10000) { stop('scan-limit'); return; }
        const checked = open(relative, true);
        let entries;
        try {
            entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true });
            // Enumeration carries no file contents. Discard it if its path changed while listing.
            const after = open(relative, true);
            try { if (after.stat.dev !== checked.stat.dev || after.stat.ino !== checked.stat.ino) fail('changed'); }
            finally { fs.closeSync(after.fd); }
        } finally { fs.closeSync(checked.fd); }
        if (entries.length > 10000) { stop('scan-limit'); return; }
        const rules = [...inherited];
        try { const buf = read(path.posix.join(relative, '.gitignore'), 65536, relative); if (!buf) { unreadable(); return; } rules.push({ base: relative, matcher: ignore().add(buf.toString('utf8')) }); }
        catch (e) { if (e.code !== 'ENOENT') { unreadable(); return; } }
        for (const entry of entries) {
            if (halted) break;
            if (++visited > 10000 || Date.now() - started >= 4500) { stop('scan-limit'); break; }
            if (entry.name.startsWith('.') || excluded.has(entry.name) || entry.isSymbolicLink()) continue;
            const name = path.posix.join(relative, entry.name);
            if (rules.some(rule => rule.matcher.ignores((rule.base ? name.slice(rule.base.length + 1) : name) + (entry.isDirectory() ? '/' : '')))) continue;
            if (entry.isDirectory()) {
                try { walk(name, rules, depth + 1); } catch { unreadable(); }
                continue;
            }
            if (!entry.isFile()) continue;
            try {
                const buf = read(name, LIMIT, relative, true);
                if (!buf) { partial = true; reason ??= 'file-limit'; continue; }
                if (buf.includes(0)) continue;
                const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
                const lines = text.split('\n');
                for (let i = 0; i < lines.length; i++) {
                    if (!lines[i].includes(r.query)) continue;
                    let snippet = lines[i].slice(Math.max(0, lines[i].indexOf(r.query) - 80), Math.max(0, lines[i].indexOf(r.query) - 80) + 2048);
                    while (Buffer.byteLength(snippet) > 2048 || /[\uD800-\uDBFF]$/.test(snippet)) snippet = snippet.slice(0, -1);
                    const hit = { path: name, line: i + 1, text: snippet };
                    const size = Buffer.byteLength(JSON.stringify(hit));
                    if (bytes + size > 500 * 1024) { stop('byte-limit'); break; }
                    bytes += size; matches.push(hit);
                    if (matches.length >= 200) { stop('result-limit'); break; }
                }
                if (matches.length - sent >= 16) { sent = matches.length; process.send({ progress: true, matches }); }
            } catch (e) { if (e.code === 'ERR_ENCODING_INVALID_ENCODED_DATA') continue; unreadable(); }
        }
    }
    walk('', [], 0);
    return { matches, partial, ...(reason ? { reason } : {}) };
}
try { process.send({ version: 1, success: true, ...execute() }, () => process.exit(0)); }
catch (e) { process.send({ version: 1, success: false, error: ['unsupported', 'outside-root', 'invalid-request', 'changed', 'too-large', 'not-file'].includes(e.code) ? e.code : 'unavailable' }, () => process.exit(0)); }
});
