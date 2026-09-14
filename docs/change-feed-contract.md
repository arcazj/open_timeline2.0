# Change Feed Contract

This contract describes the implemented workspace metadata feed, not background
record synchronization. Existing query sessions and layouts stay immutable.
Live clients prepare and atomically adopt replacement query bundles; Pinned
clients may show a change indicator without altering the pinned result.

## Polling

`GET /api/v1/workspaces/default/changes` requires Bearer authentication and
`records.read`. Parameters are `generation` (UUID), `afterRevision` (safe integer
at least zero), `limit` (1-500, default 100), and optional `scope` (64 lowercase
hexadecimal characters). The response is:

```json
{"generation":"11111111-1111-4111-8111-111111111111","scope":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","throughRevision":9,"nextRevision":9,"changes":[{"revision":9,"family":"records","recordIds":["22222222-2222-4222-8222-222222222222"],"requiresReload":true}],"hasMore":false}
```

The first poll captures `scope`; every subsequent poll sends that exact value.
Scope binds the current principal, role and workspace grants. Each read rechecks
the current token, capabilities, workspace generation and permissions while
holding the identity lock before the repository lock. Scope changes reject with
409 `permission_scope_changed`; generation changes with 409
`generation_mismatch`; future revisions with 422 `invalid_revision`; revisions
before retained audit coverage with 409 `replay_gap`. A legacy store with no audit
entries supports resuming at its current revision, not earlier history.

Each committed workspace mutation emits one notice, including a complete atomic
record batch. Idempotent replays emit no additional notice. Entries include only
revision, family, distinct record IDs and `requiresReload: true`. No actor,
command ID, title, record data, configuration definition or hidden count appears.
Record notices require access to every source represented in that commit.
Personal configuration notices are visible to their owner or an administrator;
shared configuration notices require unrestricted workspace source access.

`throughRevision` is the current committed high-water mark, not a pinned query
revision. `nextRevision` is the last returned visible revision when more visible
entries remain, otherwise the high-water mark. Hidden entries are scanned but
never counted in the response. A successful empty page can advance the cursor.
Polling consumes only validated audit metadata already held by the repository;
it does not load records or build queries. Restart retains the durable feed.

## Server-Sent Events

`GET /api/v1/workspaces/default/changes/stream` accepts the same parameters and
returns `text/event-stream`. Initial authorization, cursor validation and stream
admission happen before HTTP 200. `event: changes` carries the polling response;
`event: heartbeat` carries only the current generation and revision. Resume with
the last received `nextRevision` and scope, not a record-page cursor. Authentication
and grants are rechecked at least once per second while idle; catch-up pages are
checked separately. A sanitized `event: error` reports code/status and closes the
stream on revocation, changed scope/generation, or unavailable history.

There are at most 64 simultaneous stream leases per service and two per
principal. Excess admission returns 429 `stream_capacity`. Leases expire after
five seconds without renewal, are cleaned during admission and stream reads, and
are released on disconnect, cancellation, completion, send failure and shutdown.
Each connection has one in-flight metadata page and no accumulating producer
queue. A blocked ASGI send is cancelled after one second, bounding slow-reader
backpressure; disconnect cleanup also runs outside the body generator.

## Browser Provider

`ServerProvider.subscribeChanges(listener, options={})` returns an unsubscribe
function. It captures initialized metadata generation/revision unless explicit
`options.generation` and `options.afterRevision` are supplied. Polls are sequential,
with no more than one pending request per subscription, a five-second request
timeout, and a one-second delay between normal polls. Catch-up pages continue
immediately. A temporary outage emits `server-unavailable` and retries reads
after one second; recovery emits `changed` with `recovered: true` even if the
visible notice list is empty so the consumer can clear its stale indication.
Any successful high-water advance also emits `changed`, including an empty
authorized notice list. This invalidates a formerly visible record moved into an
unauthorized source without disclosing its ID, destination, family or hidden
counts. The already-visible workspace revision is the only signal; callers must
not interpret an empty page as proof that their rendered result is unchanged.

Events are `changed` (the complete feed page), `server-unavailable`,
`authorization-lost` (401/403 or changed permission scope), and
`generation-changed` (generation mismatch or replay gap). The latter two stop
polling and require a newly authorized snapshot/subscription. Invalid successful
responses fail closed as `server-unavailable`; cursors never advance on failure.
Unsubscribe, an external abort signal, and provider disposal abort pending reads
and timers and suppress late callbacks. Neither polling nor reconnection retries
any mutation or changes an existing immutable query session.

This work does not by itself certify Live/Pinned UI behavior, cross-platform
streaming deployment, or all release performance gates.
