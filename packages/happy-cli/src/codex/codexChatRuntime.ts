import type { AplusMcpServersMap } from '@/aplus/fetchAplusMcpServers';
import { access, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/** Runtime configuration only. Prompts, attachments and generated documents never go here. */
export async function prepareCodexChatRuntime(
    env: Record<string, string>,
    version: { major: number; minor: number; patch: number } | null,
) {
    if (!version || (version.major === 0 && version.minor < 155)) {
        throw new Error('Chat 모드는 Codex CLI 0.155.0 이상이 필요합니다. 머신의 Codex를 업데이트하거나 Claude를 선택해 주세요.');
    }
    const directory = await mkdtemp(join(tmpdir(), 'happy-chat-runtime-'));
    try {
        await writeFile(join(directory, 'environments.toml'), 'include_local = false\nenvironments = []\n', { mode: 0o600 });
        const authPath = join(env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json');
        try {
            await access(authPath);
            await symlink(authPath, join(directory, 'auth.json'));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            // API-key/proxy authentication does not need a local auth.json.
        }
        const disabled = [
            'shell_tool', 'unified_exec', 'view_image', 'code_mode', 'code_mode_host',
            'multi_agent', 'multi_agent_v2', 'image_generation', 'computer_use', 'browser_use',
            'in_app_browser', 'workspace_dependencies', 'plugins', 'apps', 'hooks',
            'shell_snapshot', 'memories',
        ];
        return {
            env: { ...env, CODEX_HOME: directory },
            args: [
                ...disabled.flatMap((feature) => ['-c', `features.${feature}=false`]),
                '-c', 'history.persistence="none"',
                '-c', 'project_doc_max_bytes=0',
                '-c', 'include_environment_context=false',
            ],
            cleanup: () => rm(directory, { recursive: true, force: true }),
        };
    } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
    }
}


/** A no-local-environment Codex cannot launch the usual stdio HTTP bridge. */
export function buildCodexChatMcpServers(servers: AplusMcpServersMap) {
    if (!servers.saycode) throw new Error('Chat requires the saycode document MCP server.');
    return { saycode: {
        url: servers.saycode.url,
        ...(servers.saycode.headers ? { http_headers: servers.saycode.headers } : {}),
        enabled_tools: ['search_documents', 'read_document', 'write_document', 'get_mode', 'request_mode_transition'],
    } };
}
