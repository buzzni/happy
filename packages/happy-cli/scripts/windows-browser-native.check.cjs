'use strict';
// Run on the target Windows host: node this-file.cjs <browser-host.node>.
// Uses only disposable files and child processes; never installs a service.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const binding = path.resolve(process.argv[2] || 'native/win32-x64/browser-host.node');
const host = process.platform === 'win32' ? require(binding) : undefined;
const check = (name, work) => test(name, { skip: process.platform !== 'win32', timeout: 30000 }, work);
const powershell = script => {
    const result = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { encoding: 'utf8', timeout: 15000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
};
check('kernel boot ID and token SID are shared by real child processes', () => {
    const own = host.processStart(process.pid);
    assert.match(own, /^\d+$/);
    assert.equal(host.processStart(process.pid), own);
    const sid = host.processPrincipal(process.pid);
    assert.match(sid, /^S-1-5-21-/);
    const child = spawnSync(process.execPath, ['-e', `const h=require(process.argv[1]); console.log(JSON.stringify([h.bootId(),h.processPrincipal(process.pid),h.processStart(process.pid)]))`, binding], { encoding: 'utf8', timeout: 5000 });
    assert.equal(child.status, 0, child.stderr);
    const [boot, principal, start] = JSON.parse(child.stdout);
    assert.equal(boot, host.bootId());
    assert.match(boot, /^[0-9a-f-]{36}$/i);
    assert.equal(principal, sid);
    assert.notEqual(start, own);
    assert.throws(() => host.processStart(-1));
});
check('kernel lock survives the call and is released after forced process exit', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abp-lock-'));
    const file = path.join(dir, 'writer');
    const child = spawn(process.execPath, ['-e', `const f=require('node:fs').openSync(process.argv[2],'w+'); require(process.argv[1]).lockWriter(f); process.stdout.write('ready'); setInterval(()=>{},1000)`, binding, file], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    try {
        await Promise.race([once(child.stdout, 'data'), exited.then(() => { throw Error('owner exited before ready'); })]);
        const fd = fs.openSync(file, 'r+');
        try { assert.throws(() => host.lockWriter(fd), { code: 'NATIVE_LOCK_BUSY' }); } finally { fs.closeSync(fd); }
        assert.match(host.processStart(child.pid), /^\d+$/);
        child.kill('SIGKILL');
        await exited;
        assert.equal(host.processStart(child.pid), null);
        const recovered = fs.openSync(file, 'r+');
        try { host.lockWriter(recovered); } finally { fs.closeSync(recovered); }
        fs.linkSync(file, path.join(dir, 'alias'));
        const linked = fs.openSync(file, 'r+');
        try { assert.throws(() => host.lockWriter(linked), { code: 'NATIVE_LOCK_UNSAFE' }); } finally { fs.closeSync(linked); }
    } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exited;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
check('opened-handle ACL rejects public credential read and executable write', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abp-acl-'));
    const file = path.join(dir, 'synthetic-credential');
    const sid = host.processPrincipal(process.pid);
    fs.writeFileSync(file, 'synthetic-only', { flag: 'wx' });
    const set = rights => powershell(`
        $ErrorActionPreference='Stop'
        $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(file).toString('base64')}'))
        $sid=New-Object Security.Principal.SecurityIdentifier('${sid}')
        $acl=New-Object Security.AccessControl.FileSecurity
        $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false)
        foreach($id in @($sid.Value,'S-1-5-18')) { $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($id)),'FullControl','Allow'))) }
        ${rights ? `$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier('S-1-1-0')),'${rights}','Allow')))` : ''}
        [IO.File]::SetAccessControl($p,$acl)
    `);
    const verify = privateFile => {
        const fd = fs.openSync(file, 'r');
        try { host.verifyServiceFile(fd, sid, privateFile); } finally { fs.closeSync(fd); }
    };
    try {
        set(); verify(true);
        set('Read');
        assert.throws(() => verify(true), { code: 'NATIVE_PATH_UNTRUSTED' });
        verify(false);
        set('Modify');
        assert.throws(() => verify(false), { code: 'NATIVE_PATH_UNTRUSTED' });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
