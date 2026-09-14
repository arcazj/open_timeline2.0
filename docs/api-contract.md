# Native API Contract

The [machine-readable OpenAPI document](../shared/openapi.json) describes registered Python handlers, not planned endpoints. It pins OpenAPI 3.1.1 and JSON Schema Draft 2020-12 as required by REQ-15. It does not close the complete-release API work package RL-07 or certify every normative acceptance scenario.

## Generation And Verification

Run `.venv/Scripts/python.exe scripts/export-openapi.py` on Windows, or `.venv/bin/python scripts/export-openapi.py` on Unix. `--check` fails when the artifact differs from current routes or shared schemas. Generation constructs the application without starting its lifespan, opening a store, or using network access. The supplied construction-only value is not an installed server credential.

The authenticated `GET /api/v1/workspaces/default/openapi.json` uses the same `build_contract(app)` function. Each registered operation is explicitly classified with request/response schema, success status, security, permissions and write preconditions. An unclassified route fails generation. Included routers are enumerated using the same effective route contexts as the installed FastAPI OpenAPI generator; they cannot silently disappear from coverage. Operation IDs are unique across typed aliases.

All nine shared schemas are bundled into `components.schemas`. References are rewritten to internal document pointers without changing validation constraints; original file paths and SHA-256 hashes remain in `x-source-file` and `x-source-sha256`. No HTTP schema resolution is needed. Runtime semantic checks still enforce source authorization, exact schema-version references, bounded custom-schema language, safe integers, time precision, relationship graphs, budgets and operator typing. A structurally valid request is not automatically authorized or semantically valid.

`tests/server/test_openapi.py` checks the OpenAPI document against the vendored official 3.1 document schema, independently checks each component against JSON Schema 2020-12, resolves every bundled reference, validates examples, compares registered operations, and validates representative real HTTP responses. It covers readiness/capabilities, metadata, typed records, JSON Patch, deletion, query/density/map/overview/zones/layout/row/table results and structured failures. These checks are contract tests, not external certification of the full release.

## Implemented Transport

`B` currently means `/api/v1/workspaces/default`. Other workspace IDs are not implemented. Catalog routes with `{family}` accept only `sources`, `groups`, `schemas`, `filters`, or `views`. For legacy IDs containing slash or Unicode, use the exact-ID query aliases `B/configuration/resource?family=...&id=...` and `B/configuration/usage?...`; do not normalize IDs or reinterpret them as filesystem paths.

| Surface | Actual Behavior |
| --- | --- |
| `B/events`, `B/sessions`, `B/records` | GET/POST; item GET/PUT/PATCH/DELETE. Typed routes enforce immutable kind. Creation 201 includes Location and a canonical committed result. DELETE 204 has no body. |
| `B/records/{id}/restore` | POST 200 with current tombstone ETag. Ordinary item reads exclude deleted records; authorized `includeDeleted=true` returns a current tombstone. |
| `B/records/batch` | POST 200 atomic 1-500 operations, at most 500 affected IDs, explicit cascades only. 8 MiB request and 32 MiB before/after journal envelope limits. |
| `B/records/query`, `B/query-sessions` | POST 200 ready or 202 preparing with status Location; they never return the complete record array or change canonical revision. Prefer: respond-async skips the short ready wait, not admission. |
| Query density/map/overview/zones/layout/rows/table/placement | Bounded views of one pinned query. GET `B/query-sessions/{queryId}/layouts/{layoutId}` inspects owned preparing/ready/failed layout status without detailed records. Table pages are complete filtered-record pages independent of timeline row pages. Payload fragments remain unimplemented. |
| `B/{family}` and item/history/usage/validate | Reads and read-only validation. Lists contain visible metadata, not full private definitions. Versioned mutations currently use `B/configuration/commands`, POST 200. |
| `B/settings/effective`, `B/settings/commands` | GET/POST read-only resolution; POST revisioned personal/workspace override mutation. Apply of a generic saved view/filter changes only the acting principal's preferences. |
| `B/models` | Existing visual-model lifecycle routes, revisioned draft/publication commands, GET full history, read-only validation. Its legacy Apply changes workspace active settings; generic saved-view Apply is personal. |
| `B/schemas/{id}/impact` | Read-only complete immutable analysis, two retained analyses, 1-1000 items/page. Current record pins/deleted state and errors are reported. No automatic migration. |
| `B/snapshot` | Complete authorized source universe with reference-closed visible catalogs, acting principal preferences and expanded checksum. Not a page export or backup of root identities. |
| Principal/token routes | Authenticated root administration and permitted own-token operations, revisioned identity generation and actor-scoped command outcomes. Tokens are shown once; durable token-creation outcomes explicitly mark the secret unavailable. |
| `/health/live`, `/health/ready`, `/api/v1/health`, `/api/v1/capabilities` | Public sanitized operational state. Readiness 503 uses a health JSON envelope, not problem details. Capability visibility grants no access to records or secrets. |
| `B/audit` | Authenticated metadata-only revision chain with audit.read and source/visibility filtering, signed pinned pagination and explicit historical coverage. No hidden total. |
| `B/changes`, `B/changes/stream` | Durable metadata notices after a revision, current authorization/scope on every read, restart replay and bounded authenticated SSE. See [Change Feed Contract](change-feed-contract.md) for scope, heartbeat, lease and browser polling semantics. |

The generated route inventory is authoritative for whether a row above is currently registered. New handlers require updating generator classification, examples and tests before regenerating the artifact.

## Query Retention

The engine admits at most four live query handles per trusted principal, with two layouts and two reconstructible table indexes per query. Preparing handles count toward these same ceilings. Handles expire after 300 seconds; joined maintenance releases idle expired artifacts. Explicit release and authorization invalidation also release retained artifacts. Foreign handles remain undisclosed as 404. An owned expired handle returns 410 while its bounded tombstone is retained; changed authorization returns 409 and requires preparing a new query.

All retained query, layout and table payload graphs share one 256 MiB engine budget. Immutable objects referenced by multiple retained artifacts count once; page reads do not rescan the accounting graph. Failed admission rolls back its accounting exactly and never evicts another live query/layout. Table-cache replacement may release only its reconstructible index. Preparation request bodies are limited to 64 KiB. Existing input and row/table response limits also apply.

The ledger measures Python-owned object graphs, not process RSS. Its bookkeeping index and admission rollback journal have separate 256 MiB and 64 MiB bounds. Captured backing graphs and worker results are charged to the same ledger, including shared immutable record references. Each admitted preparation reserves another 8 MiB allowance; this is an admission allowance, not a measured upper bound on interpreter, library, packing-index or response-serialization memory. Aggregate RSS and the normative mixed 100k workload remain unqualified.

## Background Preparation

All public query/layout preparations use one coordinator: at most two active operations globally, one per principal, and eight queued intents. Table-index construction takes the same permits and allowance, while already-cached table pages need no new preparation admission. A bounded request/capture-container reservation precedes snapshot capture; repository records are immutable borrowed references from copy-on-write publication, not a second full record copy. Captured input graphs and the preparation allowance are admitted before a 202 promise; a candidate exceeding remaining capacity fails explicitly. Worker computation runs outside the public engine mutex, using namespaced accounting in the same ledger; final publication rechecks current identity, token and scope before replacing the placeholder atomically.

Without Prefer, a completed short-wait failure is an ordinary problem-details response and its failed handle is released. With Prefer: respond-async, POST may return 202 preparing or an already finished 200 result. GET returns 202 preparing with Location/Retry-After, 200 ready, or 200 failed with a bounded `{error:{code,message,status}}` descriptor. A failed status contains no invented zero counts. Dependent projections reject unready handles explicitly. DELETE releases/cancels the captured handle; it never creates another preparation.

The default 30-second publication deadline covers queued and active work after admission. Deadline and cancellation checkpoints run through filtering, density, font measurement, layout packing and table sorting; publication also checks the deadline. Polling can report timeout while an uncooperative library call is still exiting. Python threads are not forcibly terminated: input charges and active permits remain held until actual exit, and shutdown joins workers and synchronous preparations. Client abort/disposal stops status polling and releases known or late-returned allocations using the original source credential. An allocation whose response is permanently lost cannot be identified by the client and expires through the bounded server lease; in-memory clientRequestId deduplication/recovery remains a separate gap.

`ServerProvider.createQuery` and `createLayout` transparently wait for ready manifests, so renderer and Live/Pinned adoption retain their existing coherent promises. No failed preparation is automatically retried as another query. The single sparse 100k diagnostic in `artifacts/performance/query-preparation-100k.json` completed with bounded retained graphs, but admission alone took over seven seconds on that run. It does not meet the three-second status target or qualify mixed-fixture latency, concurrent revocation latency, real-store HTTP behavior, process RSS, or full release performance.

## Writes And Recovery

Every current record/configuration/model write requires `X-Workspace-Generation` and `Idempotency-Key`. Existing resources require strong quoted `If-Match: "generation:revision"`; batch items carry individual expected versions. Identity mutations instead use `X-Identity-Generation`, identity ETags and an original idempotency key. Body duplicates must agree with headers. Saved view/filter Apply additionally requires `expectedPreferenceRevision`; an absent preference resource has revision 0.

Record PUT replaces all sixteen mutable fields, including nullable baseline fields. Record PATCH uses `application/json-patch+json` and 1-100 RFC 6902 operations under allowed mutable paths. Null is a value, arrays obey index/append semantics, and root/immutable/prototype paths reject. The final record must remain complete and schema-valid. See [Record Commands](record-command-contract.md) for exact fields, batch limits and failure semantics.

Successful mutations use one serialized transaction with durable original outcome. After a lost response, read `B/command-results/{originalKey}`; never infer rollback from a disconnect or generate a new command identity. DELETE's 204 has no payload, so clients may retrieve its original result separately. Pending-admission responses and guaranteed retention/checkpoint policies remain explicit release work; this contract does not invent 202 behavior for the current synchronous handlers.

Errors use `application/problem+json`: type, title, status, detail, instance, stable code, message, requestId, and optional field diagnostics. Malformed requests/cursors 400, authentication 401, permission 403, absent/inaccessible 404, business/generation/key conflicts 409, stale revisions 412, limits 413/429, media type 415, field/schema failures 422, missing preconditions 428, and storage/recovery 503 are distinguished. Authentication returns WWW-Authenticate; capacity/unavailability responses include Retry-After where applicable. An inaccessible record may be 404 to avoid disclosure. Examples use no functioning credentials or absolute internal filesystem paths.

## Exact Scope And Pending Ledger

The following normative requirements remain mandatory and are not represented as working endpoints. Existing functional equivalents are distinguished from route/API gaps; this ledger does not modify the original prompt.

| Requirement | Pending Surface Or Contract Gap |
| --- | --- |
| REQ-15, prompt08 | Multi-workspace collection/item CRUD; arbitrary workspace routing. Native collection/item mutations for sources/groups/schemas/filters/views currently have a generic command equivalent but not the full requested POST/PUT/PATCH/DELETE route surface. |
| REQ-16 | Existing visual-model PUT is a submitted-field compatibility update, not complete replacement. Model creation lacks Location. Durable pending identity admission 202 and minimum retry-retention/checkpoint promises are not complete. |
| REQ-15, REQ-22 | Native `B/settings`, `B/preferences/me` GET/PUT/PATCH/DELETE and mutable `/api/v1/settings` application defaults. Generic settings commands cover personal/workspace only. |
| REQ-15, REQ-28 | Principal DELETE as explicit disable/revoke route; PATCH enabled=false is implemented, but does not erase the required route. |
| REQ-42, prompt26 | Separate owned draft resources; per-ID validate/preview/diff; dedicated visual-model version routes; explicit reference upgrade transactions; publish-and-selected-upgrade; model-package jobs; typed field-catalog/distinct-values endpoints; native per-view effective-settings route. Existing embedded drafts, generic usage, schema impact and effective-settings resolution are partial equivalents. |
| REQ-26/27, prompt08/14 | Change pages, authenticated SSE and durable restart replay are implemented. Specified minimum retention/checkpoint/compaction promises, deployed streaming behavior and complete Live/Pinned UI acceptance remain separate release gates; the feed does not certify them. |
| REQ-14/31/32, prompt08 | Native imports/exports/jobs with cancellation, package ID remapping/migration, backup creation/listing/validated restore job routes. A complete portable snapshot is not a complete root/store backup. |
| REQ-52, prompt49 | In-memory clientRequestId deduplication/recovery; full specified aggregate/projection/zone/fragment limits; footprint-only context and complete generation/snapshot/profile provenance on every projection. Async query/layout preparation, inspection and cancellation are implemented, not the other missing behaviors. |
| REQ-19/52 | Admission/status latency, current-authorization latency under large graph accounting, aggregate RSS, normative mixed-fixture qualification and remaining admission promises. Four handles per principal, shared retained-payload accounting, bounded workers/queue, expiry/invalidation and transactional artifact replacement are implemented independently; they do not close this full work package. |

Test success is reported with concrete test names/results; it is not evidence that pending features were implemented or external OS/browser/performance/security gates passed. See [Release Checklist](release-checklist.md) and [Integration Test Plan](integration-test-plan.md).

## Standards And Vendored Validator

The interoperability baseline is the [official OpenAPI 3.1.1 specification](https://spec.openapis.org/oas/v3.1.1.html), with [JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12). The vendored `tests/fixtures/openapi-3.1-meta.schema.json` was downloaded unchanged from the [OpenAPI Initiative 3.1 document schema, 2022-10-07](https://spec.openapis.org/oas/3.1/schema/2022-10-07); SHA-256 `da01ba28852cac0de53893797cb8d1942bc3b05084f526dcc216717dec314ed0`. This document schema accepts 3.1.x and intentionally leaves component-schema validation to the separate 2020-12 checks. It is validation data, never executed application code.
