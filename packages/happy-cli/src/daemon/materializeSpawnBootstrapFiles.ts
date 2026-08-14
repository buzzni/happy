import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const MANAGED_BOOTSTRAP_PATHS = new Set([
    '.aplus/agent/project-template.md',
    '.aplus/agent/mcp-catalog.md',
    '.aplus/agent/common-base.md',
    'AGENTS.md',
    'CLAUDE.md',
]);

export interface SpawnBootstrapFile {
    relativePath: string;
    content: string;
}

export async function materializeSpawnBootstrapFiles(
    workspaceRoot: string,
    files: SpawnBootstrapFile[],
): Promise<void> {
    for (const file of files) {
        if (!MANAGED_BOOTSTRAP_PATHS.has(file.relativePath)) {
            throw new Error(`Unsupported spawn bootstrap path: ${file.relativePath}`);
        }

        const target = join(workspaceRoot, file.relativePath);
        if (!file.relativePath.startsWith('.aplus/agent/')) {
            try {
                const existing = await readFile(target, 'utf8');
                if (
                    existing === file.content
                    || !isManagedProjectAgentInstructionContent(existing)
                ) {
                    continue;
                }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
        }

        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, file.content, 'utf8');
    }
}

function isManagedProjectAgentInstructionContent(content: string): boolean {
    if (content.startsWith('# Project Agent Instructions')) return true;
    if (content.startsWith('# A+ Project Template')) return true;
    if (
        content.includes('This workspace was created by A+ Dev Studio.')
        && content.includes('project-template')
    ) {
        return true;
    }
    return content.includes('@AGENTS.md')
        && content.includes('Claude Code reads `CLAUDE.md`');
}
