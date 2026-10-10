#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
if (process.platform !== 'win32') throw new Error('Native Windows validation is required');
const helper = path.resolve(process.argv[2] || path.join(__dirname, '../native/windows-x64/user-protection.exe'));
const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(helper), 'user-protection.json'), 'utf8'));
assert.equal(createHash('sha256').update(fs.readFileSync(helper)).digest('hex'), manifest.sha256);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saycode-native-storage-'));
const purpose = file => 'saycode-dpapi-v1:' + file.toLowerCase();
function invoke(operation, input, binding) {
    const result = spawnSync(helper, [], { input: JSON.stringify({ version: 1, operation, purpose: binding, value: Buffer.from(input).toString('base64') }), windowsHide: true, timeout: 15000 });
    assert(!result.error, 'helper must exit within its deadline');
    const reply = JSON.parse(result.stdout.toString());
    assert.equal(reply.version, 1);
    if (!reply.ok) throw Object.assign(new Error(reply.error), { code: reply.error });
    assert.equal(result.status, 0);
    return Buffer.from(reply.value, 'base64');
}
function write(file, value, createOnly = false) { invoke('write-protected', JSON.stringify({ path: file, contents: value, createOnly }), purpose(file)); }
const read = file => invoke('read-protected', file, purpose(file)).toString();
try {
    const home = path.join(root, 'private', 'nested');
    invoke('prepare-directory', home, 'directory-v1');
    const roots = JSON.parse(invoke('storage-roots', '1', 'locations-v1').toString());
    assert.equal(roots.length, 2);
    const legacy = path.join(home, 'legacy.json');
    fs.writeFileSync(legacy, '{"fixture":"legacy-owned-key"}');
    // Elevated CI uses Administrators as the default file owner. Only this owned
    // fixture is assigned to the current SID to model a normal user's legacy file.
    const sid = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).stdout.match(/S-1-5-[\d-]+/)?.[0];
    assert(sid, 'current user SID is required');
    assert.equal(spawnSync('icacls.exe', [legacy, '/setowner', '*' + sid], { encoding: 'utf8' }).status, 0);
    assert.equal(read(legacy), '{"fixture":"legacy-owned-key"}');
    write(legacy, read(legacy));
    assert(!fs.readFileSync(legacy, 'utf8').includes('legacy-owned-key'));
    for (let i = 0; i < 12; i++) {
        const file = path.join(home, `한글 access ${'x'.repeat(i)}.key`), value = `owned-test-token-${i}`;
        assert.throws(() => read(file), { code: 'ENOENT' });
        write(file, value, true);
        assert.equal(read(file), value);
        assert(!fs.readFileSync(file, 'utf8').includes(value));
        assert.throws(() => write(file, 'wrong', true), { code: 'EEXIST' });
        write(file, value + '-renewed');
        assert.equal(read(file), value + '-renewed');
        const correct = fs.readFileSync(file), record = JSON.parse(correct.toString());
        const blob = Buffer.from(record.value, 'base64'); blob[blob.length - 1] ^= 1; record.value = blob.toString('base64');
        fs.writeFileSync(file, JSON.stringify(record));
        assert.throws(() => read(file));
        assert.throws(() => write(file, 'replacement-key'));
        assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(record));
        fs.writeFileSync(file, correct);
        const hardlink = file + '.link'; fs.linkSync(file, hardlink);
        assert.throws(() => read(file)); assert.throws(() => write(file, 'wrong'));
        fs.unlinkSync(hardlink);
        const writer = fs.openSync(file, 'r+');
        try { assert.throws(() => read(file)); assert.throws(() => write(file, 'wrong')); }
        finally { fs.closeSync(writer); }
        assert.equal(read(file), value + '-renewed');
        fs.unlinkSync(file);
    }
    const junction = path.join(root, 'junction'); fs.symlinkSync(home, junction, 'junction');
    assert.throws(() => read(path.join(junction, 'legacy.json')));
    assert.throws(() => invoke('prepare-directory', path.join(junction, 'child'), 'directory-v1'));
    fs.unlinkSync(junction);
    assert.deepEqual(fs.readdirSync(home), ['legacy.json']);
    console.log('Windows private storage: native round-trip, same key, legacy custody, exclusive/atomic publication, corrupt/link/writer refusal passed');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
