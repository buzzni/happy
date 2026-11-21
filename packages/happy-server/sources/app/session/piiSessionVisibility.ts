/** Compatibility declaration, not authorization. Always combined with the authenticated owner scope. */
export function piiSessionVisibility(request: { headers: Record<string, string | string[] | undefined> }): { piiProtection?: false } {
    return request.headers['x-happy-pii-protection'] === '1' ? {} : { piiProtection: false };
}

export function piiSocketVisibility(socket: { data?: { piiProtectionVersion?: unknown } }): { piiProtection?: false } {
    return socket.data?.piiProtectionVersion === 1 ? {} : { piiProtection: false };
}
