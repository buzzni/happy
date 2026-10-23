import { execSync } from 'child_process';
import os from 'os';
import { existsSync } from 'fs';
import { join } from 'path';

export interface CLIAvailability {
  claude: boolean;
  codex: boolean;
  gemini: boolean;
  openclaw: boolean;
  detectedAt: number;
}

/**
 * Detects which CLI tools are available on this machine.
 * Cross-platform: uses `command -v` on POSIX and a Path lookup on Windows.
 */
export function detectCLIAvailability(): CLIAvailability {
  const isWindows = os.platform() === 'win32';

  if (isWindows) {
    return detectWindows();
  }
  return detectPosix();
}

function commandExists(command: string): boolean {
  try {
    execSync(`command -v ${command} >/dev/null 2>&1`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function detectPosix(): CLIAvailability {
  const claude = commandExists('claude');
  const codex = commandExists('codex');
  const gemini = commandExists('gemini');

  // OpenClaw: check command, config file, or env var
  const openclawCommand = commandExists('openclaw');
  const openclawConfig = existsSync(join(os.homedir(), '.openclaw', 'openclaw.json'));
  const openclawEnv = !!process.env.OPENCLAW_GATEWAY_URL;
  const openclaw = openclawCommand || openclawConfig || openclawEnv;

  return { claude, codex, gemini, openclaw, detectedAt: Date.now() };
}

function detectWindows(): CLIAvailability {
  // Looks up Path in-process instead of asking powershell's Get-Command. The keep-alive
  // re-detects every 20s, and the shell spawn (node → cmd.exe → powershell.exe) flashed a
  // console window each time even with windowsHide.
  const pathEntries = (process.env.PATH ?? process.env.Path ?? '').split(';')
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
  const extensions = [...(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';'), '.PS1']
    .map((ext) => ext.trim())
    .filter(Boolean);
  const checkCommand = (name: string): boolean =>
    pathEntries.some((dir) => extensions.some((ext) => existsSync(join(dir, name + ext.toLowerCase()))));

  const claude = checkCommand('claude');
  const codex = checkCommand('codex');
  const gemini = checkCommand('gemini');

  // OpenClaw: check command, config file, or env var
  const openclawCommand = checkCommand('openclaw');
  const openclawConfig = existsSync(join(process.env.USERPROFILE || os.homedir(), '.openclaw', 'openclaw.json'));
  const openclawEnv = !!process.env.OPENCLAW_GATEWAY_URL;
  const openclaw = openclawCommand || openclawConfig || openclawEnv;

  return { claude, codex, gemini, openclaw, detectedAt: Date.now() };
}
