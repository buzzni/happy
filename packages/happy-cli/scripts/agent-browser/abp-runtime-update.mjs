#!/usr/bin/env node
// Root-only signed update receiver. stdin carries the envelope; never argv or logs.
import { createPublicKey, verify } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmdirSync, existsSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
const BASE = '/var/lib/abp/runtime-update';
const SELF = '/usr/local/libexec/abp/abp-runtime-update.mjs';
const ENV = { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/root', LANG: 'C.UTF-8' };
const digest = /^sha256:[0-9a-f]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const deny = () => { throw Error('invalid-update-authorization'); };
export function verifyRequest(token, config, now = Date.now()) {
    if (typeof token !== 'string' || token.length > 16384)
        deny();
    const parts = token.split('.');
    if (parts.length !== 4 || parts[0] !== 'abp2')
        deny();
    const head = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (head.alg !== 'EdDSA' || head.typ !== 'abp-runtime-update')
        deny();
    const issuer = config.trustedIssuers.find(i => i.kid === head.kid);
    if (!issuer)
        deny();
    const key = createPublicKey(issuer.publicKeyPem);
    if (key.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(parts.slice(0, 3).join('.')), key, Buffer.from(parts[3], 'base64url')))
        deny();
    const p = JSON.parse(Buffer.from(parts[2], 'base64url').toString());
    if (p.kind !== 'runtime-update' || p.iss !== 'saycode-server' || p.aud !== config.machineId || p.machineId !== config.machineId || p.workspaceId !== config.workspaceId || !p.principalId || !uuid.test(p.requestId ?? ''))
        deny();
    if (!Number.isSafeInteger(p.issuedAtMs) || !Number.isSafeInteger(p.expiresAtMs) || p.issuedAtMs > now + 30_000 || p.expiresAtMs <= now || p.expiresAtMs <= p.issuedAtMs || p.expiresAtMs - p.issuedAtMs > 60000)
        deny();
    if (!['start', 'status'].includes(p.action))
        deny();
    if (p.action === 'start') {
        const m = p.manifest;
        if (m?.schemaVersion !== 1 || typeof m.version !== 'string' || !/^[0-9][0-9A-Za-z.+-]{0,100}$/.test(m.version))
            deny();
        for (const image of [m.runtime, m.browser])
            if (!/^docker\.io\/[a-z0-9_-]+\/abp-(runtime|browser)@sha256:[0-9a-f]{64}$/.test(image?.ref ?? '') || !digest.test(image?.ids?.amd64 ?? '') || !digest.test(image?.ids?.arm64 ?? ''))
                deny();
    }
    return p;
}
export async function runUpgrade(manifest, architecture, deps) {
    try {
        await deps.upgrade();
        const state = deps.current(), arch = ['x86_64', 'x64'].includes(architecture) ? 'amd64' : architecture === 'arm64' || architecture === 'aarch64' ? 'arm64' : undefined;
        const matches = role => state[role] === manifest[role].ids[arch] || state[role] === manifest[role].ref.split('@')[1];
        if (!arch || !matches('runtime') || !matches('browser') || !(await deps.status()).ok)
            return { phase: 'failed', reason: 'verification-failed' };
        return { phase: 'complete' };
    }
    catch {
        return { phase: 'failed', reason: 'upgrade-failed', recovered: await deps.status().then(s => s.ok === true, () => false) };
    }
}
/** The durable nonce prevents replay across process restarts; the directory serializes launches. */
export function consumeStart(claim, base) {
    try {
        writeFileSync(`${base}/nonce-${claim.requestId}`, String(claim.expiresAtMs), { flag: 'wx', mode: 0o600 });
    }
    catch {
        throw Error('request-replayed');
    }
    try {
        mkdirSync(`${base}/busy`, { mode: 0o700 });
        return true;
    }
    catch {
        return false;
    }
}
function trusted(path, directory = false) { const s = lstatSync(path); if (s.uid !== 0 || (s.mode & 0o022) || s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile()))
    throw Error('unsafe-installation'); }
function read(path) { trusted(path); return JSON.parse(readFileSync(path, 'utf8')); }
function save(name, data) { const path = `${BASE}/${name}`; writeFileSync(`${path}.next`, JSON.stringify(data), { mode: 0o600 }); renameSync(`${path}.next`, path); }
const execute = promisify(execFile);
async function status() { const { stdout } = await execute('/usr/local/sbin/abp-stack', ['status', '--json'], { env: ENV, cwd: '/', timeout: 30000, maxBuffer: 262144 }); return JSON.parse(stdout); }
async function worker() {
    const job = read(`${BASE}/job.json`);
    // The request was already consumed and authorized before scheduling; this root-only file is the job.
    const result = await runUpgrade(job.manifest, process.arch, {
        upgrade: () => execute('/usr/local/sbin/abp-stack', ['upgrade', '--pull', `${BASE}/manifest.json`], { env: ENV, cwd: '/', maxBuffer: 1048576 }),
        current: () => read('/var/lib/abp/stack-state.json').current ?? {}, status,
    });
    save('status.json', { requestId: job.requestId, version: job.manifest.version, ...result, finishedAt: Date.now() });
    rmdirSync(`${BASE}/busy`);
}
async function main() {
    if (process.getuid?.() !== 0)
        throw Error('root-required');
    for (const p of ['/etc/abp', '/var/lib/abp'])
        trusted(p, true);
    mkdirSync(BASE, { recursive: true, mode: 0o700 });
    trusted(BASE, true);
    if (process.argv[2] === '--worker') {
        if (process.argv.length !== 3)
            deny();
        await worker();
        return;
    }
    if (process.argv.length !== 2)
        deny();
    let input = '';
    for await (const part of process.stdin) {
        input += part;
        if (input.length > 16384)
            deny();
    }
    const claim = verifyRequest(input.trim(), read('/etc/abp/runtime.json'));
    if (claim.action === 'status') {
        const result = existsSync(`${BASE}/status.json`) ? read(`${BASE}/status.json`) : { phase: 'idle' };
        // An abandoned worker is unconfirmed, never success and never automatically restarted.
        if (result.phase === 'updating' && Date.now() - result.startedAt > 20 * 60000)
            result.phase = 'unconfirmed';
        console.log(JSON.stringify(result));
        return;
    }
    if (!consumeStart(claim, BASE)) {
        console.log(JSON.stringify({ phase: 'busy' }));
        return;
    }
    try {
        save('job.json', claim);
        save('manifest.json', claim.manifest);
        save('status.json', { phase: 'updating', requestId: claim.requestId, version: claim.manifest.version, startedAt: Date.now() });
        const child = spawn('/usr/bin/node', [SELF, '--worker'], { env: ENV, cwd: '/', detached: true, stdio: 'ignore' });
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        child.unref();
        console.log(JSON.stringify({ phase: 'updating', requestId: claim.requestId, version: claim.manifest.version }));
    }
    catch {
        save('status.json', { phase: 'failed', reason: 'worker-start-failed' });
        rmdirSync(`${BASE}/busy`);
        throw Error('worker-start-failed');
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
    main().catch(() => { console.log(JSON.stringify({ phase: 'failed', reason: 'helper-refused' })); process.exitCode = 1; });
