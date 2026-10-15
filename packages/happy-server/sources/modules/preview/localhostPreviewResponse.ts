import type { ServerResponse } from 'node:http';

export const LOCALHOST_PREVIEW_HEADER = 'x-happy-preview-transport';
export const LOCALHOST_PREVIEW_VERSION = 'localhost-v1';

/** Called only after the relay has verified token scope, ACL, and runtime binding. */
export function sendLocalhostPreviewResponse(reply: ServerResponse, response: {
    status: number;
    headers: Record<string, string | string[]>;
    bodyB64: string;
    truncated: boolean;
}): void {
    const headers: Record<string, string | string[]> = {};
    const body = Buffer.from(response.bodyB64, 'base64');
    for (const [key, value] of Object.entries(response.headers)) {
        // The daemon requests identity encoding. Keep app security/cookie/redirect
        // headers intact; transport acknowledgement cannot come from the app.
        if (['connection', 'keep-alive', 'transfer-encoding', 'content-length', LOCALHOST_PREVIEW_HEADER].includes(key.toLowerCase())) continue;
        headers[key] = value;
    }
    headers[LOCALHOST_PREVIEW_HEADER] = LOCALHOST_PREVIEW_VERSION;
    headers['Content-Length'] = String(body.length);
    if (response.truncated) headers['X-Preview-Truncated'] = '1';
    reply.writeHead(response.status, headers);
    reply.end(body);
}
