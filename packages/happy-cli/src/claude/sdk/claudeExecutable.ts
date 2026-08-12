import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, resolve } from 'node:path';

function isExecutableFile(filePath: string): boolean {
    try {
        accessSync(filePath, constants.X_OK);
        return statSync(filePath).isFile();
    } catch {
        return false;
    }
}

function executableNames(platform: NodeJS.Platform, pathExt: string | undefined): string[] {
    if (platform !== 'win32') return ['claude'];

    const extensions = (pathExt ?? '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .map((extension) => extension.trim().toLowerCase())
        .filter(Boolean);
    return ['claude', ...extensions.map((extension) => `claude${extension}`)];
}

export function resolveClaudeCodeExecutable(
    env: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform,
): string | undefined {
    const override = env.HAPPY_CLAUDE_PATH?.trim();
    if (override) {
        if (!isAbsolute(override) || !isExecutableFile(override)) {
            throw new Error(`HAPPY_CLAUDE_PATH is not executable: ${override}`);
        }
        return override;
    }

    const names = executableNames(platform, env.PATHEXT);
    for (const directory of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
        for (const name of names) {
            const candidate = resolve(directory, name);
            if (isExecutableFile(candidate)) return candidate;
        }
    }

    return undefined;
}
