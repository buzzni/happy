/**
 * `happy daemon start <preset>` 뒤에 붙는 preset 이름 -> HAPPY_APLUS_MCP_CONFIG_URL 매핑.
 *
 * 매번 `HAPPY_APLUS_MCP_CONFIG_URL=https://saycode.ai/api/me/mcp-config happy daemon start`
 * 처럼 전체 URL을 입력하는 불편함을 줄이기 위한 shorthand.
 */

export const MCP_CONFIG_PRESETS: Record<string, string> = {
    saycode: 'https://saycode.ai/api/me/mcp-config',
}

export function resolveMcpConfigPresetUrl(preset: string): string | undefined {
    return MCP_CONFIG_PRESETS[preset]
}
