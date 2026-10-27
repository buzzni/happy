/**
 * `happy daemon start <preset>`의 MCP 주소와 신뢰 Studio 주소 기본값.
 *
 * 신뢰 주소는 고정 프리셋이 소유하며 임의의 MCP 주소에서 추론하지 않는다.
 */

type DaemonPreset = { mcpConfigUrl: string; studioOrigin: string }

const DAEMON_PRESETS: Record<string, DaemonPreset> = {
    saycode: {
        mcpConfigUrl: 'https://saycode.ai/api/me/mcp-config',
        studioOrigin: 'https://saycode.ai',
    },
}

export function resolveDaemonPreset(preset: string): DaemonPreset | undefined {
    return DAEMON_PRESETS[preset]
}
