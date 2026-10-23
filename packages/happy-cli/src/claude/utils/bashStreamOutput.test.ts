// Codex CLI benchmarking B-R6 — the bash_stream tool result stays within
// 30,000 chars (head + tail, middle omitted) while the full output of each
// truncated stream lands in an owner-only spill file.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BASH_STREAM_RESULT_MAX_CHARS,
  BashStreamSpillStore,
  SPILL_LIMIT_SENTENCE,
  StreamCapture,
  allocateStreamBudgets,
  bashStreamSpillStoreFor,
  removeBashStreamSpillStore,
  renderBashStreamResult,
} from './bashStreamOutput';

const STDERR_SEPARATOR = '\n--- stderr ---\n';
const legacyText = (stdout: string, stderr: string, exitCode: number) =>
  (stdout || '') + (stderr ? `${STDERR_SEPARATOR}${stderr}` : '') + `\n[exit ${exitCode}]`;

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'bash-stream-output-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function capture(stream: 'stdout' | 'stderr', text: string, call?: ReturnType<BashStreamSpillStore['beginCall']>, chunk = 65_536): StreamCapture {
  const result = new StreamCapture(stream, call);
  for (let i = 0; i < text.length; i += chunk) result.push(text.slice(i, i + chunk));
  result.finish();
  return result;
}

function spillDir(store: BashStreamSpillStore): string {
  return store.sessionDir;
}

const pathFrom = (text: string) => /전체 출력(?:\(일부만 저장\))?: (\S+) …/.exec(text)?.[1];

describe('allocateStreamBudgets (fair share with spillover)', () => {
  it('leaves both streams whole when they fit', () => {
    expect(allocateStreamBudgets(100, 200, 1_000)).toEqual([100, 200]);
  });
  it('gives a short stream all it needs and the rest to the long one', () => {
    expect(allocateStreamBudgets(100, 5_000, 1_000)).toEqual([100, 900]);
    expect(allocateStreamBudgets(5_000, 100, 1_000)).toEqual([900, 100]);
  });
  it('splits evenly when both exceed half', () => {
    expect(allocateStreamBudgets(5_000, 7_000, 1_001)).toEqual([500, 501]);
  });
});

describe('renderBashStreamResult', () => {
  it('is identical to the legacy text and leaves no file when it fits', () => {
    const store = new BashStreamSpillStore({ root, sessionId: 'sess-1' });
    const call = store.beginCall();
    const stdout = 'x'.repeat(20_000);
    const stderr = 'warning\n'.repeat(1_000);
    const text = renderBashStreamResult(3, capture('stdout', stdout, call), capture('stderr', stderr, call));
    call.end();
    expect(text).toBe(legacyText(stdout, stderr, 3));
    expect(existsSync(spillDir(store))).toBe(false);
  });

  it('keeps head and tail of a 2,000,000-char stdout and saves the full output privately', () => {
    const store = new BashStreamSpillStore({ root, sessionId: 'sess/../1' });
    const call = store.beginCall();
    const stdout = 'HEAD-MARK' + 'a'.repeat(1_999_982) + 'TAIL-MARK';
    const text = renderBashStreamResult(0, capture('stdout', stdout, call), capture('stderr', '', call));
    call.end();

    expect(text.length).toBeLessThanOrEqual(BASH_STREAM_RESULT_MAX_CHARS);
    expect(text.startsWith('HEAD-MARK')).toBe(true);
    expect(text.endsWith('TAIL-MARK\n[exit 0]')).toBe(true);
    const omitted = Number(/… (\d+)자 생략 — 전체 출력: /.exec(text)?.[1]);
    const path = pathFrom(text)!;
    expect(path.startsWith(join(root, 'saycode-bash-stream', 'sess____1'))).toBe(true);
    expect(path.endsWith('.stdout.log')).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(stdout);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(spillDir(store)).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, 'saycode-bash-stream')).mode & 0o777).toBe(0o700);
    // head + tail + omitted == original length
    const [head, rest] = text.split(/\n… \d+자 생략 — [^\n]* …\n/);
    expect(head.length + omitted + rest.length - '\n[exit 0]'.length).toBe(stdout.length);
  });

  it('caps the whole result when both streams are large and fixes their split', () => {
    const store = new BashStreamSpillStore({ root, sessionId: 's' });
    const call = store.beginCall();
    const stdout = 'o'.repeat(100_000);
    const stderr = 'e'.repeat(25_000);
    const text = renderBashStreamResult(1, capture('stdout', stdout, call), capture('stderr', stderr, call));
    call.end();

    expect(text.length).toBeLessThanOrEqual(BASH_STREAM_RESULT_MAX_CHARS);
    const [outPart, errPart] = text.slice(0, -'\n[exit 1]'.length).split(STDERR_SEPARATOR);
    const budget = BASH_STREAM_RESULT_MAX_CHARS - STDERR_SEPARATOR.length - '\n[exit 1]'.length;
    const half = Math.floor(budget / 2);
    expect(outPart.length).toBeLessThanOrEqual(half);
    expect(errPart.length).toBeLessThanOrEqual(budget - half);
    expect(outPart.length).toBeGreaterThan(half - 300);
    expect(errPart.length).toBeGreaterThan(budget - half - 300);
    // The stderr stream stayed in memory during the run; it is saved at render time.
    const paths = [...text.matchAll(/전체 출력: (\S+) …/g)].map((m) => m[1]);
    expect(paths).toHaveLength(2);
    expect(readFileSync(paths[0], 'utf8')).toBe(stdout);
    expect(readFileSync(paths[1], 'utf8')).toBe(stderr);
  });

  it('keeps a short stream whole and leaves no file for it', () => {
    const store = new BashStreamSpillStore({ root, sessionId: 's' });
    const call = store.beginCall();
    const stderr = 'only warning\n';
    const text = renderBashStreamResult(0, capture('stdout', 'z'.repeat(50_000), call), capture('stderr', stderr, call));
    call.end();
    expect(text.endsWith(`${STDERR_SEPARATOR}${stderr}\n[exit 0]`)).toBe(true);
    expect(readdirSync(spillDir(store)).filter((name) => name.endsWith('.stderr.log'))).toEqual([]);
  });

  it('stops saving past the per-file cap and says the save is partial', () => {
    const store = new BashStreamSpillStore({ root, sessionId: 's', maxFileBytes: 40_000 });
    const call = store.beginCall();
    const stdout = '가'.repeat(50_000); // 3 bytes per char
    const text = renderBashStreamResult(0, capture('stdout', stdout, call, 7_001), capture('stderr', '', call));
    call.end();
    expect(text).toMatch(/… \d+자 생략 — 전체 출력\(일부만 저장\): \S+ …/);
    const saved = readFileSync(pathFrom(text)!, 'utf8');
    expect(saved.endsWith(SPILL_LIMIT_SENTENCE)).toBe(true);
    const body = saved.slice(0, -SPILL_LIMIT_SENTENCE.length - 1);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(40_000);
    expect(stdout.startsWith(body)).toBe(true);
  });

  it('keeps only the 20 most recent truncated calls in the session folder', () => {
    const store = new BashStreamSpillStore({ root, sessionId: 's' });
    const paths: string[] = [];
    for (let i = 0; i < 21; i += 1) {
      const call = store.beginCall();
      paths.push(pathFrom(renderBashStreamResult(0, capture('stdout', `${i}`.repeat(40_000), call), capture('stderr', '', call)))!);
      call.end();
    }
    expect(existsSync(paths[0])).toBe(false);
    expect(paths.slice(1).every((path) => existsSync(path))).toBe(true);
    expect(readdirSync(spillDir(store))).toHaveLength(20);
  });

  it('still omits the middle when the spill file cannot be written', () => {
    const blocker = join(root, 'not-a-dir');
    writeFileSync(blocker, '');
    const store = new BashStreamSpillStore({ root: blocker, sessionId: 's' });
    const call = store.beginCall();
    const stdout = 'HEAD' + 'b'.repeat(200_000) + 'TAIL';
    const text = renderBashStreamResult(7, capture('stdout', stdout, call), capture('stderr', 'e'.repeat(40_000), call));
    call.end();
    expect(text.length).toBeLessThanOrEqual(BASH_STREAM_RESULT_MAX_CHARS);
    expect(text.startsWith('HEAD')).toBe(true);
    expect(text).toMatch(/… \d+자 생략 — 전체 출력은 저장하지 못했어요 …/);
    expect(text).not.toContain(blocker);
    expect(text.endsWith('\n[exit 7]')).toBe(true);
  });

  it('removes the call files when the run is discarded', () => {
    const store = new BashStreamSpillStore({ root, sessionId: 's' });
    const call = store.beginCall();
    capture('stdout', 'q'.repeat(100_000), call);
    expect(readdirSync(spillDir(store))).toHaveLength(1);
    call.discard();
    expect(readdirSync(spillDir(store))).toEqual([]);
  });

  it('renders a 2,000,000-char single line quickly', () => {
    const store = new BashStreamSpillStore({ root, sessionId: 's' });
    const call = store.beginCall();
    const line = 'w'.repeat(2_000_000);
    const started = performance.now();
    const text = renderBashStreamResult(0, capture('stdout', line, call), capture('stderr', '', call));
    const elapsed = performance.now() - started;
    call.end();
    expect(text.length).toBeLessThanOrEqual(BASH_STREAM_RESULT_MAX_CHARS);
    expect(elapsed).toBeLessThan(200);
  });
});

describe('session spill store registry', () => {
  it('deletes the session folder on stop', () => {
    const store = bashStreamSpillStoreFor('stop-me', { root });
    const call = store.beginCall();
    renderBashStreamResult(0, capture('stdout', 'r'.repeat(40_000), call), capture('stderr', '', call));
    call.end();
    expect(existsSync(store.sessionDir)).toBe(true);
    removeBashStreamSpillStore('stop-me');
    expect(existsSync(store.sessionDir)).toBe(false);
    expect(bashStreamSpillStoreFor('stop-me', { root })).not.toBe(store);
    removeBashStreamSpillStore('stop-me');
  });
});
