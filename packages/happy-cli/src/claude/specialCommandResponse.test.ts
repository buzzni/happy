import { describe, expect, it } from 'vitest';
import type { Metadata } from '@/api/types';
import { specialCommandResponse } from './specialCommandResponse';

function metadata(partial: Partial<Metadata>): Metadata {
    return partial as Metadata;
}

describe('specialCommandResponse', () => {
    it('lists installed plugins with their paths', () => {
        const text = specialCommandResponse('plugins', metadata({
            plugins: [
                { name: 'codex', path: '/home/dev/.claude/plugins/codex' },
                { name: 'discord', path: '/home/dev/.claude/plugins/discord' },
            ],
        }));

        expect(text).toContain('**Installed Plugins**');
        expect(text).toContain('**codex**');
        expect(text).toContain('/home/dev/.claude/plugins/codex');
        expect(text).toContain('**discord**');
    });

    it('tells the user to retry when plugin metadata has not arrived yet', () => {
        expect(specialCommandResponse('plugins', null)).toContain('may still be initializing');
        expect(specialCommandResponse('plugins', metadata({ plugins: [] }))).toContain('may still be initializing');
    });

    it('does not confuse an empty plugin list with skills or servers', () => {
        const text = specialCommandResponse('plugins', metadata({ skills: ['debug'], mcpServers: [{ name: 'happy', status: 'connected' }] }));
        expect(text).not.toContain('debug');
        expect(text).not.toContain('happy');
    });

    it('lists mcp servers with their status', () => {
        const text = specialCommandResponse('mcp', metadata({
            mcpServers: [{ name: 'happy', status: 'connected' }],
        }));

        expect(text).toContain('**MCP Servers**');
        expect(text).toContain('**happy** — connected');
    });

    it('lists skills, falling back to slashCommands for older runtimes', () => {
        expect(specialCommandResponse('skills', metadata({ skills: ['debug'] }))).toContain('- /debug');
        expect(specialCommandResponse('skills', metadata({ slashCommands: ['compact'] }))).toContain('- /compact');
    });
});
