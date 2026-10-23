/**
 * Codex CLI benchmarking B-R6 — bounded bash_stream tool-result output.
 *
 * The tool result (stdout + stderr separator + stderr + exit line) is capped
 * at BASH_STREAM_RESULT_MAX_CHARS. A stream over its share keeps its head and
 * tail and an omission line replaces the middle. The full output of every
 * truncated stream is kept in an owner-only spill file outside the project:
 *   <tmpdir>/saycode-bash-stream/<session>/<call>.<stdout|stderr>.log
 *
 * Memory stays bounded: a stream is held whole only while it is at most
 * BASH_STREAM_RESULT_MAX_CHARS long. Past that it keeps just its edges and
 * appends the rest to its spill file as it arrives. Spill failures never fail
 * the tool — the result still omits the middle and says the save failed.
 * Paths and output never reach the logs; only counts and error codes do.
 */

import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, fchmodSync, lstatSync, mkdirSync, openSync, readdirSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '@/ui/logger';

export const BASH_STREAM_RESULT_MAX_CHARS = 30_000;
export const BASH_STREAM_SPILL_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const BASH_STREAM_SPILL_KEEP_CALLS = 20;
export const SPILL_LIMIT_SENTENCE = '[이후 출력은 저장 한도 64MiB를 넘어 기록하지 않았어요]';

const SPILL_FOLDER = 'saycode-bash-stream';
const STDERR_SEPARATOR = '\n--- stderr ---\n';
// A truncated stream shows at most half of the result budget on each side,
// so this much of each edge is all a large stream needs to keep in memory.
const CAPTURE_EDGE_CHARS = BASH_STREAM_RESULT_MAX_CHARS / 2;

type StreamName = 'stdout' | 'stderr';
type SpillSave = { kind: 'saved' | 'partial'; path: string } | { kind: 'failed' };

export interface BashStreamSpillOptions {
  /** Parent of the spill folder; defaults to os.tmpdir(). */
  root?: string;
  sessionId: string;
  maxFileBytes?: number;
  keepCalls?: number;
}

/**
 * Allocation rule "fair share with spillover": when both streams fit the
 * budget they are untouched. Otherwise a stream no longer than half the budget
 * keeps all of it and the other stream gets the remainder; when both exceed
 * half they split the budget evenly (stderr takes the odd char).
 */
export function allocateStreamBudgets(stdoutChars: number, stderrChars: number, budget: number): [number, number] {
  if (stdoutChars + stderrChars <= budget) return [stdoutChars, stderrChars];
  const half = Math.floor(budget / 2);
  if (stdoutChars <= half) return [stdoutChars, budget - stdoutChars];
  if (stderrChars <= half) return [budget - stderrChars, stderrChars];
  return [half, budget - half];
}

/** Session-scoped spill folder: private modes, call retention and removal. */
export class BashStreamSpillStore {
  readonly sessionDir: string;
  private readonly baseDir: string;
  private readonly maxFileBytes: number;
  private readonly keepCalls: number;
  private readonly activeCalls = new Set<string>();
  private sequence = 0;

  constructor(options: BashStreamSpillOptions) {
    this.baseDir = join(options.root ?? tmpdir(), SPILL_FOLDER);
    const safeSession = String(options.sessionId ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128) || 'session';
    this.sessionDir = join(this.baseDir, safeSession);
    this.maxFileBytes = options.maxFileBytes ?? BASH_STREAM_SPILL_MAX_FILE_BYTES;
    this.keepCalls = options.keepCalls ?? BASH_STREAM_SPILL_KEEP_CALLS;
  }

  beginCall(): BashStreamSpillCall {
    // Fixed-width base36 time + sequence so names sort oldest first.
    this.sequence += 1;
    const id = `${Date.now().toString(36).padStart(9, '0')}-${this.sequence.toString(36).padStart(6, '0')}-${randomBytes(3).toString('hex')}`;
    this.activeCalls.add(id);
    return new BashStreamSpillCall(this, id);
  }

  /** Normal session stop: the spill folder goes with the session. */
  removeSessionDir(): void {
    try { rmSync(this.sessionDir, { recursive: true, force: true }); } catch (error) { logFailure('remove', error); }
  }

  /** @internal */
  openFile(callId: string, stream: StreamName): SpillFile | null {
    let fd: number | undefined;
    const path = join(this.sessionDir, `${callId}.${stream}.log`);
    try {
      ensurePrivateDir(this.baseDir);
      ensurePrivateDir(this.sessionDir);
      fd = openSync(path, 'wx', 0o600);
      fchmodSync(fd, 0o600);
    } catch (error) {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* already failing */ } }
      logFailure('open', error);
      return null;
    }
    this.prune();
    return new SpillFile(path, fd, this.maxFileBytes);
  }

  /** @internal */
  endCall(callId: string, discard: boolean): void {
    this.activeCalls.delete(callId);
    if (discard) this.removeCalls(new Set([callId]));
  }

  private prune(): void {
    try {
      const calls = [...new Set(readdirSync(this.sessionDir).map((name) => name.split('.')[0]))].sort().reverse();
      const expired = new Set(calls.slice(this.keepCalls).filter((id) => !this.activeCalls.has(id)));
      if (expired.size > 0) this.removeCalls(expired);
    } catch (error) {
      logFailure('prune', error);
    }
  }

  private removeCalls(ids: Set<string>): void {
    try {
      for (const name of readdirSync(this.sessionDir)) {
        if (ids.has(name.split('.')[0])) rmSync(join(this.sessionDir, name), { force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logFailure('remove', error);
    }
  }
}

/** One bash_stream invocation's slot in the session spill folder. */
export class BashStreamSpillCall {
  constructor(private readonly store: BashStreamSpillStore, private readonly id: string) {}

  open(stream: StreamName): SpillFile | null {
    return this.store.openFile(this.id, stream);
  }

  /** The result was rendered; its files stay for the agent to read. */
  end(): void {
    this.store.endCall(this.id, false);
  }

  /** The run failed before a result referenced the files. */
  discard(): void {
    this.store.endCall(this.id, true);
  }
}

class SpillFile {
  bytes = 0;
  capped = false;
  failed = false;
  private fd: number | null;

  constructor(readonly path: string, fd: number, private readonly maxBytes: number) {
    this.fd = fd;
  }

  write(chunk: string): void {
    if (this.fd === null) return;
    try {
      const size = Buffer.byteLength(chunk);
      if (this.bytes + size <= this.maxBytes) {
        writeSync(this.fd, chunk);
        this.bytes += size;
        return;
      }
      // Keep whole UTF-8 characters up to the cap, then note the cut.
      const encoded = Buffer.from(chunk);
      let cut = this.maxBytes - this.bytes;
      while (cut > 0 && (encoded[cut] & 0xc0) === 0x80) cut -= 1;
      if (cut > 0) writeSync(this.fd, encoded, 0, cut);
      this.bytes += cut;
      writeSync(this.fd, `\n${SPILL_LIMIT_SENTENCE}`);
      this.capped = true;
      logger.debug(`[bash_stream:spill] file cap reached bytes=${this.bytes}`);
      this.close();
    } catch (error) {
      logFailure('write', error);
      this.failed = true;
      this.close();
      try { rmSync(this.path, { force: true }); } catch { /* best effort */ }
    }
  }

  close(): void {
    if (this.fd === null) return;
    try { closeSync(this.fd); } catch (error) { logFailure('close', error); }
    this.fd = null;
  }
}

/** Bounded capture of one stream for the tool result. */
export class StreamCapture {
  private inline: string | null = '';
  private head = '';
  private tail = '';
  private total = 0;
  private file: SpillFile | null = null;
  private saveFailed = false;

  constructor(private readonly stream: StreamName, private readonly call?: BashStreamSpillCall) {}

  static fromText(stream: StreamName, text: string, call?: BashStreamSpillCall): StreamCapture {
    const capture = new StreamCapture(stream, call);
    capture.push(text);
    capture.finish();
    return capture;
  }

  /** Total chars seen, including any no longer held in memory. */
  get length(): number {
    return this.total;
  }

  /** The whole stream while it is held in memory; otherwise head and tail around an ellipsis line. */
  get text(): string {
    return this.inline ?? `${this.head}\n…\n${this.tail}`;
  }

  push(chunk: string): void {
    if (chunk.length === 0) return;
    this.total += chunk.length;
    if (this.inline !== null) {
      this.inline += chunk;
      if (this.inline.length <= BASH_STREAM_RESULT_MAX_CHARS) return;
      const whole = this.inline;
      this.inline = null;
      this.head = whole.slice(0, CAPTURE_EDGE_CHARS);
      this.tail = whole.slice(-CAPTURE_EDGE_CHARS);
      this.spill(whole);
      logger.debug(`[bash_stream:spill] stream=${this.stream} spilled chars=${whole.length}`);
      return;
    }
    this.tail = chunk.length >= CAPTURE_EDGE_CHARS
      ? chunk.slice(-CAPTURE_EDGE_CHARS)
      : (this.tail + chunk).slice(-CAPTURE_EDGE_CHARS);
    if (this.file && !this.file.failed) this.file.write(chunk);
  }

  /** Stream ended: close its spill file. */
  finish(): void {
    this.file?.close();
  }

  /** Ensures the full stream is on disk (a stream still in memory is written now). */
  save(): SpillSave {
    if (this.inline !== null && !this.file && !this.saveFailed) {
      this.spill(this.inline)?.close();
    }
    if (!this.file || this.file.failed) return { kind: 'failed' };
    return { kind: this.file.capped ? 'partial' : 'saved', path: this.file.path };
  }

  /** Up to `keep` chars split between head and tail, never splitting a surrogate pair. */
  excerpt(keep: number): { head: string; tail: string } {
    const headChars = Math.floor(keep / 2);
    const tailChars = keep - headChars;
    const headSource = this.inline ?? this.head;
    const tailSource = this.inline ?? this.tail;
    let head = headSource.slice(0, headChars);
    let tail = tailChars > 0 ? tailSource.slice(tailSource.length - tailChars) : '';
    if (isHighSurrogate(head.charCodeAt(head.length - 1))) head = head.slice(0, -1);
    if (isLowSurrogate(tail.charCodeAt(0))) tail = tail.slice(1);
    return { head, tail };
  }

  private spill(content: string): SpillFile | null {
    const file = this.call?.open(this.stream) ?? null;
    this.file = file;
    if (file) file.write(content);
    if (!file || file.failed) this.saveFailed = true;
    return file;
  }
}

/**
 * The bash_stream tool-result text. Identical to the unbounded formula when it
 * fits BASH_STREAM_RESULT_MAX_CHARS; otherwise the streams share the budget by
 * allocateStreamBudgets and an over-share stream keeps its head and tail.
 */
export function renderBashStreamResult(exitCode: number, stdout: StreamCapture, stderr: StreamCapture): string {
  const exitLine = `\n[exit ${exitCode}]`;
  const separator = stderr.length > 0 ? STDERR_SEPARATOR : '';
  const budget = BASH_STREAM_RESULT_MAX_CHARS - separator.length - exitLine.length;
  const [stdoutBudget, stderrBudget] = allocateStreamBudgets(stdout.length, stderr.length, budget);
  const stdoutText = renderStream(stdout, stdoutBudget);
  return stdoutText + (separator ? separator + renderStream(stderr, stderrBudget) : '') + exitLine;
}

function renderStream(capture: StreamCapture, budget: number): string {
  if (capture.length <= budget) return capture.text;
  const saved = capture.save();
  // Size the line for the largest possible count; the real count is never longer.
  const keep = Math.max(0, budget - omissionLine(capture.length, saved).length);
  const { head, tail } = capture.excerpt(keep);
  const omitted = capture.length - head.length - tail.length;
  logger.debug(`[bash_stream:spill] result truncated total=${capture.length} omitted=${omitted} save=${saved.kind}`);
  return head + omissionLine(omitted, saved) + tail;
}

function omissionLine(omitted: number, saved: SpillSave): string {
  if (saved.kind === 'failed') return `\n… ${omitted}자 생략 — 전체 출력은 저장하지 못했어요 …\n`;
  const label = saved.kind === 'partial' ? '전체 출력(일부만 저장)' : '전체 출력';
  return `\n… ${omitted}자 생략 — ${label}: ${saved.path} …\n`;
}

function ensurePrivateDir(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  // A shared tmp root could hold a planted folder or link; only our own directory will do.
  const info = lstatSync(path);
  if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid())) {
    throw Object.assign(new Error('spill directory is not private'), { code: 'ENOTPRIVATE' });
  }
  chmodSync(path, 0o700);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function logFailure(step: string, error: unknown): void {
  logger.debug(`[bash_stream:spill] ${step} failed code=${(error as NodeJS.ErrnoException)?.code ?? 'unknown'}`);
}

const sessionStores = new Map<string, BashStreamSpillStore>();

/** The session process's spill store (created lazily; no folder until a stream spills). */
export function bashStreamSpillStoreFor(sessionId: string, options: Omit<BashStreamSpillOptions, 'sessionId'> = {}): BashStreamSpillStore {
  let store = sessionStores.get(sessionId);
  if (!store) {
    store = new BashStreamSpillStore({ ...options, sessionId });
    sessionStores.set(sessionId, store);
  }
  return store;
}

/** Normal session-process stop: delete the session's spill folder. */
export function removeBashStreamSpillStore(sessionId: string): void {
  if (!sessionId) return;
  (sessionStores.get(sessionId) ?? new BashStreamSpillStore({ sessionId })).removeSessionDir();
  sessionStores.delete(sessionId);
}
