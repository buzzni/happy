// Run as root on a disposable test host; the caller supplies an unused dedicated UID/GID.
const assert = require('node:assert/strict');
const { spawn, execFileSync, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { test, after } = require('node:test');
const fs = require('node:fs');
const { existsSync } = fs;
const { join } = require('node:path');
const [guardian, uid, gid, addon] = process.argv.slice(2);
assert.equal(process.platform, 'darwin');
assert.equal(process.getuid(), 0);
assert.ok(existsSync(guardian), 'build the guardian before running acceptance');
assert.match(uid, /^[1-9][0-9]+$/);
assert.match(gid, /^[1-9][0-9]+$/);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const recoveryDirs = [];
function recoveryDirectory() {
  const directory = fs.mkdtempSync('/private/var/tmp/saycode-guardian-check-');
  fs.chmodSync(directory, 0o700); recoveryDirs.push(directory); return directory;
}
after(() => { for (const directory of recoveryDirs) fs.rmSync(directory, { recursive: true, force: true }); });
function launch(program, args, identity = uid, recovery = recoveryDirectory()) {
  const child = spawn(guardian, [identity, gid, '/var/empty', recovery, program, ...args], {
    env: { PATH: '/usr/bin:/bin', HOME: '/var/empty' }, stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
  });
  child.stderr.pipe(process.stderr);
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  const ready = new Promise((resolve, reject) => {
    let text = '';
    let diagnostic = '';
    child.stderr.on('data', data => { diagnostic = (diagnostic + data).slice(-1024); });
    child.stdout.on('data', data => { text += data; if (text.includes('\n')) resolve(JSON.parse(text.split('\n')[0])); });
    child.once('exit', code => reject(new Error(`guardian exited before launch receipt (${code}): ${diagnostic}`)));
  });
  // A negative case may never await ready.
  ready.catch(() => {});
  return { child, exited, ready, recovery };
}
function live(pid) {
  try { return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).trim().startsWith('Z') === false; }
  catch { return false; }
}
test('clears supplementary groups and stops the original child group on control EOF', async () => {
  const script = 'import os,time,json,ctypes; groups=(ctypes.c_uint*16)(); count=ctypes.CDLL(None).getgroups(16,groups); os.write(4,(json.dumps({"uid":os.getuid(),"gid":os.getgid(),"groups":list(groups)[:count],"pid":os.getpid()})+"\\n").encode()); child=os.fork(); time.sleep(120)';
  const run = launch('/usr/bin/python3', ['-c', script]);
  try {
    const receipt = await run.ready;
    const [bytes] = await once(run.child.stdio[4], 'data');
    const identity = JSON.parse(bytes);
    assert.equal(identity.uid, Number(uid)); assert.equal(identity.gid, Number(gid));
    assert.deepEqual(identity.groups, [Number(gid)]); assert.equal(receipt.pid, identity.pid);
    await delay(100);
    const members = execFileSync('/bin/ps', ['-axo', 'pid=,pgid='], { encoding: 'utf8' }).trim().split('\n')
      .map(line => line.trim().split(/\s+/).map(Number)).filter(row => row[1] === receipt.pid).map(row => row[0]);
    assert.ok(members.length >= 2, 'exercise descendants, not only the root process');
    run.child.stdin.end();
    assert.deepEqual(await run.exited, { code: 0, signal: null });
    assert.equal(fs.existsSync(join(run.recovery, 'active')), false, 'confirmed drain clears the recovery latch');
    for (const pid of members) assert.equal(live(pid), false, `process ${pid} survived`);
  } finally { run.child.stdin.destroy(); await run.exited; }
});
test('ends after the program exits and refuses failed exec without a success receipt', async () => {
  const ended = launch('/usr/bin/true', []);
  await ended.ready; assert.equal((await ended.exited).code, 0);
  const bad = launch('/nonexistent/browser', []);
  assert.notEqual((await bad.exited).code, 0);
});
test('does not report successful termination when a descendant leaves the owned group', async () => {
  const script = 'import os,time; child=os.fork();\nif child==0:\n os.setsid(); os.write(4,b"escaped\\n"); os.read(3,1); os._exit(0)\nelse: time.sleep(120)';
  const run = launch('/usr/bin/python3', ['-c', script]);
  try {
    await run.ready;
    await once(run.child.stdio[4], 'data');
    const escapedEnded = new Promise(resolve => run.child.stdio[4].once('end', resolve));
    run.child.stdin.end();
    assert.equal((await run.exited).code, 126);
    assert.equal(fs.existsSync(join(run.recovery, 'active')), true, 'unknown drain preserves the recovery latch');
    run.child.stdio[4].resume();
    run.child.stdio[3].end('x'); // The test's original pipe, not a PID lookup.
    await escapedEnded;
  } finally { run.child.stdin.destroy(); run.child.stdio[3].destroy(); await run.exited; }
});
test('rejects root and noncanonical identities before executing anything', async () => {
  for (const invalid of ['0', '1', '-1', '0471', '471x', '4294967296']) {
    const run = launch('/usr/bin/true', [], invalid);
    assert.notEqual((await run.exited).code, 0);
  }
});
test('drains the owned group when its controlling runtime is killed', async () => {
  const parent = spawn(process.execPath, ['-e', `
    const {spawn}=require('node:child_process');
    const child=spawn(process.argv[1],[process.argv[2],process.argv[3],'/var/empty',process.argv[4],'/bin/sleep','120'],
      {env:{PATH:'/usr/bin:/bin'},stdio:['pipe','pipe','ignore','pipe','pipe']});
    child.stdout.on('data',data=>process.stdout.write(data));
    setInterval(()=>{},1000);
  `, guardian, uid, gid, recoveryDirectory()], { stdio: ['ignore', 'pipe', 'inherit'] });
  const ended = once(parent, 'exit');
  try {
    const [bytes] = await once(parent.stdout, 'data');
    const { pid } = JSON.parse(bytes);
    assert.equal(live(pid), true);
    parent.kill('SIGKILL'); await ended;
    for (let i = 0; i < 60 && live(pid); i++) await delay(100);
    assert.equal(live(pid), false, 'browser must not outlive its controlling runtime');
  } finally { if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL'); await ended; }
});
test('verifies custody modes and irreversibly drops root before runtime input', { skip: !addon }, () => {
  const binding = require(addon);
  const directory = fs.mkdtempSync('/private/var/tmp/saycode-custody-check-');
  try {
    fs.chmodSync(directory, 0o755);
    const state = join(directory, 'state'); fs.mkdirSync(state, { mode: 0o700 }); fs.chownSync(state, Number(uid), Number(gid));
    const canary = join(directory, 'root-canary'); fs.writeFileSync(canary, 'synthetic canary', { mode: 0o600 });
    const fd = fs.openSync(state, 'r');
    try {
      binding.verifyPrivateDirectory(fd, Number(uid));
      fs.chmodSync(state, 0o755);
      assert.throws(() => binding.verifyPrivateDirectory(fd, Number(uid)));
      binding.verifyPublicDirectory(fd, Number(uid));
      fs.chmodSync(state, 0o700);
    } finally { fs.closeSync(fd); }
    const child = spawnSync(process.execPath, ['-e', `
      const assert=require('node:assert/strict'), fs=require('node:fs'), host=require(process.argv[1]);
      host.dropMacIdentity(Number(process.argv[2]),Number(process.argv[3]));
      assert.equal(process.getuid(),Number(process.argv[2]));
      assert.equal(process.geteuid(),Number(process.argv[2]));
      assert.throws(()=>process.setuid(0));
      assert.throws(()=>fs.readFileSync(process.argv[4]));
      fs.writeFileSync(process.argv[5]+'/runtime-proof','private');
    `, addon, uid, gid, canary, state], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(fs.statSync(join(state, 'runtime-proof')).uid, Number(uid));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('refuses a second guardian and leaves a durable recovery latch after guardian SIGKILL', async () => {
  const recovery = recoveryDirectory();
  const run = launch('/usr/bin/python3', ['-c', 'import os; os.write(4,b"ready\\n"); os.read(3,1)'], uid, recovery);
  try {
    await run.ready; await once(run.child.stdio[4], 'data');
    assert.match(fs.readFileSync(join(recovery, 'active'), 'utf8'), /^v1 /);
    assert.equal(fs.statSync(join(recovery, 'active')).uid, 0);
    assert.equal(fs.statSync(join(recovery, 'active')).mode & 0o777, 0o600);
    const duplicate = launch('/usr/bin/true', [], uid, recovery);
    assert.notEqual((await duplicate.exited).code, 0);
    run.child.kill('SIGKILL'); await run.exited;
    const restart = launch('/usr/bin/true', [], uid, recovery);
    assert.notEqual((await restart.exited).code, 0);
    assert.equal(fs.existsSync(join(recovery, 'active')), true);
    // Stop only this fixture through its original inherited channel, never by PID lookup.
    const ended = once(run.child.stdio[4], 'end'); run.child.stdio[4].resume(); run.child.stdio[3].end('x'); await ended;
    const afterDrain = launch('/usr/bin/true', [], uid, recovery);
    assert.notEqual((await afterDrain.exited).code, 0, 'process exit alone cannot clear an uncertain persisted operation');
  } finally { run.child.stdin.destroy(); run.child.stdio[3].destroy(); await run.exited; }
});
test('refuses a writable or symlinked recovery directory without creating a receipt', async () => {
  const recovery = recoveryDirectory();
  fs.chmodSync(recovery, 0o777);
  assert.notEqual((await launch('/usr/bin/true', [], uid, recovery).exited).code, 0);
  fs.chmodSync(recovery, 0o700);
  const link = join(recoveryDirectory(), 'link'); fs.symlinkSync(recovery, link);
  assert.notEqual((await launch('/usr/bin/true', [], uid, link).exited).code, 0);
});

// Explicit dedicated account acceptance; never use a logged-in user's UID.
test('dedicated service domain drains and the same recovery directory can restart', { skip: !process.env.SAYCODE_GUARDIAN_DEDICATED_HOME }, async () => {
  const home = process.env.SAYCODE_GUARDIAN_DEDICATED_HOME;
  const recovery = recoveryDirectory();
  for (let attempt = 0; attempt < 2; attempt++) {
    const child = spawn(guardian, [uid, gid, home, recovery, '--dedicated-user-domain', '/bin/sleep', '120'], {
      env: { PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'inherit', 'pipe', 'pipe'],
    });
    const exited = once(child, 'exit');
    try {
      const receipt = await Promise.race([once(child.stdout, 'data'), exited.then(([code]) => { throw new Error(`no launch receipt: ${code}`); })]);
      assert.equal(JSON.parse(receipt[0]).uid, Number(uid));
      child.stdin.end();
      assert.deepEqual(await exited, [0, null]);
      assert.equal(fs.existsSync(join(recovery, 'active')), false);
    } finally { child.stdin.destroy(); await exited; }
  }
});

test('explicit recovery refuses a live guardian and only clears a drained dedicated identity', { skip: !process.env.SAYCODE_GUARDIAN_DEDICATED_HOME }, async () => {
  const home = process.env.SAYCODE_GUARDIAN_DEDICATED_HOME, recovery = recoveryDirectory();
  const recover = () => spawnSync(guardian, ['--recover', uid, gid, home, recovery], { encoding: 'utf8' });
  const run = launch('/bin/sleep', ['120'], uid, recovery);
  await run.ready;
  assert.notEqual(recover().status, 0, 'a live owner retains its latch');
  run.child.stdin.end(); await run.exited;
  // A root-owned stale operation from an exited guardian, never an invented PID.
  fs.writeFileSync(join(recovery, 'active'), `v1 uid=${uid} guardian=${run.child.pid}\n`, { mode: 0o600 });
  fs.chmodSync(join(recovery, 'active'), 0o644);
  assert.notEqual(recover().status, 0, 'unprotected records cannot authorize recovery');
  fs.chmodSync(join(recovery, 'active'), 0o600);
  const other = launch('/bin/sleep', ['120']);
  await other.ready;
  try { assert.notEqual(recover().status, 0, 'UID residue blocks recovery even with no previous guardian'); }
  finally { other.child.stdin.end(); await other.exited; }
  assert.equal(recover().status, 0);
  assert.equal(fs.existsSync(join(recovery, 'active')), false);
});

test('installed basic service connects, drains and restarts without a Guard', { skip: process.env.SAYCODE_NATIVE_SERVICE_ACCEPTANCE !== '1', timeout: 45000 }, async () => {
  const root = '/Library/Application Support/SaycodeNative';
  const config = JSON.parse(fs.readFileSync(join(root, 'runtime.json'), 'utf8'));
  assert.equal(config.nativeService.networkProtection, 'basic');
  assert.equal(config.nativeService.browserUid, Number(uid));
  for (let attempt = 0; attempt < 2; attempt++) {
    const child = spawn(join(root, 'runtime-basic-verification/node'), [join(root, 'runtime-basic-verification/dist/runtime.mjs')], {
      env: { PATH: '/usr/bin:/bin', ABP_CONFIG_FILE: join(root, 'runtime.json'), ABP_STATE_DIR: join(root, 'runtime-state') },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    const exited = once(child, 'exit');
    try {
      let healthy = false;
      for (let check = 0; check < 100 && child.exitCode === null; check++) {
        const health = await fetch(`http://127.0.0.1:${config.runtimePort}/v1/health`).then(r => r.json()).catch(() => null);
        if (health?.pid === child.pid && health.profiles?.length && health.profiles.every(p => p.connected)) { healthy = true; break; }
        await delay(100);
      }
      assert.equal(healthy, true, 'this service must connect its own browser');
      const status = await new Promise((resolve, reject) => {
        const request = require('node:http').get({ socketPath: config.brokerSocketPath, path: '/v1/sessions' }, response => { response.resume(); resolve(response.statusCode); });
        request.on('error', reject);
      });
      assert.equal(status, 401, 'native commands still require a fresh signature');
    } finally {
      child.kill('SIGTERM');
      assert.deepEqual(await exited, [0, null]);
    }
    assert.equal(fs.existsSync(join(root, 'guardian-state/active')), false);
    assert.equal(fs.statSync(join(root, 'browser/Google Chrome.app/Contents/MacOS/Google Chrome')).nlink, 1);
    const identities = execFileSync('/bin/ps', ['-axo', 'uid='], { encoding: 'utf8' }).trim().split(/\s+/).map(Number);
    assert.equal(identities.includes(Number(uid)), false);
    assert.equal(identities.includes(config.nativeService.runtimeUid), false);
  }
});

test('dedicated cleanup refuses interactive UIDs and mismatched service homes', async () => {
  for (const [identity, home] of [['501', '/Library/Application Support/SaycodeNative/browser-profile'], [uid, '/var/empty']]) {
    const recovery = recoveryDirectory();
    const result = spawnSync(guardian, [identity, gid, home, recovery, '--dedicated-user-domain', '/usr/bin/true'], { stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'] });
    assert.equal(result.status, 125);
    assert.equal(fs.existsSync(join(recovery, 'active')), false);
  }
});
