/** Disposable-container proof of the production spawn seam. Never run on a real daemon host. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { prepareClaudeProcessSandbox } from '../src/sandbox/claudeProcessSandbox';
import { startHappyServer } from '../src/claude/utils/startHappyServer';
import type { ApiSessionClient } from '../src/api/apiSession';
import { BROWSER_TASK_TOOL_NAMES } from '../src/browserRuntime/agentTools';

assert.equal(process.platform, 'linux');
assert.equal(process.env.HAPPY_SANDBOX_LINUX_SMOKE, '1', 'requires the disposable-container opt-in');
assert.equal(process.env.HAPPY_HOME_DIR, '/synthetic-happy');
for (const dir of ['/work', '/run/abp', '/etc/abp', '/var/lib/abp', '/synthetic-happy', '/tmp/happy-session-synthetic', '/synthetic-claude']) mkdirSync(dir, { recursive: true });
const denied = ['/run/abp/key', '/etc/abp/key', '/var/lib/abp/daemon-token', '/synthetic-happy/access.key', '/tmp/happy-session-synthetic/access.key'];
for (const path of denied) writeFileSync(path, 'synthetic-canary');
const host = createServer((_req, res) => res.end('host-loopback-canary'));
await new Promise<void>(resolve => host.listen(0, '127.0.0.1', resolve));
const hostPort = (host.address() as { port: number }).port;
process.env.HAPPY_BROWSER_TASK_RUNTIME_URL = `http://127.0.0.1:${hostPort}`;
process.env.CLAUDE_CONFIG_DIR = '/synthetic-claude';
writeFileSync('/synthetic-claude/.credentials.json', 'synthetic-old');
const happy = await startHappyServer({ sessionId: 'synthetic-session', hasTitle: () => true } as ApiSessionClient, { mandatorySandbox: true });
const sandbox = await prepareClaudeProcessSandbox({
    sessionPath: '/work', mcpSocketPath: happy.socketPath,
    sandboxConfig: { enabled: true, sessionIsolation: 'strict', customWritePaths: [], extraWritePaths: [],
        denyReadPaths: ['/w/packages/happy-cli/CLAUDE.md'], denyWritePaths: [], networkMode: 'allowed', allowedDomains: [], deniedDomains: [], allowLocalBinding: false },
});
async function run(command: string, args: string[], signal = new AbortController().signal): Promise<{ code: number | null; output: string }> {
    const child = sandbox.spawn({ command, args, cwd: '/work', signal, env: {
        ...process.env, HAPPY_MASTER_SECRET: 'synthetic-secret', HAPPY_BROWSER_TASK_SESSION_SECRET: 'synthetic-secret',
    } });
    let output = '';
    child.stdout!.on('data', data => { output += data; });
    child.stdin!.end();
    return new Promise((resolve, reject) => {
        child.on('error', error => { if (error.name !== 'AbortError') reject(error); });
        child.on('exit', code => resolve({ code, output }));
    });
}
try {
    const literalArgs = ['', 'spaces and\nnewlines', "'quote'", '$(touch /work/injected)', '*'];
    const outputs = await Promise.all(Array.from({ length: 8 }, () => run(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...literalArgs])));
    for (const result of outputs) { assert.equal(result.code, 0); assert.deepEqual(JSON.parse(result.output), literalArgs); }
    console.log('PASS: concurrent real bwrap launches preserve argv');
    const checks = `
const fs = require('node:fs'), assert = require('node:assert/strict');
for (const path of ${JSON.stringify(denied)}) assert.throws(() => fs.readFileSync(path));
assert.throws(() => fs.writeFileSync('/w/packages/happy-cli/bin/claude-sandbox-launcher.sh', 'tamper'));
assert.equal(process.env.HAPPY_MASTER_SECRET, undefined);
assert.equal(process.env.HAPPY_BROWSER_TASK_SESSION_SECRET, undefined);
assert.equal(process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
assert.equal(process.env.DISABLE_AUTOUPDATER, '1');
try { assert.equal(fs.readFileSync('/w/packages/happy-cli/CLAUDE.md', 'utf8'), ''); } catch (e) { if (!['ENOENT', 'EACCES'].includes(e.code)) throw e; }
assert.equal(fs.readFileSync(process.env.CLAUDE_CONFIG_DIR + '/.credentials.json', 'utf8'), 'synthetic-old');
fs.writeFileSync(process.env.CLAUDE_CONFIG_DIR + '/.credentials.json', 'synthetic-refreshed');
fs.writeFileSync('/tmp/private-proof', 'private');
assert.notEqual(fs.readlinkSync('/proc/self/ns/pid'), ${JSON.stringify(readFileSync('/proc/self/status', 'utf8').includes('NSpid:') ? execFileSync('readlink', ['/proc/self/ns/pid'], { encoding: 'utf8' }).trim() : '')});
try { assert.equal(fs.readFileSync('/proc/${process.pid}/environ', 'utf8').includes('HAPPY_HOME_DIR='), false); } catch (e) { if (e.code !== 'ENOENT') throw e; }
console.log('PASS: deny list, immutable launcher, private proc/tmp and filtered env');
`;
    const fsResult = await run(process.execPath, ['-e', checks]);
    assert.equal(fsResult.code, 0); process.stdout.write(fsResult.output);
    assert.throws(() => readFileSync('/tmp/private-proof'));
    const refreshed = await run(process.execPath, ['-e', "process.stdout.write(require('node:fs').readFileSync(process.env.CLAUDE_CONFIG_DIR + '/.credentials.json'))"]);
    assert.equal(refreshed.output, 'synthetic-refreshed');
    assert.equal(readFileSync('/synthetic-claude/.credentials.json', 'utf8'), 'synthetic-old');
    console.log('PASS: synthetic credential refresh persists between spawns without shared-home writes');
    const unix = await run('python3', ['-c', 'import socket\ntry: socket.socket(socket.AF_UNIX)\nexcept PermissionError: pass\nelse: raise AssertionError("AF_UNIX was allowed")']);
    assert.equal(unix.code, 0);
    const loopback = await run('curl', ['--noproxy', '*', '--max-time', '2', '-s', `http://127.0.0.1:${hostPort}`]);
    assert.notEqual(loopback.code, 0);
    const proxy = await run('curl', ['--max-time', '3', '-s', '-o', '/dev/null', '-w', '%{http_code}', '-x', 'http://127.0.0.1:3128', 'http://denied.invalid']);
    assert.equal(proxy.output, '403');
    console.log('PASS: seccomp rejects AF_UNIX; host loopback and non-allowlisted proxy destinations blocked');
    const mcpScript = `
const { Client } = await import('/w/packages/happy-cli/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
const { StdioClientTransport } = await import('/w/packages/happy-cli/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');
const client = new Client({name:'sandbox-smoke',version:'1'},{capabilities:{}});
await client.connect(new StdioClientTransport({command:process.execPath,args:['/w/packages/happy-cli/bin/happy-mcp.mjs'],env:{...process.env,...${JSON.stringify(happy.mcpConfig.env)}}}));
const result = await client.listTools();
console.log(JSON.stringify(result.tools.map(t=>t.name).sort()));
await client.close();
`;
    const mcp = await run(process.execPath, ['--input-type=module', '-e', mcpScript]);
    assert.equal(mcp.code, 0);
    assert.deepEqual(JSON.parse(mcp.output), ['change_title', ...BROWSER_TASK_TOOL_NAMES].sort());
    console.log('PASS: actual happy-mcp stdio bridge traverses authenticated Unix socket under seccomp');
    const controller = new AbortController();
    const pending = run('/bin/sh', ['-c', 'sleep 60 & wait'], controller.signal);
    setTimeout(() => controller.abort(), 300);
    await pending;
    console.log('PASS: cancellation exits observed bwrap child');
} finally {
    await sandbox.close(); happy.stop(); host.close();
}
