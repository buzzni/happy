import { spawn } from 'node:child_process';
type Manager = {
    registerHandler(method: string, handler: (params: unknown) => Promise<unknown>): void;
};
/** No shell, URL or caller-selected executable. The root helper authenticates the signed envelope. */
function invokeHelper(token: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const child = spawn('/usr/bin/sudo', ['-n', '/usr/local/sbin/abp-runtime-update'], {
            stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' }, cwd: '/',
        });
        let output = '';
        const timer = setTimeout(() => { child.kill(); reject(new Error('BROWSER_UPDATE_UNCONFIRMED')); }, 15000);
        child.stdout.on('data', chunk => { output += chunk; if (output.length > 16384)
            child.kill(); });
        child.stdin.on('error', () => undefined);
        child.on('error', () => { clearTimeout(timer); reject(new Error('BROWSER_UPDATE_HELPER_REQUIRED')); });
        child.on('close', code => {
            clearTimeout(timer);
            if (code !== 0 || output.length > 16384) {
                reject(new Error(output.includes('helper-refused') ? 'BROWSER_UPDATE_REFUSED' : 'BROWSER_UPDATE_HELPER_REQUIRED'));
                return;
            }
            try {
                resolve(JSON.parse(output));
            }
            catch {
                reject(new Error('BROWSER_UPDATE_UNCONFIRMED'));
            }
        });
        child.stdin.end(token);
    });
}
export function registerBrowserRuntimeUpdateRpc(manager: Manager, invoke = invokeHelper): void {
    manager.registerHandler('browser-runtime:update', async (params) => {
        if (!params || typeof params !== 'object' || Array.isArray(params))
            throw new Error('INVALID_UPDATE_REQUEST');
        const record = params as Record<string, unknown>;
        if (Object.keys(record).length !== 1 || typeof record.token !== 'string' || record.token.length > 16384 || !/^abp2\.[\w-]+\.[\w-]+\.[\w-]+$/.test(record.token))
            throw new Error('INVALID_UPDATE_REQUEST');
        return invoke(record.token);
    });
}
