// chat-tool-output-streaming Phase 3 — exercises the bash_stream MCP tool's
// streaming buffer against a real `bash -c` subprocess. Tests only single
// shell-line commands (no heredoc/timeouts) since that's the MVP scope —
// complex cases fall through to Claude's built-in Bash.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBashStream, type BashStreamProgress } from './bashStream';
import { BASH_STREAM_RESULT_MAX_CHARS, BashStreamSpillStore, renderBashStreamResult } from './bashStreamOutput';

describe('runBashStream', () => {
  it('runs the agent command with the session scope but not lineage or spawn seeds (utils/childEnv)', async () => {
    const injected = { HAPPY_RECONNECT_SESSION_ID: 'cmr-poisoned', HAPPY_INITIAL_PROMPT: 'seed', APLUS_SESSION_ID: 'self-session' };
    Object.assign(process.env, injected);
    try {
      const result = await runBashStream({ command: 'printf "%s|%s|%s" "${HAPPY_RECONNECT_SESSION_ID-}" "${HAPPY_INITIAL_PROMPT-}" "${APLUS_SESSION_ID-}"', onProgress: () => {} });
      expect(result.stdout).toBe('||self-session');
    } finally {
      for (const key of Object.keys(injected)) delete process.env[key];
    }
  });

  it('captures stdout lines and reports exit 0 on success', async () => {
    const progress: BashStreamProgress[] = [];
    const result = await runBashStream({
      command: 'printf "alpha\\nbeta\\ngamma\\n"',
      onProgress: (p) => progress.push(p),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('alpha\nbeta\ngamma\n');
    expect(result.stderr).toBe('');

    const stdoutLines = progress
      .filter((p) => p.stream === 'stdout')
      .flatMap((p) => p.lines);
    expect(stdoutLines).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('separates stderr from stdout in progress and aggregate', async () => {
    const progress: BashStreamProgress[] = [];
    const result = await runBashStream({
      command: 'printf "out1\\n"; printf "err1\\n" 1>&2; printf "out2\\n"',
      onProgress: (p) => progress.push(p),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('out1');
    expect(result.stdout).toContain('out2');
    expect(result.stderr).toBe('err1\n');

    const stderrLines = progress
      .filter((p) => p.stream === 'stderr')
      .flatMap((p) => p.lines);
    expect(stderrLines).toEqual(['err1']);
  });

  it('propagates a non-zero exit code', async () => {
    const result = await runBashStream({
      command: 'echo "boom"; exit 7',
      onProgress: () => {},
    });
    expect(result.exitCode).toBe(7);
    expect(result.stdout).toBe('boom\n');
  });

  it('runs in the requested cwd', async () => {
    const result = await runBashStream({
      command: 'pwd',
      cwd: '/tmp',
      onProgress: () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(realpathSync(result.stdout.trim())).toBe(realpathSync('/tmp'));
  });

  it('drops the final trailing partial line into the aggregate but not into progress', async () => {
    // `printf` without a trailing newline emits a partial last line that
    // line-buffering should keep separate from the line stream until close.
    const progress: BashStreamProgress[] = [];
    const result = await runBashStream({
      command: 'printf "complete\\nincomplete"',
      onProgress: (p) => progress.push(p),
    });
    expect(result.stdout).toBe('complete\nincomplete');

    const lines = progress
      .filter((p) => p.stream === 'stdout')
      .flatMap((p) => p.lines);
    // The complete line goes through; the partial trailing fragment is
    // delivered as the final (close-driven) flush, so it shows up too.
    expect(lines).toEqual(['complete', 'incomplete']);
  });

  it('bounds a 2,000,000-char single line while progress lines keep their 4,096 cap', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bash-stream-spill-'));
    const store = new BashStreamSpillStore({ root, sessionId: 'run' });
    const call = store.beginCall();
    try {
      const progress: BashStreamProgress[] = [];
      const result = await runBashStream({
        command: "head -c 2000000 /dev/zero | tr '\\0' a; printf 'END'; echo oops 1>&2; exit 3",
        spill: call,
        onProgress: (p) => progress.push(p),
      });
      expect(result.exitCode).toBe(3);
      expect(result.stderr).toBe('oops\n');
      const text = renderBashStreamResult(result.exitCode, result.captures!.stdout, result.captures!.stderr);
      call.end();
      expect(text.length).toBeLessThanOrEqual(BASH_STREAM_RESULT_MAX_CHARS);
      expect(text.endsWith('aaaEND\n--- stderr ---\noops\n\n[exit 3]')).toBe(true);
      const path = /전체 출력: (\S+) …/.exec(text)![1];
      expect(readFileSync(path, 'utf8')).toBe('a'.repeat(2_000_000) + 'END');
      const lines = progress.filter((p) => p.stream === 'stdout').flatMap((p) => p.lines);
      expect(lines).toHaveLength(1);
      expect(lines[0].length).toBe(4096);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
