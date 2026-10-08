import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, win32 } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export const BROWSER_NATIVE_HOST_NAME = 'ai.saycode.happy_browser'
const BROWSER_NATIVE_HOST_FILE = `${BROWSER_NATIVE_HOST_NAME}.json`
const execFileAsync = promisify(execFile)

export interface NativeMessagingHostRegistry {
    setManifestPath(name: string, manifestPath: string): Promise<void>
}

const windowsNativeMessagingHostRegistry: NativeMessagingHostRegistry = {
    async setManifestPath(name, manifestPath) {
        const key = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${name}`
        await execFileAsync('reg.exe', ['ADD', key, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], {
            windowsHide: true,
        })
    },
}

function manifestPathJoin(platform: NodeJS.Platform, homeDir: string, ...parts: string[]): string {
    // Tests can exercise the win32 branch on a POSIX host with a temporary
    // directory. Real Windows homes are drive-letter or UNC paths.
    if (platform === 'win32' && (/^[A-Za-z]:[\\/]/.test(homeDir) || homeDir.startsWith('\\\\'))) {
        return win32.join(homeDir, ...parts)
    }
    return join(homeDir, ...parts)
}

export async function prepareBrowserNativeMessaging({ readToken, registerHost, onRegistrationError }: {
    readToken: () => Promise<string>
    registerHost: () => Promise<string | null>
    onRegistrationError: (error: unknown) => void
}): Promise<{ token: string; manifestPath: string | null }> {
    // Finish legacy-token migration before Chrome can discover and launch the
    // helper. Otherwise the helper can create a new machine-wide token first.
    const token = await readToken()
    try {
        return { token, manifestPath: await registerHost() }
    } catch (error) {
        onRegistrationError(error)
        return { token, manifestPath: null }
    }
}

export function resolveBrowserNativeHostManifestPath({ platform, homeDir }: {
    platform: NodeJS.Platform
    homeDir: string
}): string | null {
    if (platform === 'darwin') {
        return manifestPathJoin(
            platform,
            homeDir,
            'Library',
            'Application Support',
            'Google',
            'Chrome',
            'NativeMessagingHosts',
            BROWSER_NATIVE_HOST_FILE,
        )
    }
    if (platform === 'linux') {
        return manifestPathJoin(
            platform,
            homeDir,
            '.config',
            'google-chrome',
            'NativeMessagingHosts',
            BROWSER_NATIVE_HOST_FILE,
        )
    }
    if (platform === 'win32') {
        return manifestPathJoin(platform, homeDir, 'AppData', 'Local', 'Saycode', 'NativeMessagingHosts', BROWSER_NATIVE_HOST_FILE)
    }
    return null
}

/** The same extension published on the Chrome Web Store; users install it there instead of loading the bundle unpacked. */
export const CHROME_WEB_STORE_EXTENSION_ID = 'oonefemjapkafdiibkllemkjdlmmblbc'

export function buildBrowserNativeHostManifest({ extensionId, helperPath }: {
    extensionId: string
    helperPath: string
}) {
    if (!isAbsolute(helperPath) && !/^[A-Za-z]:[\\/]/.test(helperPath)) {
        throw new Error('Native Messaging helper path must be absolute')
    }
    return {
        name: BROWSER_NATIVE_HOST_NAME,
        description: 'Provides local Happy Browser Bridge pairing settings',
        path: helperPath,
        type: 'stdio' as const,
        allowed_origins: [...new Set([extensionId, CHROME_WEB_STORE_EXTENSION_ID])].map(id => `chrome-extension://${id}/`),
    }
}

/**
 * Chrome on Windows starts the manifest `path` as a process and cannot run a
 * `.mjs` script (it opens the "choose an app" dialog instead), so the manifest
 * points at a batch file that runs the host script with the daemon's own Node.
 * Chrome appends the extension origin and `--parent-window=<n>`; `%*` forwards
 * them, and stdio is inherited unchanged.
 */
export function buildWindowsNativeHostBatch({ nodePath, scriptPath }: { nodePath: string; scriptPath: string }): string {
    for (const value of [nodePath, scriptPath]) {
        if (/["\r\n]/.test(value)) throw new Error('Native Messaging host path cannot be quoted in a batch file')
    }
    const quote = (value: string) => `"${value.replace(/%/g, '%%')}"`
    return `@echo off\r\nchcp 65001 >nul\r\n${quote(nodePath)} ${quote(scriptPath)} %*\r\n`
}

export async function registerBrowserNativeHost({ platform, homeDir, extensionId, helperPath, nodePath = process.execPath, registry }: {
    platform: NodeJS.Platform
    homeDir: string
    extensionId: string
    helperPath: string
    /** Windows only: the Node that runs `helperPath` through the batch wrapper. */
    nodePath?: string
    registry?: NativeMessagingHostRegistry
}): Promise<string | null> {
    const manifestPath = resolveBrowserNativeHostManifestPath({ platform, homeDir })
    if (!manifestPath) return null

    await mkdir(dirname(manifestPath), { recursive: true })
    let manifestHelperPath = helperPath
    if (platform === 'win32') {
        manifestHelperPath = manifestPath.replace(/\.json$/, '.cmd')
        await writeFile(manifestHelperPath, buildWindowsNativeHostBatch({ nodePath, scriptPath: helperPath }), 'utf8')
    }
    const manifest = buildBrowserNativeHostManifest({ extensionId, helperPath: manifestHelperPath })
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    if (platform === 'win32') {
        await (registry ?? windowsNativeMessagingHostRegistry).setManifestPath(BROWSER_NATIVE_HOST_NAME, manifestPath)
    }
    return manifestPath
}
