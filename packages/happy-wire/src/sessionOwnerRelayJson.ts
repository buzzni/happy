/** Relay JSON permits existing tool data (including negative/fractional numbers). Ownership
 * documents use a different, nonnegative-integer-only canonicalizer; do not change that domain. */
export const OWNER_RELAY_REQUEST_BYTES = 64 * 1024;
export const OWNER_RELAY_REPLY_BYTES = 128 * 1024;
const encoder = new TextEncoder();
const badUnicode = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
export function canonicalOwnerRelayJson(value: unknown, maxBytes = OWNER_RELAY_REPLY_BYTES): string {
    const bounded = (text: string) => {
        if (encoder.encode(text).length > maxBytes) throw new Error('Owner relay JSON exceeds byte limit');
        return text;
    };
    function encode(v: unknown, depth: number): string {
        if (depth > 64) throw new Error('Owner relay JSON too deep');
        if (v === null) return 'null';
        if (typeof v === 'string') {
            if (badUnicode.test(v)) throw new Error('Invalid Unicode');
            return bounded(JSON.stringify(v));
        }
        if (typeof v === 'boolean') return String(v);
        if (typeof v === 'number' && Number.isFinite(v)) return JSON.stringify(v);
        if (typeof v !== 'object' || !v) throw new Error('Invalid JSON value');
        if (Object.getOwnPropertySymbols(v).length) throw new Error('Invalid JSON key');
        if (Object.values(Object.getOwnPropertyDescriptors(v)).some(d => !('value' in d))) throw new Error('Non-JSON accessor');
        if (Array.isArray(v)) {
            if (Object.keys(v).length !== v.length) throw new Error('Non-JSON array');
            return bounded('[' + Array.from(v, entry => encode(entry, depth + 1)).join(',') + ']');
        }
        if (![Object.prototype, null].includes(Object.getPrototypeOf(v))) throw new Error('Non-JSON object');
        const descriptors = Object.getOwnPropertyDescriptors(v);
        if (Object.values(descriptors).some(d => !d.enumerable || !('value' in d))) throw new Error('Non-JSON property');
        // Direct construction preserves UTF-16 lexical order even for integer-looking keys.
        return bounded('{' + Object.keys(v).sort().map(key => encode(key, depth + 1) + ':' + encode(descriptors[key].value, depth + 1)).join(',') + '}');
    }
    return bounded(encode(value, 0));
}
export function ownerRelayJsonWithin(value: unknown, maxBytes: number): boolean {
    try { canonicalOwnerRelayJson(value, maxBytes); return true; } catch { return false; }
}
