// Versioned, bounded IO. Never accepts shell commands or caller-supplied flags.
const fs = require('node:fs');
const path = require('node:path');
const ignore = require('ignore');
process.once('message', ({ allowedRoot, request: r }) => {
const LIMIT = 1024 * 1024;
const NOFOLLOW_ANY = 0x20000000; // Darwin fcntl.h; rejects symlinks in ALL components atomically.
const excluded = new Set(['node_modules', 'dist', 'out', 'build', 'coverage']);
let root;
function fail(code) { const e = new Error(code); e.code = code; throw e; }
function open(relative, directory = false) {
    if (typeof relative !== 'string' || relative.includes('\0') || relative.includes('\\') || path.isAbsolute(relative)
        || relative.split('/').some(p => p === '..' || p === '.')) fail('invalid-request');
    const target = relative ? path.join(root, relative) : root;
    const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | NOFOLLOW_ANY);
    const stat = fs.fstatSync(fd);
    if (directory ? !stat.isDirectory() : !stat.isFile()) { fs.closeSync(fd); fail('not-file'); }
    return { fd, stat };
}
function read(relative, max) {
    const { fd, stat } = open(relative);
    try { if (stat.size > max) return null; const buf = Buffer.alloc(Math.min(stat.size, max)); return buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)); }
    finally { fs.closeSync(fd); }
}
function identity(s) { return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`; }
function execute() {
    if (process.platform !== 'darwin') fail('unsupported');
    if (!r || r.version !== 1) fail('invalid-request');
    if (r.operation === 'capabilities') {
        const fd = fs.openSync(fs.realpathSync(allowedRoot), fs.constants.O_RDONLY | NOFOLLOW_ANY);
        fs.closeSync(fd); return { supported: true, platform: process.platform };
    }
    if (typeof r.root !== 'string' || !path.isAbsolute(r.root) || r.root.includes('\0')) fail('invalid-request');
    const base = fs.realpathSync(allowedRoot);
    // Resolve only the trusted machine base; never realpath an untrusted requested target.
    const lexicalBase = path.resolve(allowedRoot), requested = path.resolve(r.root);
    const rel = path.relative(lexicalBase, requested);
    if (rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) fail('outside-root');
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
    const started = Date.now();
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
        try { const buf = read(path.posix.join(relative, '.gitignore'), 65536); if (!buf) { unreadable(); return; } rules.push({ base: relative, matcher: ignore().add(buf.toString('utf8')) }); }
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
                const buf = read(name, LIMIT);
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
