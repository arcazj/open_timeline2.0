# JSON Transaction Protocol V2

Status: v2 journal and explicit layout-v2 migration implemented; qualification
remains bounded by the test and measurement evidence below.

## Context

The original single-slot v1 journal recorded COMMITTED before installing targets,
then redid the after-images on recovery. That can support redo recovery, but is not
the before/after protocol required by REQ-12. V2 changes the durable decision point;
old journals retain their original interpretation. No database or second data
authority is introduced.

Normal 100,000-record startup with complete validation measured 107.667 seconds
on the development Windows workstation. File loading accounted for 99.145 seconds;
complete snapshot validation took 8.522 seconds, including 0.506 seconds in the
compiled schema validator. This is one profiled observation, not a percentile or
a passed readiness gate. See the [raw report](../performance-results-100000-startup-compiled.json).

## V2 Envelope and State Machine

One exclusive OS owner and one repository mutation mutex protect a single
`transaction.json` slot. Every transaction includes `workspace.json`; its complete
before/after manifest identifies workspace, generation and consecutive revision.
Initial installation has an absent before-image instead. Record IDs and outcome
filenames remain server-generated. Paths are allowlisted and checked before any
recovery write; symlinks/reparse points are rejected.

Each `before` and `after` entry contains `exists`, `document` and `sha256`.
An absent image is exactly `{exists:false,document:null,sha256:null}`; it never
means a JSON document whose value happens to be null. Existing images must be JSON
objects. Hashes use UTF-8, sorted-key, compact JSON as emitted by the repository's
`json_bytes`, with no nonfinite numbers or unsafe integers. This internal storage
encoding is distinct from the RFC 8785 checksum used by portable snapshot exports.
`checksum` covers the complete envelope except that field, including its state.
The complete encoded envelope is limited to 32 MiB before preparation. A mutation
that would exceed this limit is rejected without installing anything; large seed
or import installation needs a separately bounded import workflow, not an exempt
journal. No public API can disable checksums or size checks.

1. Validate the complete candidate in the caller. Resolve all target paths and
   compare current target documents with the repository's committed in-memory
   before-state. An unexpected semantic edit, missing expected file, malformed
   file, or unexpected existing create target freezes writes instead of overwriting
   it. Formatting-only changes do not change document identity.
2. Capture complete before/after images and checksums. Atomically write and flush
   PREPARED before touching any authoritative target. Same-directory temporary
   replacements use file fsync, atomic replace, and directory fsync where supported.
3. Install every after-image. Only after all installs succeed, atomically write
   and flush COMMITTED with the updated envelope checksum.
4. The caller publishes its new immutable in-memory revision and returns success.
   Journal cleanup is nonessential after a known successful commit. If cleanup
   fails, retain COMMITTED and reconcile it before the next mutation; do not turn
   an established success into an unknown outcome.

An I/O failure before the durable decision freezes repository access until restart
and returns the existing unknown-outcome response. An exception during marker
replacement can be ambiguous: restart reads the actual durable marker, never the
client's response. Authentication and original idempotency identity still govern
outcome lookup and explicit retry. A rolled-back operation has no committed outcome.

## Recovery

Before serving reads, bound and strictly parse the whole journal, verify its shape,
all paths, image/envelope checksums and revision relationship, then preflight every
current target. Existing targets must equal a checksummed before- or after-image;
missing targets can be reconstructed. A conflicting or newer target fails closed
and preserves evidence. Preflight finishes before any recovery install, so a later
bad path or conflict cannot cause a partial overwrite.

PREPARED v2 restores every before-image, including removing targets that did not
exist before preparation. COMMITTED v2 restores every after-image. Recovery itself
can be interrupted; repeating it must produce the same complete state. Only after
all targets are reconciled is the journal removed. Empty record/outcome directories
left by a rolled-back first initialization can be removed so a genuinely empty
root can initialize again.

V1 journals with absent or explicit `formatVersion:1` retain old semantics:
PREPARED has not installed targets and is discarded; COMMITTED redoes after-images.
All legacy paths are preflighted before writes. Legacy journals have no before-image
or checksum proof, so v2's stronger conflict checks cannot be retroactively claimed.
Unknown versions and malformed journals are not guessed or automatically repaired.

## File Admission and Evidence Boundary

Individual authoritative record files are admitted at at most 1 MiB of raw bytes,
allowing whitespace around the canonical record whose encoded limit remains
256 KiB. Reads use an open descriptor, bounded allocation and before/after file
metadata checks; replacement, growth or modification during the read is rejected.
Up to 32 readers and 256 queued files preserve deterministic filename-order error
reporting. Failure cancels pending reads and drains active readers before releasing
the owner lock. There is no partial startup readiness or cached validation shortcut.

Process termination and injected I/O tests establish only the exercised process
recovery behavior. Windows directory flush limitations, sudden hardware power loss,
hostile administrators racing filesystem operations, and storage-controller behavior
are not certified by those tests. Retained historical audit/checkpoint chains and
backup/restore remain separate release obligations; this bounded change does not
claim that deleting a completed single-slot journal implements those facilities.

## Authoritative Shards

The reviewed layout is now implemented as an explicit inactive-root migration.
It replaces separately opened record files with ordinary authoritative JSON shards,
not a cache beside another record store. Migration validates every old record,
stages versioned shards and a checksummed manifest, validates the complete staged
snapshot and only then permits an offline root switch. Old and new roots must not
both accept writes. Existing roots are never implicitly migrated on startup.

Layout: deterministic UUID-prefix buckets, UTF-8 JSON objects containing
records in canonical ID order; split over-capacity buckets by the next UUID hex
digit, using deterministic non-overlapping prefix coverage. Each shard is capped
at 4 MiB and its complete before/after transaction envelope remains capped at
32 MiB. Date changes never change the bucket. Splits update shard files plus the
manifest atomically through the reviewed v2 protocol; merging can be deferred.

Every startup reads and strictly validates every authoritative shard, its
membership/count/checksum, every record, and all cross-record relationships before
readiness. Indexes are disposable and cannot hide external shard edits. Benchmark
file count, ordinary update/split latency, memory and recovery cost before choosing
bucket sizes. Review migration rollback, path checks, manifest versioning and the
complete crash matrix before declaring the layout release-qualified.

The exact authority is `storage-layout.json` (`format:timeline-record-layout`,
`formatVersion:2`) plus its listed `shards/{prefix}.json` files. The manifest pins
workspace/generation/revision, complete count, ordered non-overlapping prefixes and
per-shard SHA-256, plus its own checksum. Shards declare their prefix and sorted
canonical records. Unexpected/missing shards, a legacy `records/` directory beside
shards, checksum changes and incompatible manifest versions all fail startup.
Every record write changes the affected shard(s), layout manifest, workspace and
outcome through v2; model-only writes update layout/workspace revisions together.
Date changes never move records between UUID-prefix buckets. Empty buckets can be
removed; live sibling merging is not implemented.

Operator command, with the service stopped:

```powershell
.venv/Scripts/python scripts/migrate-storage.py --source C:/data/timeline-old --destination C:/data/timeline-new
```

The destination must not exist and must not contain or be contained by the source.
Source roots needing transaction recovery are refused rather than modified by the
migrator. Existing outcome documents and validated identity/control JSON are copied;
unknown authority is rejected rather than silently omitted. Identity ownership is
acquired before workspace ownership. `migration-incomplete.json` blocks startup
until all staged files have been reread and validated. Failure retains that marked
destination for inspection, never deletes the source, and never activates either
root. Successful output requests an explicit service data-root switch.

Focused evidence includes 51 journal tests with one platform-permission symlink
skip and 15 initial shard/migration tests. Journal coverage includes real subprocess
exits, injected preparation/install/marker/cleanup failures, two restarts, missing
targets, conflict/checksum/path rejection, legacy recovery and bounded reads. Shard
coverage includes deterministic splitting, unchanged date membership, complete
source/control/outcome preservation, staged failure, concurrent-owner rejection,
record/model mutations, split rollback/redo and malformed/incomplete authority.
These are not hardware power-loss tests or controlled scale percentiles.

The [normal 100,000-record layout2 measurement](../performance-results-100000-startup-shards.json)
completed in 16.369 seconds with 25 authoritative shards and two manifests, complete
startup validation and a 331,968,512-byte peak RSS. The temporary fixture was removed.
This is one startup observation below the target, not controlled cold/warm gate
certification or evidence for full-range query/live-update performance.
