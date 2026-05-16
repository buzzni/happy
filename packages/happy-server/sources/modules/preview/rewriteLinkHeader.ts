/**
 * Link header (RFC 8288) parser + rewriter for the preview relay.
 *
 * Background: Next.js dev emits early-hint Link headers like
 *   Link: </_next/static/chunks/foo.css>; rel=preload; as="style"
 * The browser sees those before any HTML is parsed and issues preloads
 * against `location.origin` — which is the relay host, not the dev server.
 * Those preloads then either 404 or get the platform's SPA fallback HTML,
 * logging noisy "preloaded using link preload but not used" warnings.
 *
 * We can't rewrite the URL with a simple regex on the whole value because
 * Link headers can carry multiple comma-separated entries with quoted
 * parameter values that themselves may contain commas (e.g.
 * `rel="alternate, draft"`). So we parse properly and:
 *
 * - drop entries with `rel=preload` (HTML body carries equivalent
 *   <link rel="preload"> tags that already get rewritten by rewriteHtml),
 * - rewrite absolute-path URLs in surviving entries to include the
 *   `/v1/preview/{machineId}/{port}` prefix (so e.g. `rel=canonical` or
 *   `rel=manifest` URLs route through the proxy),
 * - return `null` when no entries survive (so the caller can drop the
 *   header entirely).
 *
 * See specs/preview-nextjs-turbopack-hydration/ Phase 3 (refinement of
 * the earlier blanket Link drop).
 */

interface LinkEntry {
    url: string;
    params: string[]; // Each is "key" or "key=value" (with quotes preserved if present)
}

function parseLinkHeader(value: string): LinkEntry[] {
    const entries: LinkEntry[] = [];
    let bracketDepth = 0;
    let inQuote = false;
    let start = 0;
    for (let i = 0; i < value.length; i++) {
        const c = value[i];
        if (c === '"' && value[i - 1] !== '\\') {
            inQuote = !inQuote;
        } else if (!inQuote) {
            if (c === '<') bracketDepth++;
            else if (c === '>') bracketDepth--;
            else if (c === ',' && bracketDepth === 0) {
                const entry = parseEntry(value.slice(start, i).trim());
                if (entry) entries.push(entry);
                start = i + 1;
            }
        }
    }
    const tail = parseEntry(value.slice(start).trim());
    if (tail) entries.push(tail);
    return entries;
}

function parseEntry(text: string): LinkEntry | null {
    if (!text) return null;
    // Pattern: <URL>; param1; param2
    const m = text.match(/^<([^>]*)>\s*(.*)$/);
    if (!m) return null;
    const url = m[1];
    const rest = m[2];
    const params = splitParams(rest);
    return { url, params };
}

function splitParams(text: string): string[] {
    // Split on `;` outside of double-quoted strings
    const out: string[] = [];
    let inQuote = false;
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '"' && text[i - 1] !== '\\') inQuote = !inQuote;
        else if (c === ';' && !inQuote) {
            const p = text.slice(start, i).trim();
            if (p) out.push(p);
            start = i + 1;
        }
    }
    const tail = text.slice(start).trim();
    if (tail) out.push(tail);
    return out;
}

function isPreloadEntry(entry: LinkEntry): boolean {
    return entry.params.some((p) => /^rel\s*=\s*(?:"preload"|preload)$/i.test(p.trim()));
}

function rewriteEntryUrl(entry: LinkEntry, prefix: string): LinkEntry {
    const u = entry.url;
    // Skip empty, protocol-relative, already-prefixed, and absolute external URLs.
    if (!u || u.startsWith('//') || u.startsWith(prefix) || !u.startsWith('/')) {
        return entry;
    }
    return { url: `${prefix}${u}`, params: entry.params };
}

function serializeEntry(entry: LinkEntry): string {
    const head = `<${entry.url}>`;
    return entry.params.length > 0 ? `${head}; ${entry.params.join('; ')}` : head;
}

/**
 * Returns the rewritten Link header value, or `null` when no entries
 * survive filtering (caller should drop the header).
 */
export function rewriteLinkHeader(value: string, prefix: string): string | null {
    const parsed = parseLinkHeader(value);
    const kept = parsed.filter((e) => !isPreloadEntry(e));
    if (kept.length === 0) return null;
    return kept.map((e) => serializeEntry(rewriteEntryUrl(e, prefix))).join(', ');
}
