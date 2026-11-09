/**
 * Which Claude conversations on this machine ran on an organization LLM endpoint (aplus specs/org-llm-endpoints r3).
 *
 * An endpoint session marks every Claude conversation it runs with a non-secret file beside the transcript,
 * `<claudeSessionId>.org-endpoint` in the transcript's project directory. Whatever continues a transcript — a spawn that
 * resumes a Claude id, a fork that copies one, a terminal launch — finds the mark where it finds the transcript. Neither
 * the daemon's session record (which never learns the Claude id of a session that was not resumed) nor the server
 * metadata (keyed by the Happy id) can answer from a Claude id alone, and a resumed or forked conversation gets a new id.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const SUFFIX = '.org-endpoint'
/** Claude's conversation ids; anything else is not a file name this module builds. */
const CLAUDE_SESSION_ID = /^[A-Za-z0-9-]{1,128}$/

/** Marks the conversation as one that ran on an endpoint. The content is the session marker: ids only, never an address or a token. */
export function markOrgEndpointConversation(projectDir: string, claudeSessionId: string, marker: object): void {
    if (!CLAUDE_SESSION_ID.test(claudeSessionId)) return
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, `${claudeSessionId}${SUFFIX}`), JSON.stringify(marker), { mode: 0o600 })
}

/** Whether the conversation in this project directory ran on an endpoint. */
export function isOrgEndpointConversation(projectDir: string, claudeSessionId: string): boolean {
    return CLAUDE_SESSION_ID.test(claudeSessionId) && existsSync(join(projectDir, `${claudeSessionId}${SUFFIX}`))
}

/** Whether a conversation with this id ran on an endpoint in any project directory beside this one. */
export function isOrgEndpointConversationAnywhere(projectDir: string, claudeSessionId: string): boolean {
    if (!CLAUDE_SESSION_ID.test(claudeSessionId)) return false
    const projectsRoot = dirname(projectDir)
    return entries(projectsRoot).some((project) => existsSync(join(projectsRoot, project, `${claudeSessionId}${SUFFIX}`)))
}

/** Whether any conversation in this project directory ran on an endpoint. */
export function hasOrgEndpointConversation(projectDir: string): boolean {
    return entries(projectDir).some((name) => name.endsWith(SUFFIX))
}

function entries(directory: string): string[] {
    try {
        return readdirSync(directory)
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
    }
}
