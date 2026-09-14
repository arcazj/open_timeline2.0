# ADR 0006: Workspace Integrity Monitoring

Status: implemented; targeted regression and diagnostic evidence is recorded below.
The complete release performance and cross-platform qualification gates remain open.

## Gap Addressed

`JsonRepository._commit_files` compares the current before-images of transaction
targets with their admitted state. Startup validates records, shard/layout hashes,
the complete audit chain and restore provenance. Those checks alone do not continuously
cover untouched records, missing shards, newly introduced JSON, or existing outcomes
that no request happens to read. Identity storage already has its separate bounded
single-file monitor. Job/control state belongs to its own owner and must not be
classified as a workspace write.

## Monitoring Authority

Use deterministic incremental polling as the correctness mechanism, not a lossy
event stream. An in-memory registry retains path, expected raw SHA-256 and file
identity/size/timestamps for every admitted workspace JSON authority: workspace,
record files or shards/layout, outcomes, audit state/entries and restore provenance.
This is disposable derived state, never a second database or startup validation
shortcut. Collect hashes from the same bounded reads that validate startup where
possible; do not reparse/deep-copy the full dataset merely to initialize monitoring.
All existing outcome files receive bounded strict validation before readiness rather
than a baseline accepted from unchecked bytes. Read-only outcome retrieval checks
the admitted raw receipt before exposing its payload, including missing-file cases.

Poll small round-robin batches, initially at most 128 files or 4 MiB before a
100 ms cooperative pause, with directory enumeration advanced by at most 128 entries
per slice. At most five directory iterators round-robin independently, so a large
records directory does not prevent the root directory from getting a turn.
A single file may exceed the slice byte budget only within its existing hard
per-file admission bound; no partial hash may be treated as a complete check.
Record observed sweep duration and checked-file/byte counts. Do not claim a fixed
detection latency until the 100k legacy and shard layouts are measured. There is
no one-second full-tree scan or unlimited queued work. Every admitted file is
eventually hashed even when its size and timestamps are unchanged.

Registered directory paths and root ancestry are checked for replacement,
deletion, symlinks and Windows reparse points. Enumeration never follows an
unregistered directory. New unknown authoritative JSON, missing expected files,
raw-byte changes, malformed paths, read failures or invalid storage layout freeze
workspace availability with a diagnostic code and relative path, not record
payloads. No automatic disk reload, repair or overwrite follows detection. A new
ordinary startup/recovery is required to establish readiness again.

## Own Writes and Concurrency

The existing repository mutex remains the synchronization authority. A monitor
captures a path's expected-state token under that mutex, performs its bounded read
without holding the mutex, then compares only if the token remains current. A
known commit that changed that path invalidates the observation and schedules a
fresh check; it is not external drift. A before/after mismatch with an unchanged
token freezes access. This avoids misclassifying ordinary atomic replacement,
new audit/outcome files, shard splits/deletions and delayed directory enumeration.

Before PREPARED, admission reserves expected-registry space for the complete
physical target set. After the known commit marker, expected hashes advance from
the already validated committed document images, never from whatever bytes an
outside writer substituted. Update membership and tokens before releasing the
repository mutex. Known transaction-journal/temporary-file activity is handled
as owner work; arbitrary `*.json` is not globally excluded. A failed unknown commit
already freezes the repository and remains the normal recovery path.

Windows testing showed that a normal Python read handle can deny deletion, while
even a delete-sharing read handle can prevent `os.replace` from replacing an open
destination. The monitor therefore opens Windows observations with read/write/delete
sharing and uses a separate observation I/O lock. A commit acquires the repository
mutex before this I/O lock; an observation acquires only the I/O lock for its bounded
read, releases it, then reacquires the repository mutex to compare its token. This
drains the observation handle before atomic installation without reversing lock
order. A write can wait for one bounded file read, up to the admitted 32 MiB maximum;
its latency on a slow filesystem must be measured, not claimed to be zero.
[Microsoft CreateFile sharing rules](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew),
[CPython discussion of MoveFileEx replacement](https://github.com/python/cpython/issues/90161).

On POSIX, observations use no-follow and nonblocking open flags, then validate the
descriptor as a regular file before reading. Root ancestry and directory identities
are checked as well. The writer lock path is validated before acquisition and again
against the opened descriptor. Temporary files have no broad filename exemption:
owner writes hold the mutex while their temporary files exist. Unrecognized leftover
temporary files prevent readiness and require explicit inspection; they are never
silently removed or admitted as workspace state.

The monitor has no lossy change queue. Its finite registry and scan iterators are
the backlog; capacity exhaustion refuses new writes before PREPARED. Registry
admission uses a 128 MiB estimate: 512 base bytes plus 1024 bytes and four times the
UTF-8 path length per authority. It reserves the possible retained transaction journal
before PREPARED and releases that accounting after cleanup. This is a conservative
Python-object estimate, not an operating-system RSS bound; actual process RSS must
be measured separately. A future optional notification accelerator must use a bounded
queue, treat queue/backend overflow or watcher death as loss of integrity coverage,
and fail closed. It must not replace complete rolling checks.

Shutdown sets cancellation, stops admitting scans, drains any active reads, fully
joins monitor workers, waits for an already-active commit to leave the repository
mutex, and only then releases the workspace process lock. Never join a
thread that is blocked indefinitely acquiring a mutex held by the closing caller.
All scan waits happen outside the repository mutex. An unexpected monitor-thread
exit freezes readiness rather than silently disabling coverage.

## Why Not a Watcher Alone

Maintained filesystem watchers are useful notification accelerators, but their
public behavior must match a fail-closed integrity promise. The reviewed
Watchfiles 1.2.0 adapter accumulates path events in an internal HashSet and handles
only path-bearing events; it does not expose Notify rescan flags through its Python
change tuples. Its public API documents native-to-polling fallback, not bounded
integrity-event retention. This is insufficient as the sole proof that no changes
were missed. [Watchfiles source](https://raw.githubusercontent.com/samuelcolvin/watchfiles/v1.2.0/src/lib.rs),
[Watch API](https://watchfiles.helpmanual.io/api/watch/).

Watchdog documents platform-specific rename/directory caveats. Its reviewed current
Linux implementation filters events whose watch descriptor is -1; an overflow
signal therefore cannot simply be assumed to reach an ordinary event handler.
These are integration constraints, not claims that either library is defective
for its intended development/file-notification use.
[Watchdog platform caveats](https://python-watchdog.readthedocs.io/en/latest/installation.html),
[Linux adapter source](https://raw.githubusercontent.com/gorakhargosh/watchdog/master/src/watchdog/observers/inotify_c.py).

## Required Qualification Evidence

Tests must edit/delete untouched records, shards, metadata, audit, outcomes and
provenance; introduce unknown JSON and links; preserve mtime/size while changing
bytes; interrupt reads and shutdown; and inject thread/capacity failures. Concurrent
ordinary CRUD, batches, audit append and shard splits must not freeze healthy roots.
Measure complete sweep duration, idle CPU, per-read lock interference, write latency
and added peak RSS on both 100k layouts, with safe temporary fixtures and bounded
phase timeouts. Report any long legacy-file detection window honestly. Polling
detects divergence from the running owner's admitted bytes; it is not a forensic
signature against a privileged actor who can rewrite an entire stopped root.

## Diagnostic Evidence

The six focused storage modules passed 134 tests in 91.73 seconds on Windows.
The later immutable-query-capture and commit-draining additions have separate focused
regression evidence; neither changes this historical six-module count. The regression
set includes read-only outcome validation, untouched authority edits/deletions,
equal-size hash changes, bounded directory enumeration, own-write receipt races,
Windows open-handle draining, shard splitting, retained journal accounting, and
joined shutdown while a monitor read is active. See `tests/server/test_integrity_monitor.py`
and the repository, storage-shards, backup, audit, and record-batch test modules.

`scripts/benchmark-integrity.py` created and removed an isolated 100,000-record,
25-shard fixture with 27 authority files. One Windows 11 / Python 3.12.14 sample
observed normal startup at 16.025 seconds, an initial integrity sweep at 1.625 seconds,
and detection of an injected last-shard byte edit at 1.556 seconds. The estimated
registry was 32,392 bytes; complete process RSS after the sweep was 544,493,568 bytes.
The monitor joined and temporary fixture cleanup completed. Exact code hashes and
measurements are in `artifacts/performance/integrity-shards-100k.json`. Later repository
read-error, query-capture, and shutdown edits make this historical code-bound evidence,
not a measurement of the final release candidate.

This sample is not the normative 100-group/nested fixture, a cold-start percentile,
an isolated incremental RSS measurement, or a guarantee for the individual-record
layout. Its sweep counter is diagnostic for a quiescent authority set; concurrent
membership changes and skipped busy reads prevent interpreting it as a fixed
per-file detection bound. Legacy-file sweep latency, idle CPU, write interference,
and repeated Windows/Linux measurements remain release qualification work.
