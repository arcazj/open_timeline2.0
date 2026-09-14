# Identity Root V2

Status: implemented with focused verification described below. This decision covers only the root
identity document, not workspace transactions, backup activation or application
configuration catalogs.

## Authority and Commit

`control/identities.json` remains the single ordinary JSON authority for principals,
hashed tokens, identity audit and command outcomes. An exclusive OS lock owns the
control root. The in-process identity mutex is acquired before workspace mutexes;
no identity operation waits for a workspace while another path holds the workspace
and waits for identity. The offline recovery operator acquires root ownership before
workspace ownership and refuses an active owner.

V2 adds `commands`, `recoveryHistory` and a document checksum. V1 remains readable
without startup writes; the first authorized mutation upgrades it within the same
atomic replacement. The checksum covers compact sorted-key UTF-8 JSON excluding
the checksum field and is integrity evidence, not a signature. Canonical UUIDs,
strict JSON, finite safe numbers, bounded depth, Unicode validity, references,
monotonic resource timestamps, complete audit revisions and a 32 MiB raw/encoded
document limit are validated. Unknown formats fail closed. Symlink/reparse paths
are rejected; raw reads are bounded and detect file changes during the read.

This is an atomic **single-target old-or-new** protocol: validate the whole candidate,
write a unique sibling temporary file, flush/fsync, atomically replace the identity
file and flush its directory where supported, then publish memory. An I/O exception
can occur after replacement; freeze access and reconcile the actual JSON on restart.
Do not repeat the write to guess its outcome. This is not the multi-target PREPARED/
COMMITTED workspace journal and does not claim hardware power-loss certification.

## Commands and Secrets

All HTTP identity mutations require `Idempotency-Key`, identity generation and the
existing root/resource If-Match. Keys contain 1-128 ASCII letters, digits, underscores
or hyphens. Scope is principal plus identity generation plus key; the request hash
covers operation, target, semantic payload and applicable preconditions. Reauthenticate
and authorize current scope, check generation, then replay matching committed commands
before current resource-version checks. Reused keys with different content conflict.

Outcomes retain original HTTP status, Location, root revision and resource ETag in
the same atomic document as the mutation/audit. Read-only
`GET /api/v1/identity/commands/{key}` returns only the authenticated principal's
authorized outcome. No retry or lookup creates another credential. Outcome retention
is at least 24 hours; the bounded initial implementation retains history until its
explicit document/entry capacity rather than silently expiring it. Capacity exhaustion
rejects before commit and requires a separately reviewed retention procedure.

Token secrets are generated with cryptographic randomness and returned once after
known commit. Only their SHA-256 hashes enter storage. Persisted token-create outcomes
contain public token metadata and `secretUnavailable:true`, never the secret or its
hash. A same-key replay returns that metadata without generating a replacement secret.
After a lost token response, inspect the outcome, revoke the inaccessible token and
explicitly create a replacement with a new key. Plaintext secrets never enter audit,
outcome payloads, recovery provenance or logs.

## Current Authorization and Drift

Operations re-resolve both the principal and token under the identity mutex;
revocation, disablement, expiry, generation change or role/scope changes invalidate
stale request contexts. API response metadata is captured under that same lock.
Mutations may not leave the root without an enabled administrator and at least one
currently usable administrator token. Natural expiry is still possible and is not
repaired by changing an environment variable.

The store owns a bounded integrity-monitor lifecycle. It never holds the mutex while
sleeping, checks the current authoritative bytes against the admitted hash and freezes
on drift or unreadable storage. Every mutation checks identity integrity immediately
before commit. Authentication checks file identity for immediate ordinary drift
detection; readiness can request a complete integrity check. Close stops and fully
joins the monitor before releasing ownership. Monitor detection is operational
fail-closed behavior, not permission to overwrite external edits.

## Offline Recovery

`scripts/recover-identity.py` is a local operator command for an existing, valid,
inactive data root. It never bootstraps missing metadata or automatically repairs
malformed JSON. A reason is required; an existing administrator can be explicitly
selected, otherwise a deterministic existing administrator is re-enabled. Recovery
creates a fresh identity generation, revokes every old token, issues one fresh
administrator token, advances revisions and records audited previous/new generation
provenance. Principal IDs and prior audit/outcome history remain present.

The fresh secret is printed once to the invoking operator after a known successful
commit, not written to a token file. A lost recovery reply requires another explicit
inactive-root recovery, which revokes the unreceived credential. The workspace's
event/session JSON and generation are untouched. The environment bootstrap secret
is accepted only when initializing a genuinely new empty identity root and never
resets an existing root or reactivates revoked credentials.

Tests must cover pre/post-replace faults and restart, malformed UUID/types/depth/size,
drift monitoring and clean shutdown, stale-auth races, all last-admin transitions,
key conflicts and original-ETag replay, token loss without plaintext persistence,
inactive-root ownership, source preservation, generation rotation and recovery twice.

Focused execution passed 72 identity service/API/hardening cases in 17.35 seconds
on Windows, with two upstream test-client deprecation warnings. This includes real
subprocess exit before/after identity replacement, two restarts, explicit recovery
CLI execution and source record-byte preservation. Scoped Ruff checks passed.
Neither this evidence nor the separate 100,000-record startup observation certifies
the complete release or hardware power-loss behavior.
