export const DEFAULT_BROWSER_BRIDGE_PORT = 41777

export function resolveBrowserBridgeHost(env: NodeJS.ProcessEnv): string {
    return env.HAPPY_BROWSER_BRIDGE_HOST?.trim() || '127.0.0.1'
}
