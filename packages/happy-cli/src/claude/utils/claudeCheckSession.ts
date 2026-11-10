import { logger } from "@/ui/logger";
import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { getProjectPath } from "./path";

// Reads line by line and stops at the first match. Reading the whole transcript into one string
// throws ERR_STRING_TOO_LONG past ~512MB and blocks the caller (the daemon included) for seconds.
function someLine(file: string, matches: (line: string, index: number) => boolean): boolean {
    const fd = openSync(file, 'r');
    try {
        const buffer = Buffer.alloc(64 * 1024);
        const decoder = new StringDecoder('utf8');
        let pending = '';
        let index = 0;
        for (let read; (read = readSync(fd, buffer, 0, buffer.length, null)) > 0;) {
            const lines = (pending + decoder.write(buffer.subarray(0, read))).split('\n');
            pending = lines.pop()!;
            for (const line of lines) if (matches(line, index++)) return true;
        }
        return matches(pending + decoder.end(), index);
    } finally {
        closeSync(fd);
    }
}

export function claudeCheckSession(sessionId: string, path: string, configDirectory?: string) {
    const projectDir = getProjectPath(path, configDirectory);

    // Check if session id is in the project dir
    const sessionFile = join(projectDir, `${sessionId}.jsonl`);
    const sessionExists = existsSync(sessionFile);
    if (!sessionExists) {
        logger.debug(`[claudeCheckSession] Path ${sessionFile} does not exist`);
        return false;
    }

    // Check if session contains any messages with valid ID fields
    const hasGoodMessage = someLine(sessionFile, (v, index) => {
        if (!v.trim()) return false;  // Skip empty lines silently (not errors)

        try {
            const parsed = JSON.parse(v);
            // Accept sessions with any of these ID fields (different Claude Code versions)
            // Check for non-empty strings to handle edge cases robustly
            return (typeof parsed.uuid === 'string' && parsed.uuid.length > 0) ||        // Claude Code 2.1.x
                   (typeof parsed.messageId === 'string' && parsed.messageId.length > 0) ||   // Older Claude Code
                   (typeof parsed.leafUuid === 'string' && parsed.leafUuid.length > 0);      // Summary lines
        } catch (e) {
            // Log parse errors for debugging (following project convention)
            logger.debug(`[claudeCheckSession] Malformed JSON at line ${index + 1}:`, e);
            return false;
        }
    });

    // Log final validation result for observability
    logger.debug(`[claudeCheckSession] Session ${sessionId}: ${hasGoodMessage ? 'valid' : 'invalid'}`);

    return hasGoodMessage;
}