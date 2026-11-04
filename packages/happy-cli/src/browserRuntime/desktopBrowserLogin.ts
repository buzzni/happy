import { request } from 'node:http'
import { createReadStream } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { z } from 'zod'
import { BrowserRuntimeError } from './contracts'
import type { NativeBrokerRequestOptions } from './brokerGrantSource'

const id = z.string().min(1).max(256)
export const desktopBrowserLoginDescriptor = z.object({ protocol: z.literal(1), machineId: id, workspaceId: id,
    principalId: id, profileId: id, socketPath: z.string().min(1).max(256),
    secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/), loginId: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict()
export type DesktopBrowserLoginDescriptor = z.infer<typeof desktopBrowserLoginDescriptor>

/** No descriptor file or user token: main hands an execution-scoped credential to the authenticated local daemon. */
export async function checkDesktopBrowserLoginSocket(descriptor: DesktopBrowserLoginDescriptor): Promise<void> {
    if (process.platform === 'win32') {
        const prefix = '\\\\.\\pipe\\saycode-browser-login-'
        if (!descriptor.socketPath.startsWith(prefix) || !/^[a-f0-9]{64}$/.test(descriptor.socketPath.slice(prefix.length))) throw Error('DESKTOP_BROWSER_LOGIN_UNSAFE')
        return
    }
    if (!isAbsolute(descriptor.socketPath) || descriptor.socketPath.includes('\0')) throw Error('DESKTOP_BROWSER_LOGIN_UNSUPPORTED')
    const [directory, socket] = await Promise.all([lstat(dirname(descriptor.socketPath)), lstat(descriptor.socketPath)])
    if (!directory.isDirectory() || directory.isSymbolicLink() || !socket.isSocket() || socket.isSymbolicLink() ||
        directory.uid !== process.getuid?.() || socket.uid !== process.getuid?.() || (directory.mode & 0o077) || (socket.mode & 0o077)) throw Error('DESKTOP_BROWSER_LOGIN_UNSAFE')
}

export function createDesktopBrowserLoginClient(raw: unknown, expected: { machineId: string; workspaceId: string; principalId: string; profileId: string }) {
    const descriptor = desktopBrowserLoginDescriptor.parse(raw)
    for (const key of ['machineId', 'workspaceId', 'principalId', 'profileId'] as const) {
        if (descriptor[key] !== expected[key]) throw Error('DESKTOP_BROWSER_LOGIN_SCOPE_CHANGED')
    }
    const send = async (body: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
        const req = request({ socketPath: descriptor.socketPath, method: 'POST', path: '/v1/browser-login',
            headers: { 'content-type': 'application/json', 'x-saycode-browser-login': descriptor.secret },
            signal, timeout: 5000, agent: false }, res => {
            let raw = ''
            res.setEncoding('utf8')
            res.on('data', chunk => { raw += chunk; if (Buffer.byteLength(raw) > 16384) req.destroy(Error('DESKTOP_BROWSER_LOGIN_UNAVAILABLE')) })
            res.on('error', reject)
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    let denied = false
                    try { denied = JSON.parse(raw).error === 'DESKTOP_BROWSER_LOGIN_DENIED' } catch {}
                    return reject(Error(denied ? 'DESKTOP_BROWSER_LOGIN_DENIED' : 'DESKTOP_BROWSER_LOGIN_REQUIRED'))
                }
                try { resolve(JSON.parse(raw)) } catch { reject(Error('DESKTOP_BROWSER_LOGIN_UNAVAILABLE')) }
            })
        })
        req.on('error', () => reject(Error('DESKTOP_BROWSER_LOGIN_REQUIRED')))
        req.on('timeout', () => req.destroy(Error('DESKTOP_BROWSER_LOGIN_REQUIRED')))
        req.end(JSON.stringify(body))
    })
    const check = async (signal?: AbortSignal) => {
        try {
            const result = await send({ operation: 'check' }, signal)
            if (result.protocol !== 1 || result.loginId !== descriptor.loginId ||
                (['machineId', 'workspaceId', 'principalId', 'profileId'] as const).some(key => result[key] !== descriptor[key])) throw Error('scope')
        } catch (error) {
            if (error instanceof Error && error.message === 'DESKTOP_BROWSER_LOGIN_DENIED') throw new BrowserRuntimeError('SCOPE_DENIED', 'Permission to use this execution PC has changed', false)
            throw new BrowserRuntimeError('UNAUTHORIZED', 'Open Saycode and sign in on the execution PC to use its AI browser', false)
        }
    }
    const issue: NativeBrokerRequestOptions['issue'] = async (command, signal) => {
        const result = await send({ operation: 'issue', command }, signal)
        if (typeof result.token !== 'string' || result.token.length > 8192 || typeof result.expiresAtMs !== 'number') throw Error('DESKTOP_BROWSER_LOGIN_UNAVAILABLE')
        return { token: result.token, expiresAtMs: result.expiresAtMs }
    }
    return { descriptor, check, issue }
}

/** Descriptor arrives over a dedicated inherited pipe, never in session env or a persistent file. */
export async function readDesktopBrowserLoginPipe(): Promise<unknown> {
    let raw = ''
    const input = createReadStream('', { fd: 3, autoClose: true })
    const timer = setTimeout(() => input.destroy(Error('DESKTOP_BROWSER_LOGIN_REQUIRED')), 5000)
    try {
        for await (const chunk of input) {
            raw += chunk
            if (Buffer.byteLength(raw) > 8192) throw Error('DESKTOP_BROWSER_LOGIN_INVALID')
        }
        return JSON.parse(raw)
    } finally { clearTimeout(timer); input.destroy() }
}
