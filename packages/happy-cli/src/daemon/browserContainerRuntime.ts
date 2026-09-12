import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { validateViewerKey } from './remoteViewer'

type Exec = (command: string, args: string[]) => Promise<string>

/** The container port noVNC is served on; the only one ever published. */
const VIEWER_CONTAINER_PORT = '6080/tcp'
const MANAGED_SESSION_LABEL = 'ai.saycode.browser-session'
const VIEWER_KEY_LABEL = 'ai.saycode.viewer-key'
/**
 * One `docker inspect` carrying everything the fingerprint is made of. A Go
 * template rather than `{{json .}}` so the broker parses a fixed five-field
 * line instead of the whole container document.
 */
const RUNTIME_INSPECT_FORMAT = [
    '{{.Id}}',
    '{{.State.StartedAt}}',
    `{{index .Config.Labels "${VIEWER_KEY_LABEL}"}}`,
    `{{index .Config.Labels "${MANAGED_SESSION_LABEL}"}}`,
    '{{json .NetworkSettings.Ports}}',
].join('\t')

/** Docker prints this for a container that has never run. */
const DOCKER_ZERO_TIME = '0001-01-01T00:00:00Z'
/** Go templates print this for an absent map key. */
const GO_NO_VALUE = '<no value>'
const CONTAINER_ID_RE = /^[0-9a-f]{12,64}$/
/** The publish address the daemon's own 127.0.0.1 connection provably lands on. */
const LOOPBACK_HOST_IP = '127.0.0.1'

type PortBinding = { HostIp?: unknown; HostPort?: unknown }

/**
 * Whether 6080 is published to loopback on exactly `hostPort`, and nowhere
 * else. A second binding on 0.0.0.0 is not "also fine": it means the viewer
 * is reachable from off-box, which is a different runtime posture than the
 * one the fingerprint would be claiming.
 */
function publishesOnlyLoopback(ports: unknown, hostPort: number): boolean {
    if (!ports || typeof ports !== 'object' || Array.isArray(ports)) return false
    const bindings = (ports as Record<string, unknown>)[VIEWER_CONTAINER_PORT]
    if (!Array.isArray(bindings) || bindings.length !== 1) return false
    const [binding] = bindings as PortBinding[]
    return binding?.HostIp === LOOPBACK_HOST_IP && String(binding?.HostPort) === String(hostPort)
}

/**
 * Opaque proof of *this run of this container*, for the daemon to bind a
 * viewer token to.
 *
 * `State.StartedAt` is in it for the same reason the project-side evidence
 * uses it and not `CreatedAt`: a `docker restart` keeps the id and the name,
 * so a fingerprint without the start time would still verify against the
 * process that replaced the one the token was minted for. The host port is in
 * it because the same container republished elsewhere is a different
 * destination.
 */
export function browserContainerRuntimeFingerprint(input: {
    containerId: string
    startedAt: string
    viewerKey: string
    hostPort: number
}): string {
    return createHash('sha256')
        .update([
            'browser-viewer-container',
            input.containerId,
            input.startedAt,
            input.viewerKey,
            String(input.hostPort),
            VIEWER_CONTAINER_PORT,
        ].join('\0'))
        .digest('hex')
}

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

    async lookup(viewerKey: string): Promise<{
        webPort: number
        profileVolume: string
        runtimeFingerprint?: string
    } | null> {
        const name = containerName(viewerKey)
        const state = await this.inspectContainer(name)
        if (!state.running || await this.health(name) !== 'healthy') return null
        const webPort = parsePublishedPort(await this.exec('docker', ['port', name, VIEWER_CONTAINER_PORT]))
        const runtimeFingerprint = await this.runtimeFingerprint(name, viewerKey, webPort)
        return {
            webPort,
            profileVolume: browserProfileVolume(viewerKey),
            // Absent rather than faked when anything could not be proven: the
            // daemon refuses a bound request with no fingerprint, and that is
            // the intended outcome — it must never fall back to weaker
            // evidence or to the native registry.
            ...(runtimeFingerprint ? { runtimeFingerprint } : {}),
        }
    }

    /**
     * Reads the container's real identity and refuses to describe anything it
     * could not confirm. Returns null on any mismatch or read failure.
     */
    private async runtimeFingerprint(
        name: string,
        viewerKey: string,
        webPort: number,
    ): Promise<string | null> {
        const raw = await this.exec('docker', ['inspect', '--format', RUNTIME_INSPECT_FORMAT, name])
            .then((value) => value.trim(), () => null)
        if (!raw) return null
        const [containerId, startedAt, viewerLabel, sessionLabel, portsJson] = raw.split('\t')
        if (!containerId || !CONTAINER_ID_RE.test(containerId)) return null
        if (!startedAt || startedAt === GO_NO_VALUE || startedAt === DOCKER_ZERO_TIME) return null
        // The label is the only thing tying this container to *this* user's
        // viewer; a name match is not the same claim.
        if (viewerLabel !== viewerKey) return null
        if (sessionLabel !== '1') return null
        let ports: unknown
        try {
            ports = JSON.parse(portsJson ?? '')
        } catch {
            return null
        }
        if (!publishesOnlyLoopback(ports, webPort)) return null
        return browserContainerRuntimeFingerprint({ containerId, startedAt, viewerKey, hostPort: webPort })
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
