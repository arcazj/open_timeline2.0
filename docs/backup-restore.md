# Complete Root Backup and Restore

These operations preserve the complete JSON root, including deleted records,
published configuration/schema/model versions, settings, command outcomes, identity
metadata and audit/recovery history. A timeline JSON export is **not** a root
backup. A backup is a private directory of ordinary JSON files plus a checksummed
inventory. No database, broker, ZIP extraction, CDN or network service is needed.

## Offline Commands

Stop the service first. Use an existing valid data root and a new destination
whose parent already exists. These commands never overwrite an existing directory
or delete source JSON:

```powershell
.venv/Scripts/python scripts/backup-root.py create --data-root C:/data/timeline --destination C:/backups/timeline-2026-09-13
.venv/Scripts/python scripts/backup-root.py verify --backup C:/backups/timeline-2026-09-13
.venv/Scripts/python scripts/restore-root.py --backup C:/backups/timeline-2026-09-13 --destination C:/data/timeline-restored --reason "Verified recovery drill"
```

The create command acquires identity ownership before workspace ownership. An
active source is refused. A pending transaction is refused, not repaired or
discarded: restart/recover with the ordinary owner, stop it, then retry with a new
backup destination. Missing identity/workspace state is never bootstrapped by a
backup command. Verification checks every raw file hash, file count, byte count,
schema, relationship, catalog pin, outcome identity and audit-chain link.

A successful restore reports `activated: false` and `credentialsRequired: true`.
It preserves record IDs, versions, tombstones, principal IDs, ownership and existing
history. It assigns fresh workspace and identity generations, advances their
revisions, appends explicit restore provenance and a workspace audit transition,
and revokes **every old token**. No bearer secret is printed or written by backup
or restore. The archive and original source JSON remain unchanged.

Before exposing the restored service, keep it stopped and issue fresh access:

```powershell
.venv/Scripts/python scripts/recover-identity.py --data-root C:/data/timeline-restored --reason "Fresh access after validated restoration"
```

That separate local recovery command prints one new bearer credential once. Keep
it private. Explicitly switch the service's configured root only after establishing
fresh access. Never activate both original and restored roots as independent
writers. Environment changes do not re-open bootstrap or revive old credentials.
See [Identity Administration](identity.md).

## Live Service Primitive

`server.app.services.backup.create_live_backup(repository, identities, identity,
configured_destination, progress=..., cancelled=...)` rechecks the current
administrator and holds the identity mutex before the repository mutex throughout
capture and verification. Concurrent mutations wait; the archive represents one
committed workspace revision and one consistent identity revision. Disk documents
are compared to the owner's admitted state. Malformed/unexpected external changes
freeze workspace writes and reject the archive.
Authorization is checked again immediately before manifest publication, including
token expiry during a long capture.

The destination must come from operator-controlled configuration, not an arbitrary
HTTP path. This primitive is synchronous and accepts progress/cancellation callbacks
for a tracked-job wrapper. It does not itself implement the job API. The callback
reports `phase`, `completedFiles` and `totalFiles`; semantic validation is a complete
phase, not fake per-record progress. Cancellation is checked between bounded file
operations and phase boundaries, not during a single full validation call. The
outer scheduler must admit its working memory and run at most one backup/restore
preparation globally. Read-barrier latency and 100k peak RSS remain to be measured
before certifying a reference-tier performance gate.

## Integrity and Recovery

The manifest names only registered relative paths, with exact raw SHA-256 hashes
and byte sizes. Absolute/traversal paths, alternate separators, links/reparse
points, special files, unknown members, duplicates, missing files, wrong hashes,
unsupported JSON, broken schema references and altered audit history are rejected.
The manifest is not a signature: someone able to replace the complete backup can
replace its checksums too. Treat backup origin and storage permissions as part of
the trust boundary.

Limits: 250,000 files, 4 GiB complete JSON, 32 MiB manifests/metadata/outcomes/identity
documents, 1 MiB raw individual records and audit documents, and 4 MiB shards/layouts.
Canonical records still have their stricter 256 KiB limit. Free-space admission
includes a 32 MiB reserve. Metadata introduced by restoration is included in final
file/byte admission. These are explicit rejection limits, not truncation rules or
memory guarantees.

Every backup permanently retains `migration-incomplete.json` with a `backup-archive`
marker so the normal application cannot accidentally start that directory. During
restore, the new root's writer lock and a durable staging marker prevent activation.
Only complete successful validation removes the marker. Failed/cancelled operations
retain incomplete destinations for inspection and never silently clean up evidence.
Use a different new destination for a retry. Do not manually remove a staging marker
to bypass failed validation.

Original outcome files remain historical and command keys stay reserved. Current
workspace outcome lookup rejects a stored old-generation result; old edits and
query handles cannot become valid merely because IDs were restored. The provenance
file and complete audit chain are checked again on ordinary startup. Configuration
and identity history are not compacted or selectively dropped by these operations.

## Retention and Security

The default is retain all verified backups. There is no automatic pruning, expiry,
compaction or overwrite. New work fails on capacity exhaustion while previous
backups remain intact. Establish an operator retention schedule only after successful
restore drills and verified independent copies. External secrets, certificates,
environment variables and deployment settings are excluded; re-establish them
separately without reinstating old bearer credentials.

Backup data is plaintext JSON containing private records and credential hashes.
Keep roots and archives outside static hosting, restrict filesystem permissions,
and use encrypted volumes or separately protected storage/transport where required.
The tested process is local filesystem operation; network-share locking/durability,
OS access-control policies and hardware power-loss behavior are not certified by
the automated process-exit tests.

## Verification

The focused command exercises real JSON directories, actual CLI subprocesses,
concurrent mutation barriers, identity revocation/recovery, file/hash/schema/path
failures, repeated backup/restore and shard migration, source preservation and
process termination before and after publication:

```powershell
.venv/Scripts/python -m pytest tests/server/test_backup.py tests/server/test_storage_shards.py tests/server/test_identity.py tests/server/test_identity_hardening.py -q
```

The combined command passed **120 tests in 60.40 seconds**, including the normal
startup provenance hook, its malformed/checksum/workspace/capacity regressions and
six real process-exit phases. The final backup-only rerun passed **49 tests in
52.00 seconds**, including publication-time token expiry. These overlapping runs
are not additive test counts. Scoped Ruff checks passed. Two warnings originate in the current upstream
Starlette/AnyIO test-client integration. This targeted package evidence is not the
entire release suite, an HTTP job/API verification, or a power-loss certification.
