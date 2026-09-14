# ADR 0004: Complete JSON Root Backup and Inactive Restore

Status: implemented; focused verification evidence is recorded in
[`../backup-restore.md`](../backup-restore.md). This is not full-release or
power-loss certification.

## Scope and Authority

A backup is an ordinary directory of JSON documents, not a query export, filtered
snapshot, database, or second live root. Format `openbexi-root-backup`, version 1,
contains the original `workspace.json`, every authoritative record file or shard
and layout manifest, every outcome, `control/identities.json`, optional
`audit-state.json` and every `audit/{revision:016d}.json`, and any existing
`restore-provenance.json`. Workspace metadata includes every configuration catalog,
setting and schema. Identity metadata includes principals, token hashes, commands,
audit and recovery history. Deleted records remain present. External environment
variables, TLS keys, plaintext credentials, executable assets, lock files and
previous backup directories are not application JSON authority and are not copied.
Archives must be kept outside the active root; in-root backup directories are not
recursively skipped under the guise of a complete inventory.
Unknown files/directories are rejected, not silently omitted. Additional authority
families must register a validator and inventory rule before deployment.

`backup-manifest.json` records a canonical UUID, timestamp, creator, capture mode,
workspace and identity generations/revisions/counts, layout version, sorted unique
relative paths, exact raw byte sizes, SHA-256 hashes, aggregate file/byte counts,
and a checksum over its other fields using the repository's deterministic JSON
encoding. Raw file hashes include whitespace. The manifest is integrity evidence,
not a cryptographic signature against a privileged attacker. The manifest is
published last, only after a complete semantic re-read of the copied root.

Every archive permanently retains `migration-incomplete.json` with an explicit
`backup-archive` marker. Ordinary repository startup consequently refuses to run
an archive as a workspace. A failed capture retains an incomplete marker and does
not publish a complete manifest. A separate exclusive `.backup.lock` coordinates
verification and restoration; it is not backed-up authority.

## Consistency and Limits

Live capture requires a current administrator, revalidated after obtaining the
identity mutex and then the workspace mutex. Both are held through source
validation, copying, destination validation and manifest publication. This is a
deliberately simple read barrier: writes can wait during large backups. The
primitive accepts progress and cancellation callbacks for an outer tracked job;
it does not claim that synchronous invocation itself implements the job API.
Only existing owner instances may be used. Source JSON is compared against their
admitted in-memory state. Identity bytes receive their normal full drift check.
Pending recovery journals are refused, including known-committed cleanup remnants;
the ordinary owner must reconcile them before a new backup attempt.
The initiating token is checked again immediately before publishing the manifest,
so expiry during preparation cannot produce an authorized completed backup.

The new destination's writer lock stays held from staging-marker creation through
publication; a competing ordinary owner cannot become ready during the operation.
The offline CLI acquires the identity process lock before the workspace process
lock. It never seeds or repairs a source and refuses a pending journal. It does
not need a network credential because access to the inactive root is the explicit
local administrative boundary. No network endpoint may accept arbitrary paths.

Initial limits are 250,000 authority files, 4 GiB aggregate raw JSON, a 32 MiB
manifest, 32 MiB metadata/outcome/identity files, 1 MiB raw individual record files,
and 4 MiB shards/layout manifests. Audit state and individual audit entries are
bounded to 1 MiB. Existing stricter canonical record/schema and
identity limits still apply. Every read checks regular-file identity, reparse/link
status, initial/final length and timestamps, and reads at most the admitted bound
plus one byte. Paths are allowlisted relative POSIX paths; traversal, absolute
paths, alternate separators, streams, unexpected members and nested directories
are rejected. Destination roots must not exist and cannot nest in either source.
Free-space admission includes the declared payload plus a 32 MiB reserve. These
limits bound work and extraction; they are not a measured latency guarantee.
Complete semantic validation materializes a full record dictionary. An outer job
scheduler must admit this additional working memory and limit backup/restore
preparations globally; byte caps are not an RSS guarantee. Source and destination
hashes are rechecked after semantic validation. No partial successful archive is
substituted when capacity or validation fails.

## Restore Protocol

Restore accepts only a complete verified archive and creates a separate new,
inactive destination. It never overwrites a directory, deletes a source, repairs
an active root or switches running configuration. A staging marker is durable
before any root JSON is installed. Every archive member is checked against its
declared path/size/hash; extra or missing files fail the entire operation. The
staged image then passes ordinary full snapshot, relationship, schema, catalog,
layout, outcome and identity validation.

Restore preserves all record IDs, versions, payloads, tombstones, catalog IDs and
published versions. Workspace revision advances once, workspace generation and
bundle ID become fresh UUIDs, and snapshot time is updated. A shard layout gets
the same new workspace generation/revision and a recomputed checksum; shard
records remain byte-for-byte unchanged. Required capacity failures abort before
the destination can become ready.

Identity generation advances to a fresh UUID. Every previously unrevoked token
is revoked and its revision advanced. No usable token is generated, no old token
is revived, and principal IDs/grants remain unchanged. Existing format-1 roots
are projected to format 2 only in the destination. One `identity.recover` audit
entry and matching recovery-history entry explicitly name the backup UUID and
restoration reason. This is the existing format-2 generation-recovery mechanism,
not a fabricated principal login or new secret. A separate checksummed
`restore-provenance.json` records the complete restore chain, source backup hash,
prior/new generations and revisions, time and operator reason.

Historical outcome files and original identity outcomes remain unchanged. An
outcome from a previous workspace generation is not exposed as a current success;
the API returns `generation_conflict`. Existing command keys remain reserved and
cannot be reused to overwrite historical outcomes. Identity outcome lookup is
already current-generation scoped. Old query handles and old-generation writes
must fail. No compaction or history deletion is part of restoration.

The workspace audit uses ADR 0005's `prepare_restore_audit`: retain every old
entry byte-for-byte and append one new-generation `workspace.restore` entry linking
the prior terminal hash, source generation and verified backup checksum. A legacy
root with no audit chain starts an explicitly bounded history at this restoration;
no earlier events are invented. Both archive verification and ordinary restored
startup validate the complete audit chain and restore-provenance checksum, sequence
and workspace generation. An independent later identity recovery may advance
identity generation without changing the workspace restore-provenance entry.

After transformed destination re-validation, the staging marker is removed and
the directory synchronized. Success reports `activated: false` and
`credentialsRequired: true`. The operator keeps both services stopped, runs the
documented inactive-root identity recovery CLI to issue a fresh credential, then
explicitly changes the service root. Never expose the restored root to the network
before establishing fresh access. A crash/failure before marker removal leaves an
unstartable destination for inspection; a crash after removal leaves the validated
new root. Neither stage modifies archive or source JSON.

## Retention and Guarantees

Initial retention is **retain all verified backups**. There is no automatic prune,
history compaction, expiry or silent replacement. Capacity exhaustion rejects new
work and keeps previous backups. Operators may move verified copies to separately
encrypted storage and remove old copies under their own documented retention
policy only after a successful restore drill. External secret configuration must
be re-established separately; old bearer credentials must never be reinstated.

Backups are confidential plaintext JSON containing records and credential hashes.
Keep them outside static hosting, use restrictive OS permissions, and use encrypted
volumes or separately encrypted transport/storage where required. Checksums detect
accidental corruption but do not prove origin. File flush/replace and directory
sync have the same platform limitations as the repository; process-kill testing
does not certify filesystem/hardware power-loss behavior.
