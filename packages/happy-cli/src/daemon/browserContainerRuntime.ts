import { execFile } from 'node:child_process'
import { validateViewerKey } from './remoteViewer'

type Exec = (command: string, args: string[]) => Promise<string>

function containerName(viewerKey: string): string {
    return `happy-browser-${viewerKey}`
}

function networkName(viewerKey: string): string {
    return `happy-browser-net-${viewerKey}`
}

export function browserProfileVolume(viewerKey: string): string {
    if (!validateViewerKey(viewerKey)) throw new Error('invalid viewer key')
    return `happy-browser-profile-${viewerKey}`
}

function assertPinnedImage(image: string): void {
    if (!/@sha256:[a-f0-9]{64}$/.test(image)) throw new Error('browser container image must be digest-pinned')
}

export function buildBrowserContainerRunArgs(input: {
    viewerKey: string
    bridgeToken: string
    image: string
}): string[] {
    assertPinnedImage(input.image)
    const volume = browserProfileVolume(input.viewerKey)
    return [
        'run', '--detach', '--name', containerName(input.viewerKey),
        '--label', 'ai.saycode.browser-session=1',
        '--label', `ai.saycode.viewer-key=${input.viewerKey}`,
        '--user', '1000:1000',
        '--read-only', '--pids-limit', '256', '--memory', '1g', '--cpus', '1.0',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--tmpfs', '/tmp:rw,noexec,nosuid,size=512m',
        '--network', networkName(input.viewerKey),
        '--add-host', 'host.docker.internal:host-gateway',
        '--publish', '127.0.0.1::6080/tcp',
        '--volume', `${volume}:/home/browser/profile`,
        '--env', `HAPPY_BROWSER_VIEWER_KEY=${input.viewerKey}`,
        '--env', `HAPPY_BROWSER_BRIDGE_TOKEN=${input.bridgeToken}`,
        '--env', 'HAPPY_BROWSER_BRIDGE_HOST=host.docker.internal',
        '--env', 'HAPPY_BROWSER_BRIDGE_PORT=41777',
        '--env', 'HOME=/tmp',
        input.image,
    ]
}

function defaultExec(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(command, args, { encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout) => {
            if (error) reject(error)
            else resolve(stdout)
        })
    })
}

function parsePublishedPort(output: string): number {
    const match = output.trim().match(/127\.0\.0\.1:(\d+)$/m)
    const port = Number(match?.[1])
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error('browser container did not publish a loopback noVNC port')
    }
    return port
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export class BrowserContainerRuntime {
    private readonly exec: Exec

    constructor(private readonly options: { image: string; exec?: Exec }) {
        assertPinnedImage(options.image)
        this.exec = options.exec ?? defaultExec
    }

    async ensure(viewerKey: string, bridgeToken: string): Promise<{
        webPort: number
        profileVolume: string
        reused: boolean
    }> {
        const name = containerName(viewerKey)
        const state = await this.inspectContainer(name)
        let running = state.running
        if (state.exists && !running) {
            await this.removeContainer(viewerKey)
        } else if (running) {
            const health = await this.health(name)
            if (health === 'unhealthy' || health === 'missing') {
                await this.removeContainer(viewerKey)
                running = false
            }
        }
        if (!running) {
            await this.ensureNetwork(viewerKey)
            await this.exec('docker', ['volume', 'create', browserProfileVolume(viewerKey)])
            await this.exec('docker', buildBrowserContainerRunArgs({
                viewerKey,
                bridgeToken,
                image: this.options.image,
            }))
        }
        let health = ''
        for (let attempt = 0; attempt < 60; attempt++) {
            health = await this.health(name)
            if (health === 'healthy') break
            if (health === 'unhealthy' || health === 'missing') break
            await wait(1_000)
        }
        if (health !== 'healthy') {
            await this.removeContainer(viewerKey)
            throw new Error(`browser container healthcheck is ${health || 'unavailable'}`)
        }
        const port = parsePublishedPort(await this.exec('docker', ['port', name, '6080/tcp']))
        return { webPort: port, profileVolume: browserProfileVolume(viewerKey), reused: running }
    }

    async stop(viewerKey: string): Promise<boolean> {
        const stopped = await this.exec('docker', ['rm', '--force', containerName(viewerKey)])
            .then(() => true, () => false)
        await this.exec('docker', ['network', 'rm', networkName(viewerKey)]).catch(() => undefined)
        return stopped
    }

    async listManaged(): Promise<Array<{ viewerKey: string }>> {
        const output = await this.exec('docker', [
            'ps', '--filter', 'label=ai.saycode.browser-session=1',
            '--format', '{{.Label "ai.saycode.viewer-key"}}',
        ])
        return output.split('\n').map((viewerKey) => viewerKey.trim())
            .filter(validateViewerKey)
            .map((viewerKey) => ({ viewerKey }))
    }

    async lookup(viewerKey: string): Promise<{ webPort: number; profileVolume: string } | null> {
        const name = containerName(viewerKey)
        const state = await this.inspectContainer(name)
        if (!state.running || await this.health(name) !== 'healthy') return null
        const webPort = parsePublishedPort(await this.exec('docker', ['port', name, '6080/tcp']))
        return { webPort, profileVolume: browserProfileVolume(viewerKey) }
    }

    async migrateLegacyProfile(viewerKey: string, legacyProfileDir: string): Promise<void> {
        const volume = browserProfileVolume(viewerKey)
        await this.exec('docker', ['volume', 'create', volume])
        await this.exec('docker', [
            'run', '--rm', '--network', 'none', '--cap-drop', 'ALL',
            '--security-opt', 'no-new-privileges',
            '--volume', `${legacyProfileDir}:/source:ro`,
            '--volume', `${volume}:/destination`,
            this.options.image,
            'migrate-profile', '/source', '/destination',
        ])
    }

    async profileBytes(viewerKey: string): Promise<number> {
        const output = await this.exec('docker', [
            'run', '--rm', '--network', 'none', '--cap-drop', 'ALL',
            '--security-opt', 'no-new-privileges', '--read-only',
            '--volume', `${browserProfileVolume(viewerKey)}:/profile:ro`,
            this.options.image,
            'profile-bytes', '/profile',
        ])
        const bytes = Number(output.trim())
        if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('invalid browser profile usage')
        return bytes
    }

    private inspectContainer(name: string): Promise<{ exists: boolean; running: boolean }> {
        return this.exec('docker', ['inspect', '--format', '{{.State.Running}}', name])
            .then((value) => ({ exists: true, running: value.trim() === 'true' }), () => ({ exists: false, running: false }))
    }

    private health(name: string): Promise<string> {
        return this.exec('docker', ['inspect', '--format', '{{.State.Health.Status}}', name])
            .then((value) => value.trim(), () => 'missing')
    }

    private async ensureNetwork(viewerKey: string): Promise<void> {
        const name = networkName(viewerKey)
        const exists = await this.exec('docker', ['network', 'inspect', name]).then(() => true, () => false)
        if (exists) return
        await this.exec('docker', [
            'network', 'create', '--driver', 'bridge',
            '--label', 'ai.saycode.browser-session=1',
            '--label', `ai.saycode.viewer-key=${viewerKey}`,
            name,
        ])
    }

    private async removeContainer(viewerKey: string): Promise<void> {
        await this.exec('docker', ['rm', '--force', containerName(viewerKey)]).catch(() => undefined)
        await this.exec('docker', ['network', 'rm', networkName(viewerKey)]).catch(() => undefined)
    }
}
