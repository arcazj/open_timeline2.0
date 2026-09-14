# Identity and Local Recovery

The Python service stores principals, token hashes, audit and command outcomes in
one ordinary JSON document: `OPENBEXI_DATA_ROOT/control/identities.json`. No database
is involved. [ADR 0003](adr/0003-identity-root-v2.md) defines the storage and recovery
protocol; it is distinct from the multi-target workspace journal.

## Bootstrap and Access

For a genuinely new control directory, `OPENBEXI_API_TOKEN` creates the initial
administrator and one bootstrap token. The configured secret must contain 12-512
printable ASCII characters without spaces. Use a high-entropy secret. Only its
SHA-256 hash is stored; generated tokens use 32 cryptographically random bytes.

An existing identity file is authoritative. Changing the environment never replaces
its administrator or reactivates a revoked token. Missing metadata in an existing
control directory fails closed, even when a bootstrap value is configured. An
interrupted first initialization that left no valid identity file needs operator
inspection; ordinary startup does not guess whether the directory is new.

Roles are viewer, editor and administrator, with explicit workspace/source grants
and bounded extra capabilities. Every operation re-resolves its principal and token
under the identity mutex. Disabled principals, revoked/expired tokens, changed
identity generations and changed roles/scopes invalidate stale request contexts.
Administrator operations require current administrator authority, not a role copied
from an earlier authentication step.

Committed role, grant, enabled-state and token-revocation changes immediately purge
retained query/layout/table artifacts for the affected principal before returning.
Revoking one credential conservatively invalidates that principal's pinned handles
even when another credential remains usable; a fresh authorized query is required.
Display-name changes do not evict queries. Expiry is checked on every authenticated
operation, with cached artifacts also purged by the bounded identity integrity
tick. Identity-file corruption or uncertain identity publication clears all retained
query scopes and freezes access. Cache-purge failures also freeze reads, but cannot
turn a known committed identity write into an uncommitted result. These are
server cache guarantees, not proof of an already disconnected browser's state.

## HTTP Commands

Read routes:

- `GET /api/v1/principals/me`
- `GET /api/v1/principals` and `/principals/{id}` for administrators
- `GET /api/v1/tokens`, limited to the caller's tokens unless administrator
- `GET /api/v1/identity/commands/{key}`, limited to the current principal's
  currently authorized outcome in the current identity generation

Writes are `POST /principals`, `PATCH /principals/{id}`, `POST /tokens` and
`DELETE /tokens/{id}`, beneath `/api/v1`. Every write requires
`X-Identity-Generation`, `If-Match` and `Idempotency-Key`. Create uses the root ETag;
update/revoke uses the resource ETag. Keys are 1-128 ASCII letters, digits,
underscores or hyphens.

Generation/authentication/authorization are checked before replay; identical replay
precedes current resource revision checks. Reusing a key with different operation,
target, payload or preconditions returns `409 idempotency_conflict`. Matching replay
retains the original HTTP status, root revision, resource ETag and Location even
after other commands advance the root. Outcome lookup is read-only and never retries
a mutation. A missing outcome is `404 command_not_found`, not proof that the original
request was submitted or a reason to issue another write automatically.

Creating a token returns its secret once after known commit. Its persisted outcome
contains public token metadata and `secretUnavailable:true`, never the secret or
its hash. Same-key replay returns that metadata without generating another token.
After a lost token-create reply, inspect the outcome, revoke the inaccessible token
and explicitly create a replacement with a new key. Normal token lists, audit and
outcome lookups never expose token hashes as public token metadata. Administrative
storage backups necessarily contain the hashed credential records, not secrets.

## Local Recovery

Stop the service first. Recovery requires both root identity ownership and workspace
ownership; an active service is refused. It accepts only an existing valid identity
file and does not repair arbitrary corrupted JSON or initialize missing metadata.

```powershell
.venv/Scripts/python scripts/recover-identity.py --data-root C:/data/timeline --reason "Administrator credential unavailable"
```

`--principal-id` can select an existing administrator UUID; otherwise the first
administrator in canonical ID order is selected. Recovery re-enables that principal,
creates a fresh identity generation, revokes every old token, issues one new token,
advances revisions and appends audited recovery provenance. Existing principal IDs,
prior audit and old command history remain. Event/session JSON and workspace
generation are not rewritten. Reasons are recorded, so do not put credentials or
other secrets in them.

The command prints the new secret once to the invoking terminal after known commit.
It does not save a plaintext token file. Use the new credential for subsequent
authenticated requests; merely changing `OPENBEXI_API_TOKEN` is not recovery. If the
recovery response itself is lost or its commit is uncertain, inspect the inactive
root and run an explicit recovery again; that operation revokes any unreceived token.

Normal mutations cannot leave the root without an enabled administrator and at least
one currently usable administrator token. This guards revocation, disabling and
demotion, not only the count of administrator principals. Naturally expiring all
remaining administrator tokens is still possible; that situation requires this
local recovery procedure. Keep a separately protected recovery-capable credential
and rotate before revoking the last usable one.

## Integrity and Bounds

Format1 files remain readable without startup writes and upgrade on the first
authorized mutation. Format2 adds checksummed command/recovery history within the
same atomic document. Unknown versions, noncanonical UUIDs, invalid types/references,
unsafe numbers, malformed Unicode, excessive JSON depth and invalid audit sequences
are rejected. Raw and encoded identity documents are capped at 32 MiB, with at most
1,000 principals, 10,000 tokens and 100,000 audit/command/recovery entries. Current
retention does not silently expire outcomes: capacity exhaustion rejects new writes.
This exceeds the minimum 24-hour retry retention but is not an implemented history
compactor. Revision-capacity exhaustion likewise fails explicitly.

Raw reads are bounded and compare descriptor/path identity before and after reading.
Symlinks, reparse points and nonregular identity/lock paths are rejected. Every
mutation verifies authoritative bytes against the admitted hash before replacement.
Authentication checks file identity immediately, and a one-second monitor checks
the complete bounded document's bytes. Detected drift freezes access and readiness;
the file is never overwritten to match memory. Scheduling and filesystem latency
can extend the monitor interval, so it is not a hard real-time security guarantee.
Shutdown stops and fully joins the monitor before releasing ownership.

The write guarantee is single-target old-or-new: validated JSON is flushed to a
sibling temporary file, atomically replaces the identity document and is directory-
flushed where supported before memory publication. Errors can occur after replacement;
`identity_commit_unknown` freezes access until restart reads the actual stored state.
No plaintext secret is needed to reconstruct the committed result metadata.

Process-exit and failure-injection tests do not certify sudden hardware power loss,
Windows directory-flush behavior, hostile administrator filesystem races, maximum-
capacity latency or backup restoration. Local recovery is not a replacement for a
validated backup/restore workflow.

## Verification

```powershell
.venv/Scripts/python -m pytest tests/server/test_identity.py tests/server/test_identity_api.py tests/server/test_identity_hardening.py -q
```

Focused coverage exercises bootstrap preservation, scopes/stale contexts, canonical
validation, drift/monitor shutdown, last usable administrator tokens, original-header
replay, secret-free lost responses, pre/post-replace interruption, actual process
exit, repeated restart, inactive-root ownership, recovery generation rotation and
unchanged event/session files. Results for the complete release are maintained
separately; these focused checks are not a full-release certification.

Latest focused result: **72 passed in 17.35 seconds**, with two upstream test-client
deprecation warnings. Scoped Ruff checks passed. No performance percentile or
hardware durability gate is inferred from this run.
