# Bounded project file discovery (v1)

`file-discovery` is an additive machine/session common RPC. Existing `ripgrep`,
`readFile`, directory browsing and download handlers are unchanged. The Desktop
consumer is tracked in `desktop-file-discovery` in the Desktop repository.

Requests carry `version: 1` and `operation: capabilities | search | stat | read`.
All responses carry `version: 1` and `success`. Errors are codes, never raw paths
or file contents. Unsupported platforms fail closed; v1 supports macOS only.

- `capabilities`: returns `supported: true` only after opening the trusted machine
  base with Darwin `O_NOFOLLOW_ANY`. Other operations also enforce this flag.
- `search`: `{ root, query }`, literal UTF-8 substring search (no shell or flags).
  Query: nonblank, no NUL, at most 4 KiB. Returned matches: `{ path, line, text }`,
  root-relative path and 1-based line. `partial` and `reason` distinguish limits.
- `stat`: `{ root, path }`, returns regular-file `size` and `identity` without contents.
- `read`: `{ root, path, offset, length, identity? }`, returns base64 `content`,
  `size`, `offset`, `identity`, `eof`. Length is 1..262144 bytes; total file limit
  is 25 MiB. Subsequent chunks send the first identity, which binds inode, size,
  mtime and ctime; changed files are rejected, including mutations during a read.

Only the trusted daemon base is realpathed. Untrusted roots must remain inside
its lexical boundary, and each actual file open atomically rejects symlinks in
all path components. Reads use that checked descriptor, not a later path read.
Directory enumeration is bracketed by descriptor identity checks; changed
listings are discarded and every file is independently opened with the same
kernel restriction before reading. The initial root check alone is not trusted
for subsequent operations.

Search limits: 200 matching lines, 1 MiB/file, 2 KiB/context, response below
512 KiB, depth 64, 10000 visited entries. Hidden paths, `.gitignore` matches,
node_modules/dist/out/build/coverage and non-UTF-8/binary files are omitted.
Files over 1 MiB are skipped with partial `file-limit`; eligible siblings are still searched.
An inaccessible file or directory is skipped and marks the response partial; siblings continue.
An unreadable or oversized .gitignore skips that subtree so ignored files cannot leak into results.

Each request runs in a disposable Node child with a 32 MiB V8 heap. At most two
operations run concurrently per hosting daemon/session process. The parent requests SIGKILL at 5 seconds and waits for child exit before releasing the slot. Search
can retain bounded progress; a read/stat timeout is an error. No caller code,
arguments or program path is executed. The script is shipped by the existing
`scripts` publish inclusion and uses the existing `ignore` dependency.

Verification: `src/modules/common/fileDiscovery.test.ts` exercises real files,
symlinks, exclusions, literal queries, result bounds and chunk identity.
`fileDiscoveryLifecycle.test.ts` verifies timeout kill/reap and concurrency at
the child-process boundary. Build and publish-artifact guard are still required
before a release. This document does not assert that a release has occurred.
