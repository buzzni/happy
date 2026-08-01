/**
 * Renders the answers Happy CLI gives for slash commands that Claude Code only
 * implements in its interactive REPL. Over the remote path those commands reach
 * the Agent SDK as plain text and come back as "/x isn't available in this
 * environment", so we answer them here from the SDK init metadata we already
 * mirror onto the session.
 */

import type { Metadata } from '@/api/types';

type AnsweredCommand = 'mcp' | 'skills' | 'plugins';

/** Shown when the SDK init message has not landed on the session metadata yet. */
function notReady(subject: string): string {
    return `No ${subject} available. Session may still be initializing — try again after sending a message.`;
}

export function specialCommandResponse(type: AnsweredCommand, metadata: Metadata | null | undefined): string {
    if (type === 'mcp') {
        const servers = metadata?.mcpServers ?? [];
        return servers.length > 0
            ? '**MCP Servers**\n\n' + servers.map(s => `- **${s.name}** — ${s.status}`).join('\n')
            : 'No MCP servers configured. Session may still be initializing — try again after sending a message.';
    }

    if (type === 'plugins') {
        const plugins = metadata?.plugins ?? [];
        return plugins.length > 0
            ? '**Installed Plugins**\n\n' + plugins.map(p => `- **${p.name}** — \`${p.path}\``).join('\n')
            : notReady('plugins');
    }

    // Older runtimes only reported slashCommands; it is a superset of skills.
    const skills = metadata?.skills ?? metadata?.slashCommands ?? [];
    return skills.length > 0
        ? '**Available Skills**\n\n' + skills.map(s => `- /${s}`).join('\n')
        : notReady('skills');
}
