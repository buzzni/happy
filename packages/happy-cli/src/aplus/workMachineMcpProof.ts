import { readTrustedStudioOrigin } from '@/daemon/setupTokenBindingProof';

export type WorkMachineMcpProof = { sessionId: string; token: () => string };

export function workMachineMcpHeaders(
    url: string,
    proof: WorkMachineMcpProof,
    sessionId?: string,
): Record<string, string> | null {
    const parsed = new URL(url);
    if (parsed.origin !== readTrustedStudioOrigin(process.env) || parsed.username || parsed.password || parsed.hash
        || !['/api/me/mcp-config', '/api/me/mcp-caller-grant/refresh'].includes(parsed.pathname)
        || (sessionId !== undefined && sessionId !== proof.sessionId)) return null;
    const token = proof.token();
    if (token.length > 4096 || !/^wmx_\S+$/.test(token)) return null;
    return { 'X-Aplus-Session-Id': proof.sessionId, 'X-Aplus-Work-Machine-Execution': token };
}
