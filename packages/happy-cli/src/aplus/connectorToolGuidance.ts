const INTERNAL_MCP_SERVERS = new Set(['happy', 'aplus-common', 'aplus-company']);

export function listExpectedMcpServices(input: {
    expectedConnectors: string[];
    expectedMcpServices: string[];
    configuredServerNames: string[];
}): string[] {
    return [...new Set([
        ...input.expectedConnectors,
        ...input.expectedMcpServices,
        ...input.configuredServerNames,
    ].filter((name) => (
        /^[a-z0-9-]{1,64}$/.test(name) && !INTERNAL_MCP_SERVERS.has(name)
    )))].sort();
}

export function buildConnectorToolGuidance(
    expectedServices: string[],
    options?: { connectorPlatformConfigured?: boolean },
): string {
    // 기대 목록이 빈 경우는 두 가지다: (a) 커넥터 플랫폼이 붙어 있는데 인벤토리를
    // 확정하지 못한 세션, (b) 커넥터 플랫폼 자체가 없는 순수 로컬 실행. (b) 에는
    // 진단할 게이트웨이가 없으므로 커넥터 복구 지침을 넣지 않는다. 넣으면 로컬
    // 세션이 "연동이 없다" 대신 "플랫폼 장애"를 보고하게 되고, 이 블록은
    // operational 로 분류돼 saycodeSystemPromptEnabled:false 로도 제거되지 않는다.
    if (expectedServices.length === 0 && options?.connectorPlatformConfigured !== true) return '';
    return [
        expectedServices.length > 0
            ? `Saycode expects these connected MCP services in this session: ${expectedServices.join(', ')}.`
            : 'No expected Saycode MCP services are listed here; this does not establish that no services are connected.',
        'Before saying a service is unavailable or choosing a browser fallback, perform deferred MCP tool discovery for that service.',
        'If an expected service is absent or unusable, report an MCP configuration, authentication, or runtime problem.',
        'Use only Saycode connector gateway state for that diagnosis; a same-named claude.ai connector is a different integration and is not evidence about Saycode authentication.',
        'A separate OpenAI or ChatGPT plugin catalog reporting installed: false is not evidence that a Saycode connector is disconnected; do not recommend plugin installation to repair Saycode caller authentication.',
        'Do not recommend claude.ai connector reauthorization as a fix unless the user explicitly asked about that separate integration.',
        'Do not claim that the integration is unsupported solely because its tools are not currently visible.',
    ].join(' ');
}
