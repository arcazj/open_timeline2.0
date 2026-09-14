# OpenBEXI Timeline 2.0

Implementation specification and generation prompt | Revision 2.3 | 12 September 2026

Project name: `openbexi_timeline2.0`

Reference repository: https://github.com/arcazj/openbexi_timeline

Source baseline: `master` at `cf5d263853e550aab44d3d1959637c1e324b719e`.

**Current task: finalize this prompt only. Do not generate application code, install application dependencies, build the application, or deploy anything until the user explicitly requests implementation.** Once implementation is authorized, execute the requirements and milestones below. JSON examples, API definitions, and acceptance scenarios are specifications, not authorization to start development.

This Markdown file is the editable source of the accompanying PDF. Keep their substantive content identical. The source audit is static: the legacy application was not built or run during this revision. Source-derived findings, proposed behavior, and future verification requirements are distinguished throughout.

Revision 2.3 makes the two newly supplied SIMILE screenshots the primary visual reference: a light main timeline above a compact synchronized overview, with bottom axes, readable markers/bars and translucent vertical zones. It adds local density-aware time magnification, server-driven vertical row pagination and an explicit pre-code-delivery integration gate. Sections 46-51 and their companion contracts take precedence over older default-layout and unlimited-height wording. Classic blue, dark and custom legacy models remain compatibility cases, not the new default. Five new proposed views and both SIMILE reference images supplement the retained legacy evidence. All proposed screenshots are static design mockups, not implemented software or runtime test evidence.

## 01. Mission, priorities, and storage boundary

Act as a senior application architect, reverse-engineering specialist, timeline developer, API designer, UX designer, and quality engineer. Design, and later implement when authorized, a modern successor to OpenBEXI Timeline. Preserve every source-verified model family and functioning temporal interaction at the pinned baseline, subject to the explicit safety corrections below; add a complete RESTful management API and a synchronized, fully usable tabular view. The shipped default model alone is not sufficient compatibility coverage.

**REQ-01 - JSON files are the only persistent event/session store.** Store all authoritative events, sessions, and child activities in ordinary UTF-8 `.json` files on a local filesystem. Do not introduce PostgreSQL, SQLite, MongoDB, Oracle, Elasticsearch, Redis, LevelDB, IndexedDB, an ORM-backed store, a database server, or another embedded database as an event/session store, index, cache, queue, or hidden dependency. A file-backed database is still prohibited. JSON Lines/NDJSON is not the canonical format: each persisted `.json` file must be one independently parseable JSON document.

Use JSON files for application-owned models, saved filters, UI configuration, views, audit records, job metadata, and recovery journals as a design default, keeping the deployment database-free. In-memory indexes and disposable JSON index snapshots are permitted. Static assets may retain their native formats; compressed backups may package JSON documents. Deployment environment variables and external secret files are not event stores.

**REQ-02 - One writer, multiple clients.** The initial supported deployment is one application server process owning one local data root, with concurrent browser/API clients. Enforce exclusive ownership across processes. Do not promise multi-server shared-disk writes, network filesystem safety, or horizontal write scaling. This constraint must appear in startup checks and deployment documentation.

**REQ-03 - Product scope.** The initial release includes event/session CRUD, nested activities, time navigation, configurable bands and grouping, visual models, shared filters, Timeline/Table/Split modes, durable settings, live synchronization, migration, backup/restore, local density-aware time magnification, synchronized zones, server-driven vertical row pages and automated verification. Build a temporal visualization and editing tool. Automatic scheduling, dependency propagation, critical path, resource optimization, recurrence expansion, and external database/broker connectors are deferred unless separately requested. Preserve relevant legacy metadata without inventing those engines.

Priority order: explicit user constraints; data integrity and security; verified legacy meaning; mandatory API/UI workflows; accessibility and performance; optional enhancements. Never resolve a performance problem by violating JSON-only storage. Mark each requirement as mandatory or explicitly deferred; do not turn mandatory features into "where supported" options.

## 02. Evidence-based legacy baseline

**REQ-04 - Reproducible discovery.** Use the pinned commit above for comparison. Inventory tracked source, examples, configuration, tests, manifests, assets, and documentation. Before architecture commitment, read every first-party source file and relevant configuration, test, example and documentation file; record exact coverage, inaccessible/unreviewed material and justified exclusions. Generated/vendored files, IDE metadata, binary assets, and certificates need classification, not claims of behavioral verification. Inspect large datasets with structured parsers and report parse failures. Do not treat a class name, configuration example, dependency, icon, or Swagger entry as proof of a working feature.

The following findings informed this revision. File identifiers refer to the pinned-source references in section 45. Mandatory M0 inputs include the [listener audit](docs/legacy-interaction-audit.md), [model inventory](docs/legacy-model-compatibility.md), [layout audit](docs/legacy-layout-audit.md), [menu/search audit](docs/legacy-menu-search-audit.md), [17-page brief coverage](docs/legacy-brief-coverage.md), and [legacy visual compatibility contract](docs/legacy-visual-contract.md), alongside the source itself. Revision 2.3 adds the normative [adaptive scale contract](docs/adaptive-scale-contract.md), [server query and row-page contract](docs/adaptive-query-contract.md), and [integration test plan](docs/integration-test-plan.md). Its newer default, pagination and nonlinear mappings supersede conflicting older appearance/linear-only assumptions without removing other legacy capabilities. This revision's audit is still targeted static inspection, not a claim that the future complete-file M0 gate has already passed.

| Evidence | Source-derived finding | Required treatment |
| --- | --- | --- |
| S01-S03 | JavaScript/Three.js frontend and Java/Tomcat backend are present. | Evaluate reuse and maintained replacements; do not assume dependencies are current or the build works. |
| S03-S04 | UI logic uses an `events` collection, while the illustrative model uses a `session` envelope. Point/duration rendering depends on end-time parsing. | Write explicit import adapters and canonical kind rules; do not interchange envelopes blindly. |
| S03 | Activities, overview bands, original-time graphics, shading, grouping, and camera controls exist in source. | Trace and preserve meaningful behavior with tests; distinguish time-region shading from time-zone conversion. |
| S05-S06 | JSON sources, date-based paths, configurable rendering, and filter files exist alongside other connector examples. | Retain JSON ingestion and presentation semantics. Exclude all non-JSON storage/connectors from the new runtime. |
| S07-S08 | JSON creation exists, but its construction/error handling are unsafe; update/remove return false and HTTP PUT/DELETE are not implemented as CRUD. | Implement new resource contracts; do not advertise legacy CRUD as complete. |
| S09 | Swagger 2.0 describes one GET route and includes placeholders for other methods. | Replace it with a complete, tested API specification. Client-supplied permission strings are not authorization. |
| S10 | The Dockerfile expects local JARs, `lib`, and `node_modules`. | Verify clean-build reproducibility later; source inspection is not a successful startup test. |

During implementation discovery, run the original in an isolated environment when feasible, with throwaway data and local-only access. Record exact commands, screenshots, working workflows, failures, and benchmark conditions. Do not use bundled certificates or example credentials in the new deployment. If legacy execution is blocked, continue source-based compatibility work and label runtime comparisons unavailable.

Create a feature matrix with source location, evidence type, legacy meaning, preserve/replace/retire decision, new requirement ID, and acceptance test. Security defects, placeholder integrations, and broken writes are not compatibility obligations. Explain exclusions and never claim a complete runtime audit from static inspection.

## 03. Architecture and authoritative state

**REQ-05 - Simple, modular architecture.** Prefer one deployable application with a REST API and static frontend assets. Separate domain/time rules, JSON persistence, query/filter evaluation, authorization, API transport, shared client state, and rendering. Both views must invoke the same commands and consume the same canonical records. Files and browser state must not become competing authorities.

Evaluate the existing Java backend and JavaScript renderer before selecting frameworks. Record the choice, supported runtime versions, dependency maintenance, license compatibility, build reproducibility, and rendering tradeoffs in an architecture decision record. Do not force a rewrite solely for novelty. Orthographic 2D and source-backed perspective/3D camera behavior are mandatory compatibility cases, with orthographic as the accessible default. They must not depend on the spelling of an unvalidated camera string. A renderer change must demonstrate equivalent picking, navigation, bands, styles, and lifecycle behavior; an unsupported feature cannot be silently dropped. Avoid microservices, message brokers, database drivers, and unnecessary infrastructure.

Use established libraries for date/time handling, schema validation, HTTP, filesystem locking, and rendering where practical. Verify dependency behavior on the supported platforms rather than claiming generic portability. Lock versions and document a reproducible clean installation. Do not implement custom cryptography or evaluate arbitrary scripts from user configuration.

**REQ-06 - Workspace boundary.** A workspace owns records, sources, groups, schemas, visual models, filters, views, settings, a persisted generation UUID, and a monotonically increasing committed revision within that generation. Provide one default workspace; do not require an organization/tenant provisioning system. Keep IDs and permission checks workspace-scoped, with no accidental cross-workspace references or cache reuse. Use immutable startup configuration and request-local identity/query context; never put a client's mutable request state in a shared configuration object.

Restoring/replacing a workspace creates a fresh generation UUID. Bind ETags, query snapshots, cursors, change positions, and retry scopes to generation as well as revision. Mutations must declare the generation they observed through `X-Workspace-Generation`; an old generation returns 409 and requires refresh. Old retry results must not replay as current-generation mutations. Application-global resources use an equivalent root generation/revision.

Every durable mutation passes through validation, authorization, concurrency checks, persistence, audit, and post-commit publication. A successful API response means the documented commit protocol completed, not merely that an object changed in memory. Reads return a coherent committed revision. A failed save must not leave the timeline and table displaying a falsely confirmed value.

Use bounded work queues with overload responses. Long imports, exports, migrations, and backups run as tracked jobs in the same service, with JSON metadata and explicit progress/failure states. Their presence must not require Redis, Kafka, a queue service, or another database. Read-only static demonstration mode may be provided later, but it does not satisfy the server-backed release requirements.

## 04. Canonical records and relationships

**REQ-07 - One record model with explicit kinds.** An `event` is a point in time. A `session` is a duration record, optionally containing ordered child activities. An activity is a record linked to a parent session, not a second copy of its data. Sessions may exist without children. Authentication sessions are unrelated to timeline sessions and must use distinct terminology.

| Field | Contract |
| --- | --- |
| `id`, `workspaceId` | Server-assigned opaque UUID and workspace identity. Immutable. Retain original IDs separately during import. |
| `kind`, `title` | `event` or `session`; required nonblank title, 1-500 characters. Kind is immutable after creation. |
| `start`, `end` | Required normalized start timestamp. Events have `end: null`; sessions have a finite end or explicit null for an ongoing session. |
| `parentSessionId`, `order` | Nullable parent ID and integer ordering key. Parent must be a session in the same workspace/source. Break order ties by ID. |
| `sourceId`, `groupIds`, `tags` | Required JSON source ID; arrays of stable group IDs and text tags. A default source/group is available. |
| `data`, `render`, `extensions` | Typed domain metadata, validated per-record presentation overrides, and preserved namespaced unknown metadata. |
| `schemaId`, `schemaVersion` | Optional pinned custom-field schema; core record fields always follow the application schema. |
| `originalStart`, `originalEnd` | Nullable baseline dates preserved independently of edited dates. PUT must include both explicitly; omission is invalid. PATCH changes them only through explicit allowed paths. |
| `version`, `createdAt`, `updatedAt` | Server-controlled positive integer record revision and audit timestamps; every successful mutation increments version. |
| `createdBy`, `updatedBy`, `deletedAt` | Server-resolved actors and nullable soft-deletion timestamp. Never accepted as client authority. |

Validate unknown core keys as errors; preserve unknown legacy values under `extensions.legacy`. Declare built-in `data` fields explicitly: description/text/system/type/status are optional strings and priority is an optional finite number. Do not conflate `data.text` and description or coerce legacy strings without an import rule. Additional custom fields require `schemaId` and `schemaVersion` together; neither may appear alone. Remote schema resolution is disabled; references resolve only through approved local definitions with bounded validation complexity. Limit records to 256 KiB of serialized UTF-8, excluding separately managed assets; limit nesting to eight parent levels and reject cycles, self-parenting, dangling references, and duplicate IDs.

**REQ-08 - Parent semantics.** Moving/resizing a session does not implicitly move its children. Child times need not be contained within the parent; show an out-of-bounds indicator. A separate explicit "shift session and activities" command may use one bounded atomic batch. Do not derive the parent's dates silently from children.

Deleting a session with active children returns a conflict unless an explicit cascade operation lists the intended subtree and expected versions. Cascade and restore are atomic within the batch limit. A deleted parent cannot gain new children. Restore preserves IDs and increments versions; it fails if relationships would be invalid. Workspace/source/group/model deletion similarly rejects active references unless a documented reassignment or archival workflow is used.

## 05. Time semantics and legacy interpretation

**REQ-09 - Deterministic time handling.** Accept timestamp strings with an explicit numeric offset or `Z`; normalize stored instants to UTC with millisecond precision. Preserve an optional IANA display-zone identifier separately. Reject zone-less API timestamps, impossible dates, leap-second input, and precision beyond milliseconds rather than silently truncating. Support years 0001-9999 where the selected runtime can validate them consistently; document and test any narrower supported range before implementation acceptance. [N03]

For point events, `end` is null and duration is zero. For finite sessions, end must be greater than or equal to start. Equal endpoints represent a zero-duration session and retain session identity. For ongoing sessions, null end is explicitly meaningful only with `kind: session`. Elapsed duration is the maximum of zero and reference-instant minus start, never written back on every refresh. A future-start ongoing session displays a scheduled/not-yet-started cue, not negative elapsed time. Start/end edits do not automatically change domain status.

Use half-open query windows `[from, to)` and reject `from >= to` with 422. A positive-duration session matches if its start is before `to` and its end is after `from`; an ongoing session has no upper end. Point events and zero-duration sessions match when their start is inside the window. Include sessions that begin before the visible range but overlap it. Never rely on a start-date folder scan alone to find long-running sessions. Axis ticks use actual calendar boundaries in the selected display zone, never fixed 31-day months or 365-day years.

**REQ-10 - No silent legacy reinterpretation.** In the audited frontend, a missing/unparseable end follows the point-event rendering branch. During migration, missing/empty end therefore defaults to an event; it does not automatically become an ongoing session. A valid finite end maps to a session, including equal start/end. A nonempty invalid end is quarantined for review rather than accepted as a valid point. Preserve the original value and mapping decision. [S03-S04]

An empty-end legacy parent with genuine child activities conflicts with the new session-only parent rule. Default to quarantining that complete aggregate with all IDs and relationships. An explicitly selected import policy may create a provenance-marked finite session container spanning the point and validated child extents, retaining the original point as a child; if a finite extent cannot be determined, leave it quarantined. Never silently promote the original point into an ongoing session or flatten/drop its children.

Legacy Java-style date strings and different top-level envelopes require named adapters. An ambiguous timezone abbreviation or zone-less historical date needs an explicit import-time source-zone policy; otherwise reject that row with a reason. For DST gaps, reject nonexistent local times. For repeated local times, require the offset or an explicit earlier/later choice. Keep timezone display, elapsed duration, and calendar formatting consistent between views and API exports.

Preserve `repeater`, tolerance, conflict fields, original dates, and other legacy metadata without inventing recurrence or scheduling behavior. Legacy tolerance rendering does not establish a reliable time unit; retain it as raw metadata unless a documented mapping defines units. Provide fixtures for cross-midnight sessions, DST changes, overlaps, historical dates, ongoing sessions, and window boundaries.

## 06. JSON file layout and indexing

**REQ-11 - Documented filesystem contract.** Use a configured data root outside the publicly served asset tree. Default to a single canonical JSON document per record, distributed by an ID-derived directory prefix to avoid one oversized directory. A record's path must not depend on mutable dates, titles, usernames, filters, or source labels.

| Relative area | Purpose |
| --- | --- |
| `workspaces/{id}/records/{prefix}/{recordId}.json` | Authoritative record document, including deletion metadata. |
| `workspaces/{id}/config/{resource}/{id}.json` | JSON sources, groups, models, schemas, views, and saved filters. |
| `workspaces/{id}/settings/` | Workspace and personal JSON settings with versions. |
| `workspaces/{id}/journal/{transactionId}.json` | Valid JSON recovery/commit envelope; includes before/after images, revision, audit, and retry metadata. |
| `workspaces/{id}/audit/` | Immutable JSON audit projections, recoverable from retained committed transactions. |
| `workspaces/{id}/indexes/` | Optional disposable JSON snapshots tagged with their workspace revision. |
| `workspaces/{id}/jobs/` | Validated JSON job state and import/export manifests. |
| `backups/`, `quarantine/` | Restricted verified backups and isolated suspect files with diagnostic manifests. |

Root-level `control/` JSON documents hold application defaults, principal/capability metadata, token hashes, workspace registry, generation, and root transaction/audit history. Raw token secrets never enter these files. Root-level mutations use a root transaction queue and the same recovery protocol; an operation requiring root and workspace locks always acquires root first, then workspace IDs in lexical order. Avoid unnecessary cross-workspace atomic operations.

The precise layout may change through a documented decision if benchmarks justify it, but not to a database, NDJSON canonical log, arbitrary executable format, or multiple independent authoritative copies. JSON parsing must reject duplicate object keys, non-finite numbers, invalid encoding, truncated documents, and unsupported future format versions. Persist explicit format/schema versions.

Build in-memory ID, time-overlap, group/source, parent, and supported custom-field indexes from validated committed records. Persisted index snapshots are caches, never authorities. Missing, corrupt, or stale indexes must be rebuildable without data loss. A suspect index triggers rebuilding or a clearly reported unavailable query; it must never cause silently incomplete search results.

Document directory limits, file counts, memory cost, index rebuild time, and record-size limits. Partitioning must preserve globally correct overlap queries and stable identities across date edits. Startup must acquire the process lock, recover transactions, validate storage, and load/rebuild indexes before becoming ready. Do not read or mutate arbitrary host paths supplied by clients.

Each logical JSON source declares `readOnly` or `writable` policy. Source policy and principal capabilities both constrain mutations; a user edit capability never bypasses a read-only source. Persist and expose the effective policy through source management, and reject API writes consistently with disabled/absent UI mutation controls. Making a source writable is an authorized, audited configuration change, not a client-supplied record flag.

## 07. Durability, concurrency, and recovery

**REQ-12 - Explicit commit protocol.** Use an OS-enforced exclusive process lock for the data root and serialize each workspace's mutations. A second writer must refuse startup; a stale filename alone is not a reliable lock. Reads may use the last committed immutable in-memory snapshot while a mutation is prepared; never expose a partially updated batch.

Document a recovery protocol before implementing it. The default is a JSON write-ahead transaction envelope with complete before/after images and checksums. Atomically install and flush the complete PREPARED envelope, including required directory metadata where supported, before changing any authoritative target. If preparation fails, do not touch targets. Stage replacement files on the same filesystem, flush contents/metadata using supported platform primitives, and atomically replace targets; never use delete-then-create as a commit mechanism. After all targets are durably installed, atomically persist the COMMITTED state, then publish the new in-memory revision and respond. Cleanup occurs after commit and must not invalidate recovery evidence.

A transaction lacking a durable commit marker is rolled back to its before state on restart; a committed transaction is replayed to its after state if necessary. Recover against a durable checkpoint and ordered sequence, checking before/after versions and checksums. Roll back incomplete transactions and replay committed transactions in revision order; never overwrite a newer committed version with an older after-image. Detect gaps or conflicting journal entries. Recovery is idempotent and completes before serving affected workspaces. Retain enough history to repair projections/indexes/audit. If classification is unsafe, fail closed and preserve evidence; never guess by file modification time.

**REQ-13 - Failure scope.** Guarantee coherent acknowledged writes under documented process-crash conditions. Validate disk-full, permission failure, file-sharing contention, interrupted writes, and crashes at each protocol boundary. Document separately what is supported for OS crash and power loss on Windows/NTFS and Linux/local filesystems; atomic rename alone is not proof of durable power-loss safety. Reject unsupported deployment filesystems rather than claiming untested guarantees.

Record data, record versions, workspace revision, audit payload, and idempotency result belong to the same logical transaction. Derived notifications and indexes occur only after commit. Never report success unless durable commit is established. Pre-commit or uncertain-commit I/O failures follow rollback/reconciliation; post-commit cleanup failures do not reverse an established result. Lost responses after commit are resolved by retry identity.

Complete rollback before accepting another mutation after a pre-commit failure; freeze the workspace if rollback fails. If an error leaves commit status uncertain, reconcile the durable journal before reporting a final outcome. A failed response or client disconnect never proves rollback. Once commit is established, report/replay its result even if later nonessential cleanup fails.

**REQ-14 - Recovery operations.** Detect malformed documents and unexpected out-of-band changes. Freeze affected workspace writes and report integrity errors; never overwrite an externally edited file silently. Supported external ingestion goes through staging/import. Direct editing of the live store is unsupported. A backup captures a consistent committed snapshot of records, tombstones, schemas/models, settings, root control state, identities/capabilities, retry/audit/replay history, and generations/revisions in a checksummed manifest. External secrets are excluded and their separate restore requirements documented. Limit the first release to validated restore into an isolated inactive root, then an offline root switch; no live in-place restore. Reject unsafe archive paths, oversized extraction, missing files, and checksum/format failures. Journal compaction requires a verified durable checkpoint and preserves declared recovery/history retention.

## 08. REST resource surface

**REQ-15 - Complete API, independent of the UI.** Implement `/api/v1`, with an OpenAPI 3.1.1 contract and JSON Schema Draft 2020-12 definitions. This is a deliberately pinned interoperability baseline, not a claim to use the newest specification. Contract changes must update examples, validators, and tests together. API documentation is mandatory. [N01-N02]

In the table below, `B` means `/api/v1/workspaces/{workspaceId}`. Resource URLs are illustrative normative route names, not application source code.

| Endpoint family | Required methods and purpose |
| --- | --- |
| `/api/v1/workspaces`, `/{id}` | GET/POST collection; GET/PATCH/DELETE item. Deletion allowed only when empty; no implicit mass erase. |
| `B/events`, `B/sessions` | GET/POST collection; GET/PUT/PATCH/DELETE on `/{id}`. Typed projections of the same canonical store. |
| `B/records`, `B/records/{id}` | GET combined collection/item. Authorized `includeDeleted=true` queries and item reads expose tombstones/current ETags for restore. |
| `B/records/query` | POST a structured read-only query with filters, scope, sorting, cursor, and optional totals. |
| `B/query-snapshots/{id}` | DELETE an owned snapshot handle when no longer needed; changes no canonical record. |
| `B/records/batch` | POST a bounded atomic mixed-record command with expected versions. |
| `B/records/{id}/restore` | POST restore a tombstoned record with concurrency preconditions. |
| `B/sources`, `B/groups` | Collection GET/POST and item GET/PUT/PATCH/DELETE. Sources are JSON-only logical namespaces. |
| `B/schemas`, `B/models` | CRUD for schema/visual-model metadata; versioned definitions and reference-safe retirement. |
| `B/filters`, `B/views` | CRUD for named filters and saved timeline/table layouts with ownership/visibility. |
| `B/settings`, `B/preferences/me` | GET/PUT/PATCH persisted settings; DELETE resets allowed overrides. |
| `/api/v1/settings` | Admin GET/PUT/PATCH/DELETE for mutable application defaults; DELETE resets overrides. |
| `/api/v1/principals`, `/{id}` | Admin GET/POST collection; GET/PATCH/DELETE item. DELETE disables identity and revokes its tokens. |
| `/api/v1/tokens`, `/{id}` | Authorized GET/POST collection and DELETE revocation; one-time token secret on creation. |
| `B/changes`, `B/stream` | GET committed change pages or authenticated SSE stream. |
| `B/imports`, `B/exports`, `B/jobs/{id}` | POST validated jobs; GET authorized status/results; explicit pre-commit cancellation. |
| `B/audit`, `B/backups` | Authorized GET audit; admin POST/GET backups and validated restore workflow. |

Define exact subroutes for version history, publish/archive, backup restore, and job cancellation in the OpenAPI design milestone. Provide all request/response fields, examples, permissions, pagination, limits, and error cases before handler implementation. Expose `/health/live`, `/health/ready`, and `/api/v1/capabilities`; the latter reports supported modes, configured limits, API/storage versions, and read-only/recovery state without secrets.

New JSON source definitions never accept an arbitrary absolute data path or a different storage type. Legacy paths belong only to administrator-controlled migration mappings. Configuration CRUD does not authorize changing server secrets, process identity, filesystem roots, or transport security through the browser.

## 09. API write, error, and retry semantics

**REQ-16 - Predictable HTTP behavior.** GET is read-only. Collection creation returns 201 with Location; structured POST queries return 200; synchronous batch/restore commands return 200; accepted asynchronous jobs return 202 with a status Location. PUT replaces the complete declared mutable representation, including explicit baseline-date fields; PATCH uses JSON Patch with an allowlist and explicit null semantics. Arrays follow the patch contract, not undocumented merges. Record DELETE soft-deletes with 204; settings DELETE resets overrides; definition deletion follows reference/archive rules. Invalid resource kinds on typed routes return 404. [N04, N07]

Every mutable resource returns a strong ETag derived from its generation and server revision. PUT/PATCH/DELETE/restore require `If-Match`: missing preconditions return 428, stale versions return 412, and business/reference conflicts return 409. Batch items carry equivalent expected revisions. Check versions inside the serialized commit boundary, not only when the request arrives. Ordinary reads exclude tombstones and return 404 for deleted item IDs; an authorized trash/includeDeleted read returns the tombstone and current ETag. Restore requires edit/restore capability. Retain schema/model references for restorable deleted records. Do not implement silent last-write-wins.

Require an `Idempotency-Key` for record creation, batches, import commits, and restore operations. Scope keys to principal, generation, workspace, method, and route; hash semantic request content including applicable preconditions and persist the result. After authentication, authorization, and generation validation, check retry identity before current resource preconditions: a completed identical retry replays its original result even when the original If-Match is now stale. A changed request conflicts. Persist pending identity before mutation and recover it after restart. Retain completed keys for at least 24 hours and publish that limit. A pending identical retry returns a documented 202 with status Location; do not duplicate work or replay currently unauthorized sensitive output.

**REQ-17 - Structured failures.** Use `application/problem+json` with type, title, status, detail, instance, stable application code, request ID, and field errors. Do not include secrets or absolute internal paths. Distinguish malformed JSON (400), missing authentication (401), denied permission (403), absent/inaccessible resources (404 under a documented disclosure policy), conflict (409), invalid fields (422), limit violations (413/429), stale preconditions (412/428), and unavailable storage (503). Include Retry-After when applicable. [N05]

Bound atomic batches to 500 affected records and 8 MiB of serialized UTF-8 request data, including cascades. Also cap the complete serialized before/after recovery envelope at 32 MiB; reject excessive expansion before preparation, even for a tiny patch. Validate authorization, schemas, uniqueness, references, and expected versions for every item before any write. A single failed item rejects the whole batch with item-level diagnostics. Larger imports use explicitly non-atomic chunks with a manifest of committed/failed IDs; never describe them as globally transactional.

Define cleanly whether cancellation happened before or after commit. After commit, cancellation cannot erase the mutation; return its committed result. Client disconnects do not imply rollback. Document request/body limits, rate limits, timeout handling, unsupported media types, and retry safety. Provide examples for create, stale edit, ongoing-session close, cascade rejection, batch rollback, and retry after lost response.

## 10. Queries, filters, pagination, and export scope

**REQ-18 - One filter language.** Define a versioned JSON expression tree shared by saved filters, API queries, timeline selection, and table results. Support nested `and`, `or`, `not`; typed equality/inequality, ordered comparisons, `in`, text `contains`, and field existence. Time overlap is a first-class predicate with section 05 semantics. Allow only declared core/custom fields; no SQL fragments, executable JavaScript, filesystem paths, or arbitrary regular expressions.

Specify string matching as Unicode-normalized, case-insensitive contains by default; provide an explicit case-sensitive option. Define null versus missing separately, typed numeric/date comparison, array membership, and stable sorting. Missing values satisfy only explicit missing/existence tests unless the operator's contract states otherwise. Reject mixed-type ordering and unknown fields rather than coercing them unpredictably. Bound expression depth to eight, total predicates to 100, and list operands to 100 values.

Cross-schema queries resolve custom fields through an explicit schema/version scope. A field declared in that scope but absent from a record is missing. Incompatible types under the same field name require a narrower schema predicate; they are not coerced. Evaluate each record independently. Optional authorized ancestors are returned as separately flagged context, excluded from matching counts, exports, and implicit bulk selection. Expanding a parent does not broaden the filter or reveal unauthorized children.

**REQ-19 - Stable result sets.** Use cursor pagination with deterministic requested sort plus ID as the tie-breaker. Default page size is 100, maximum 1,000. Bind opaque/tamper-resistant cursors to generation, workspace, authorized scope, filter hash, sort, and an immutable query snapshot. Retain snapshots for five minutes, with a configurable per-principal limit of four and an initial global retained-memory budget of 256 MiB. Share immutable backing data where possible; reject new snapshots with 429 when capacity cannot preserve active promises. Re-check access on every page. Expiry/restart/restore returns an explicit snapshot-expired conflict, never silent omissions. Later writes, preferences, or job progress do not invalidate an active snapshot.

Clients release superseded snapshot handles after no view/page/export uses them; reference-count shared backing snapshots and invalidate released handles, preventing live refresh from exhausting its allowance. A permission-scope change invalidates affected snapshots in full: deny further pages and require a newly authorized snapshot. Never silently remove rows while retaining old totals/aggregates. Revoked authentication still returns 401/403; a changed but valid scope returns an explicit refresh-required conflict.

Both views either show the same pinned snapshot or refresh together to a new one. In paginated browsing mode, incoming changes show a "new changes available" state without silently changing the snapshot's rows/counts; refresh preserves selection and the nearest stable anchor. In live mode, refresh/reconcile immediately. A local successful edit refreshes both views to a new snapshot. Do not mix old snapshot rows with new totals. Exports also pin a committed snapshot. Demonstrate reaching page ten during five writes/second without endless restarts.

Return items, next cursor, workspace revision, applied scope, and exact total when requested. Counts, group aggregates, and density summaries must use the same predicate/revision as the record result. Never display an approximate or loaded-row count as an exact filtered total. For expensive totals, make the separate/pending state explicit.

The viewport is a rendering/query-loading window, not automatically a user's data filter. Normal default table results reflect the full saved filter; a clearly named Current range mode intentionally adds a time predicate. The Classic blue acceptance fixture explicitly selects Current range in both views. Timeline loaded counts may therefore differ from full table totals, but counts for identical predicates/revisions must match. Exports specify selected IDs, all filtered records, visible range, or explicitly selected search matches; they must not silently export only the loaded page. Search highlighting has a separate result projection under section 39 and must not silently become a destructive global filter.

Offer lossless canonical JSON import/export and a documented legacy JSON adapter. CSV is a tabular convenience export with explicit nested-field flattening, timezone, escaping, and spreadsheet-formula protections; it is not a full-fidelity configuration or data backup.

## 11. Models, configuration, and saved views

**REQ-20 - Separate concepts currently called models.** A data schema defines typed custom fields and validation. A visual model defines bands, lanes, grouping, styles, time scales, overview relationships, camera mode, labels, and legends. A saved view references models, filters, columns, sorting, timezone, and viewport preferences. None is an AI model. The legacy `models/regular_timeline.json` is presentation configuration and must not be treated as a database schema. [S11]

Provide JSON-backed management for data schemas, visual models, saved filters, sources, groups, views, and configurable UI settings. Each has identity, schema/format version, resource revision, name, ownership, and explicit visibility. Validate import/export using the same server validators as CRUD. Duplication generates new IDs and preserves a traceable relationship to the original.

**REQ-21 - Version and reference safety.** Referenced schema/model definitions are immutable definition versions, distinct from mutable resource metadata revisions. Editing produces a new definition version; existing records/views remain pinned until an explicit migration/update. Compatible optional-field additions may use a documented opt-in upgrade; renames, type changes, and required-field additions require impact preview. Publishing a model version is atomic. Reject deletion of versions referenced by active or restorable deleted records/views; permit archival without breaking them. New definitions must not silently invalidate saved filters or columns.

Define settings precedence as application defaults, workspace defaults, visual-model values, saved-view overrides, then personal overrides, with ephemeral interaction state last. Permissions and hard server limits always constrain the result. Per-record rendering overrides permitted style fields, but cannot bypass accessibility rules or authorization. Scalars replace; maps merge by allowed key; arrays replace unless a schema explicitly uses stable keyed members. Distinguish clearing an override from setting a nullable value. Provide a reset-to-inherited action and an effective-settings inspection API.

**REQ-22 - Customization coverage.** Support band sizes/order, overview synchronization, grouping and collapsed state, event/session colors and approved icons, conditional style rules, label fields, font size bounds, time scales/formats, display timezone, current-time indicator, original-time overlays, shading/regions, table column visibility/order/width, typed sorting, and saved query selection. Sanitize URLs/assets and validate contrast-related limits. No arbitrary HTML, JavaScript, remote code modules, or unbounded CSS injection.

Represent shaded regions as versioned visual-model entries with stable IDs, finite start/end, label, band/group scope, visibility, and validated style. They are annotations, excluded from record counts and record bulk actions; document whether a view filter hides their scoped groups. Migrate legacy `zone` records through this map and preserve provenance. Search/selection highlights are transient client styling and never mutate stored `render` overrides. Distinguish legacy grouping named `sortBy` from actual table sort.

Support personal and workspace-shared views/filters. Owners manage personal resources; administrators manage shared defaults. An editor may publish shared resources only with explicit workspace capability. Opening a saved view restores its intended state; switching views does not discard unsaved edits silently. Startup-only settings such as data root, bind address, and secrets are documented separately as read-only effective metadata where safe.

Document which settings persist across refresh/restart, belong to a shared saved view, remain personal, or are temporary. Document URL/share-link behavior if implemented; do not imply that private filters, search terms, tokens or unsaved drafts are automatically shared through a URL. Shared links remain subject to current authorization.

## 12. Timeline experience and interaction

**REQ-23 - A recognizable temporal workspace.** Open directly into actual authorized timeline data or a clear empty workspace. The new default follows the supplied SIMILE structure under section 46: light event area, bottom axes, small labeled markers and duration bars, with a smaller synchronized overview below. Preserve compact legacy menu commands, optional right calendar/descriptor, model-driven grouping and alternate legacy styles. Do not replace the default with a task-table Gantt, calendar, cards, tall product header, permanent navigation sidebar or generic dashboard. Source/group/filter controls live in the compact strip, popovers and settings. Preserve multiple bands, overview navigation, grouping, nested activities, legends, point/session distinctions, original-time overlays, and source-backed cameras.

Provide pan, zoom, fit-to-data/filter, jump to date, jump to selected record, and optional follow-now. Explain the actual range through axis labels. Preserve navigation on resize, sorting, filter edits, and view changes. Fetch overlapping records with a modest buffer and cancel obsolete requests. Avoid background refreshes that unexpectedly jump the user's viewport.

Default to **Navigate** mode: dragging a band, shaded region, or record pans time without changing record dates. This is the core meaning of legacy `ob_setListeners`, not legacy event editing. **Edit** is an explicit, visibly distinct mode enabling authorized record move/resize; changing a model must not enable Edit automatically. Sections 23-24 govern the detailed gesture and lifecycle contract.

**REQ-24 - Real editing workflows.** Provide create, inspect, duplicate, edit, move, resize, delete, restore, and batch actions subject to permissions. Point events can move but cannot resize into sessions implicitly. Finite sessions can move/resize with documented snapping; ongoing sessions have an explicit close action and no fabricated end handle. Dragging a parent does not move children without a separate command. Precise forms and keyboard controls must be available for every mutation.

Show draft, saving, saved, conflict, and failure states. Prefer optimistic previews with clear pending status; reconcile with server-normalized records on success and restore the prior confirmed state on rejection. Preserve the user's draft during conflicts and show changed fields; require an explicit reapply against a new revision. Undo/redo creates compensating version-checked writes, never rewrites history or silently overwrites another user's work. Define its bounded session history and deletion/restore behavior.

Resolve overlapping/dense records with deterministic reusable tracks and full rendered-footprint allocation under section 38, including complete text, icons, baseline graphics and focus/selection decorations. True temporal overlaps remain unchanged in JSON. Extra logical tracks are exposed through server-driven vertical pages in a fixed-height main timeline under section 48; do not grow the webpage indefinitely or download all records to hide them locally. One permanent task row per event is not the default model. Explicit legacy internal scrolling may remain a compatibility setting, but cannot substitute for mandatory row pagination. Labeled overview summaries at extreme zoom must offer access to their actual members. Provide empty, loading, malformed-data, disconnected, read-only, recovering, and permission-denied states that preserve useful content.

Keyboard navigation, focus management, screen-reader record access, touch alternatives, reduced motion, and non-color status cues are mandatory. Target applicable WCAG 2.2 AA criteria with automated and manual checks. On narrow screens, use one primary view plus accessible details and deliberate horizontal scrolling; do not shrink a desktop timeline into unreadable controls. Canvas/WebGL content needs an accessible equivalent through the table and inspector. [N06]

## 13. Table, selection, and shared state

**REQ-25 - A working table, not a report screenshot.** Provide Timeline, Table, and resizable Split modes; the legacy-facing selector may label Timeline as Gantt. Share the legacy shell, calendar/descriptor, reference time and selection. At widths at least 1440 px, Split hides the calendar by default and divides available content 60% Gantt / 40% Table around a 6 px divider; at 768-1439 px it stacks Gantt above Table, and below 768 px it uses tabs. Derive columns from core fields and pinned schemas: title, kind, start, end/ongoing state, derived duration, source, group, parent, status, tags, custom fields, and optional ID/version. Format missing/not-applicable values distinctly. Provide column visibility/order/resize, typed sort, filters, details, inline edits, and authorized bulk actions. Section 35 specifies the Classic blue table geometry and styling.

| Concern | Required shared behavior |
| --- | --- |
| Identity | A row and timeline item reference the same workspace/record ID and server version. |
| Selection | Selection survives view switching and pagination. Filter-hidden IDs are indicated; revoked/deleted IDs are marked unavailable and sensitive cached content is removed. |
| Navigation | Selecting a row highlights its item when loaded; an explicit reveal action loads and navigates to its time. Selection alone need not jump the viewport. |
| Filters/counts | Identical predicates at an identical revision produce identical IDs/counts. Distinguish all-filtered totals from viewport-loaded counts. |
| Edits | Both views issue the same validated command and show its pending/result/conflict states. No page reload is needed. |
| Sorting | Table sort does not unexpectedly reorder timeline lanes or reset the viewport. |
| Parent/children | Tree/group presentation preserves relationships; selecting a session is not implicit selection of every child. |
| Refresh | Merge by ID/version, remove tombstones, discard stale responses, and preserve drafts/selection. |

Virtualize large result sets without making inaccessible rows the only path to a record. Support keyboard focus across virtualization boundaries. Keep row dimensions stable with long titles/custom fields and expose full values through accessible details.

Explicitly distinguish "select this page", individual selected IDs, and "all matching records". A bulk action is bound to the displayed query/revision, previews its exact scope, and revalidates on commit. If it exceeds the 500-record atomic limit, require an explicit job/chunk workflow or reject it with actionable detail. Never mutate an unbounded result set because a header checkbox was ambiguous.

Provide copy/export actions with the scope rules from section 10. A saved view stores column and grouping preferences through the API. Browser memory may cache UI state, but confirmed event/session persistence always comes from server JSON files; reload must demonstrate durable results.

## 14. Live updates and reconnection

**REQ-26 - Publish committed changes.** Provide authenticated Server-Sent Events with a polling fallback using `B/changes`. Each transaction envelope carries workspace ID, generation, monotonically increasing revision/sequence, transaction ID, and a bounded `changes` array of operation, resource type/ID, and version. Clients apply the complete authorized group atomically before recomputing results, or receive an invalidation envelope requiring requery if the payload is too large. Transport delivery is at least once; clients deduplicate. Include configuration/filter/model changes as well as records.

Use a snapshot-then-resume handshake: query results identify a committed revision, then the client consumes changes after that revision. Subscribe/replay must cover the interval between snapshot and subscription. Never subscribe only to records currently matching a filter without a membership-change strategy: records can enter or leave the result set when edited. Notify the authorized workspace and re-evaluate affected queries safely.

Retain replay history of at least 10,000 transactions or 24 hours, whichever requires more history. Bound disk growth through capacity planning, quotas, compaction of older eligible history, and refusal/backpressure on new writes when retention cannot be met; do not silently shorten the promised window. If a change cursor is expired, invalid, or from a restored generation, return an explicit full-resynchronization signal. A fresh snapshot replaces stale cached state while preserving drafts. Follow the pinned-versus-live display rules in section 10.

**REQ-27 - Failure behavior.** Reconnect with bounded exponential backoff and jitter, support heartbeat/idle detection, and show connection/save state. Do not enqueue offline writes automatically in the initial release. Users may retain an in-memory draft while disconnected, but saving requires reconnection and revision validation. Polling fallback has the same ordering and authorization rules as SSE.

Authenticate the stream with the same opaque bearer token through a header-capable SSE client; do not add a separate login/session store. Do not place bearer tokens in URLs. Permission revocation closes/restricts active streams, invalidates affected caches, and prevents unauthorized resource disclosure. A principal permitted to see only part of a workspace must not receive IDs or payloads from the rest.

On server restart, reconstruct replay positions from durable committed JSON history. Backpressure must be bounded: slow clients disconnect and resume or resynchronize rather than growing an unlimited queue. Delete/restore ordering, duplicate messages, missed revisions, stale query responses, and simultaneous local/remote edits all require integration tests.

## 15. Authorization, configuration safety, and operations

**REQ-28 - Server-enforced permissions.** Provide viewer, editor, and administrator roles with explicit workspace/resource capabilities. Viewers read authorized records/views; editors create/update/delete records and manage their personal views; administrators manage sources, shared configuration, identities, backups, and migrations. Audit/export access is explicit and must not leak hidden fields. Never trust a role, username, `userAccess`, or ownership field submitted by a client as proof of permission.

The first release uses opaque high-entropy API tokens with server-side hash verification and an administrator bootstrap secret supplied through environment/secret configuration. Principal metadata, capability grants, expiry/revocation state, and token hashes persist as protected root JSON documents. Show new token secrets once; token listing exposes metadata only. Principals may list/revoke their own tokens; admins create identities and issue scoped tokens with explicit expiry (default 30 days). Rotation creates a replacement then revokes the old token. Bootstrap works only for an uninitialized root and must not leave a permanent universal token. Keep browser tokens in memory, not URLs or durable browser storage; logout clears them. Disabling a principal/revoking a token immediately blocks further requests and streams. No external identity service or cookie-login system is required.

Restored token records remain disabled. Issue fresh credentials through a documented local administrator recovery procedure before exposing a restored service. Restoring an older root must never reactivate a revoked token or reopen network bootstrap. Preserve principal IDs/ownership metadata while re-establishing current access. Backup/restore API jobs prepare and validate inactive roots; activation remains an offline operator action.

**REQ-29 - Validate real boundaries.** Apply the same permissions to API, import/export, batch commands, audit, and streaming. Constrain CORS/origins and request sizes; rate-limit expensive reads and writes. Safely render user labels, descriptions, links, icons, imported metadata, and error details. Prevent mass assignment, prototype pollution, path traversal, symlink/reparse-point escape, arbitrary file access, and script/HTML injection. Resolve all storage paths under validated internal roots using server-generated names.

Provide a sanitized effective-configuration endpoint and validation preview. Runtime UI changes cannot alter storage roots, TLS keys, trusted origins, executable paths, or identity bootstrap secrets. Reject unsupported storage types at schema validation and startup. Keep JSON data directories and backups out of static hosting and deployment images.

**REQ-30 - Practical operations.** Provide clean startup/shutdown, readiness after recovery, restricted logs, correlation IDs, and metrics for reads/writes, queue depth, conflicts, file count, index rebuild, disk space, stream clients, and backup age. Do not expose record payloads or credentials by default in logs. Back up data and configuration together with versions/checksums; document encrypted storage/backup options without embedding secrets.

Support Windows local development and a Linux container with a persistent local volume and one writer. Document platform-specific guarantees and actual tests. Startup errors must identify unavailable storage, permission problems, unsupported format, or competing writer clearly. Restore/purge are administrator operations with previews; normal DELETE remains recoverable. Never copy bundled legacy private keys into a new deployment.

## 16. Import, migration, and preservation

**REQ-31 - Explicit compatibility map.** Supply adapters for actual legacy JSON formats discovered at the pinned commit: `events` collections, the illustrative `session` envelope where applicable, flat records, and genuine nested activities. Do not persist synthetic frontend singleton wrappers as duplicate activities. Preserve stable legacy identifiers through an import mapping table; canonical new IDs are UUIDs. Detect collisions per source/workspace and report them before commit.

Map `data.title`, start/end/original dates, domain metadata, per-record render values, grouping, and nested activity relationships. Keep raw unknown metadata under namespaced extensions. Migrate visual models, overview bands, source definitions, saved filter names/grouping, and allowed UI preferences separately from records. Record every unsupported setting or unsafe value in a migration report. [S03-S06, S11]

Legacy include/exclude/filter expressions require parsing into the new typed expression tree. If equivalence cannot be established, mark the filter as needing review and preserve its original text; do not silently broaden it to ALL or execute legacy expressions as code. Placeholder database definitions, connector credentials, and permission strings do not become new runtime configuration. External database migration, if later requested, must arrive as an offline JSON export; the new application does not connect to those stores.

**REQ-32 - Dry run first.** Analyze input without mutating it; report file/record counts, checksums, IDs, inferred kinds, relationships, date conversions, invalid JSON, unsupported fields, and collisions. Invalid syntax is rejected with location information. An optional repair step must produce a separate reviewed artifact and an explicit change log; never repair a source file silently. Imports use strict canonical validation after transformation.

Assign an import ID and stable row mapping so retries after restart cannot duplicate records, including sources without IDs. Normal imports generate canonical IDs with a stable mapping and rewrite internal references; duplication also generates new IDs. Explicit canonical restore preserves IDs/server metadata into an empty isolated target and assigns a new workspace generation. Lossless round-trip claims apply to this restore mode; normal import preserves payload meaning with documented identity remapping and new audit fields. Default collision policy is reject; updates require explicit mapping and expected versions. Commit small imports atomically; large imports publish chunk results and a resumable manifest. Conditional rollback affects only untouched imported versions and reports records subsequently edited.

Inventory date-derived descriptor sidecars and merge/reference their content by stable legacy ID so changing dates cannot orphan descriptions. Preserve `data.text` separately from description and resolve conflicting namespace fields explicitly. Translate legacy source/group names to stable IDs; never fan one create operation out to every configured source. [S12-S13]

Keep originals and verified backups. Compare normalized before/after IDs, timestamps, relationships, metadata, render intent, and filter result sets using representative fixtures. Require JSON export/import round trips and restore drills. Compatibility means preserving meaningful data and supported behavior; it does not mean reproducing invalid JSON, unescaped HTML, silent write failures, or incomplete connectors.

## 17. Performance targets and supported scale

**REQ-33 - Measurable starting targets.** The following are proposed release targets, not measured legacy results. Freeze the benchmark environment and targets before implementation tuning. Any justified change must be recorded with its effect; do not quietly weaken targets after a failure. JSON-only storage remains mandatory regardless of scale.

Reference environment: one 4-core/16-GiB machine with local SSD, one server process, production frontend build, local network, current supported desktop Chromium, and 1440x900 viewport. Record exact OS, filesystem, CPU, browser/runtime versions, fixture checksum, network latency, cache state, and repeat count. Test Windows/NTFS and Linux/local container volume separately for storage behavior.

| Scenario | Initial acceptance target |
| --- | --- |
| Typical fixture | 100,000 records, 100 groups, nested activities, dense overlap and mixed historical/ongoing data; average serialized record <=2 KiB. |
| Cold readiness | Recovery-free startup and index rebuild <=30 seconds for the typical fixture. Crash recovery measured separately by journal size. |
| Visible data query | Warm p95 <=300 ms for a 1,000-record page, supported indexed predicates, no optional full-result export. |
| Single-record save | End-to-end local API durable commit p95 <=300 ms at five aggregate writes/second. |
| First useful workspace | <=3 seconds to interactive visible data after readiness for Uniform or an already prepared layout. Cold Adaptive overview/status <=3 seconds; complete global Adaptive preparation p95 <=10 seconds for the typical fixture. A status-only screen is not completed detail. |
| Pan/zoom and table scroll | p95 frame time <=33 ms during a fixed 10-second trace with <=2,000 visible primitives; no repeated >200 ms main-thread stalls. |
| Shared updates | Uniform confirmed live display and every update/stale notice p95 <=1 second from commit. Adaptive warm coherent replacement p95 <=3 seconds after eligible idle, cold preparation <=10 seconds; measure separately from geometry-only hysteresis. Pinned browsing remains notice-only until refresh. |
| Concurrency/memory | 20 connected clients, five writers within the aggregate rate; server RSS <=2 GiB for the typical fixture; no sustained growth after repeated cycles. |

Also test 1,000-record small and 1,000,000-record stress fixtures, explicitly labeling the stress tier unsupported until measured. Include long sessions overlapping many dates, long labels, sparse custom fields, deletions, corrupt indexes, and update bursts. A directory of one million files is a cost to measure, not a scalability claim.

Profile parsing, index construction, overlap filtering, disk flushes, serialization, client state, and rendering. Use viewport culling, level-of-detail aggregation, table virtualization, incremental updates, bounded caches, and workers when measurements justify them. Exact complex-filter totals and large exports may run as jobs; disclose their latency. Never fabricate before/after performance or conceal data omission behind a faster rendering result.

## 18. Acceptance scenarios: data and API

**REQ-34 - Requirements map to executable tests.** The following are minimum future acceptance scenarios. During the present prompt-only task, they are specifications and are not claimed as executed application tests.

| ID | Scenario and required outcome |
| --- | --- |
| A01 | Create an event and a finite session through the API; reload/restart; the same IDs, values, versions, and relationships remain in valid JSON files. |
| A02 | Import empty-end legacy records; they become points, while explicit new ongoing sessions remain durations. Nonempty malformed dates are rejected/quarantined. |
| A03 | Query `[10:00,11:00)`; a 09:00-12:00 session matches, a session ending at 10:00 does not, and a point at 11:00 does not. |
| A04 | Exercise DST gap/fold, offset conversion, equal endpoints, original dates, historical dates, and sub-millisecond input; results follow section 05 exactly. |
| A05 | Two clients edit version 7; one succeeds as version 8, the other receives 412 and retains its draft. No update is silently lost. |
| A06 | Kill the process at every transaction boundary; recovery yields the old complete state without a commit marker or the new complete state with one, never a mixed batch. |
| A07 | Inject disk-full, permission and replacement failures; no false success is returned, acknowledged data remains recoverable, and diagnostics identify the failed operation. |
| A08 | Retry creation/batch after a committed write loses its HTTP reply and after restart; one mutation exists and the stored result is replayed. Changed retry payload returns 409. |
| A09 | Submit a batch with one invalid/stale/unauthorized item; no item is committed and field/item errors identify the cause. |
| A10 | Delete a parent with children; default deletion conflicts. Explicit bounded cascade and restore commit atomically and preserve IDs. |
| A11 | Remove/corrupt cached JSON indexes; rebuild returns the same query IDs/counts, including sessions crossing date boundaries. |
| A12 | Start a second writer or modify a live file externally; the service refuses competing writes or freezes the affected workspace without silent overwrite. |
| A13 | Reach page ten under continuous writes using one snapshot without duplicate/missing rows; changed query, expired snapshot, or restore generation fails explicitly. |
| A14 | Attempt cross-workspace reads/writes, forged roles, traversal, unsafe imports, and stream access after revocation; access is denied consistently. |
| A15 | Inspect installation, runtime services, filesystem artifacts, and dependencies; events/sessions use only ordinary JSON files and memory, with no hidden database/broker. |

Use deterministic fixtures, fixed seeds for generated/randomized cases and controllable clocks. Include valid/invalid leap-year dates as well as DST and interval boundaries. Verify stored documents with a strict independent JSON parser, inspect record versions and transaction state, and assert API status/body contracts. Storage tests must use real temporary filesystems as well as fault injection; mocks alone do not prove atomic replacement or process locking.

## 19. Acceptance scenarios: UI and operations

| ID | Scenario and required outcome |
| --- | --- |
| A16 | Create/edit/delete/restore from either view; both views reconcile the same canonical records and confirm durable state after reload. |
| A17 | Switch Timeline/Table/Split; filter, selection, timezone, and intended viewport survive. Identical predicates/revisions yield equal IDs/counts. |
| A18 | Sort the table and navigate to an unloaded selected row; timeline lanes remain stable and explicit reveal loads the correct event. |
| A19 | In explicit Edit mode, drag/resize with snapping and keyboard alternatives; stale writes conflict; moving a parent does not silently move children. In default Navigate mode, the same record drag pans time and issues no record mutation. |
| A20 | Save personal and shared views/models/filters, restart, and reset overrides; precedence, ownership, versions, and effective settings match section 11. |
| A21 | Try an incompatible schema change or delete a referenced model/group/source; validation blocks it until an explicit migration/reassignment. |
| A22 | Drop, duplicate, reorder, and expire live notifications; clients deduplicate/requery/resynchronize without losing a committed edit or stale deletion. |
| A23 | Import representative valid/invalid legacy fixtures, resume after interruption, export, and re-import; mappings, unknown metadata, and counts are audited without duplicates. |
| A24 | Create a backup during writes and restore it into an isolated root; all documents/configuration/checksums agree at one committed revision. |
| A25 | Exercise long labels, dense overlaps, empty/error/loading/recovery states, narrow screens, keyboard-only use, focus and screen-reader access. No inaccessible canvas-only mutation remains. |
| A26 | Run section 17 benchmarks and repeated open/filter/close/reconnect cycles; publish measured results, resource cleanup checks, and any target misses. |
| A27 | Follow README from a clean checkout; build/start/test commands work with a local JSON directory and no database installation. |
| A28 | Export selected/all-filtered/visible-range records; the declared scope is honored across pagination, with safe CSV formatting and lossless canonical JSON. |
| A29 | Match a child whose parent is filtered out; show authorized ancestor context separately, excluded from totals/export/bulk selection. Validate mixed-schema field/null rules. |
| A30 | Preserve overview/band synchronization, grouping versus sort, original-time overlays, approved styles, tolerance metadata, and declared camera behavior through migration/edit/reload. |
| A31 | Save/reload/export/import shaded regions, and process a point parent with genuine activities; annotation counts and aggregate quarantine/mapping follow their explicit contracts. |
| A32 | Restore a backup then retry an old-generation edit; reject it. Revoke credentials and run concurrent users with different filters; verify request isolation and zero cache/stream leakage. |

**REQ-35 - Honest verification.** Add unit tests for time, validation, filter semantics, references, and state transitions; integration tests for JSON recovery, APIs and synchronization; browser tests for real workflows; and visual/accessibility checks for representative screens. Test actual Chrome/Edge/Firefox where available and document Safari/WebKit/mobile coverage precisely. An automated accessibility scan alone is not WCAG conformance evidence.

Report commands, environment, test totals, outcomes, artifacts, benchmark distributions, and manual checks. Distinguish passed, failed, skipped, blocked, and not run. Fix discovered defects and rerun affected tests. Do not claim zero defects or complete performance compliance merely because a screenshot looks polished or a narrow test passed.

Release acceptance requires every mandatory requirement and A01-A74 to pass in the declared supported scope, plus the mapped fine-grained companion audit tests and the integration gates under section 50. Extend A22 to a multi-record cascade/batch and prove neither view briefly exposes a partial transaction. Unresolved mandatory failures mean the implementation is incomplete, even if a demonstration can run. Optional deferred features must remain clearly identified in documentation and must not appear as working controls.

## 20. Delivery milestones after authorization

**REQ-36 - Incremental implementation.** This section activates only after the user explicitly requests application implementation. Work in `openbexi_timeline2.0`, preserve the legacy baseline, and maintain decision/requirement records as evidence changes. Do not ask again about routine choices already resolved by this specification; document any genuinely blocking conflict before dependent work.

| Milestone | Deliverable and gate |
| --- | --- |
| M0: audit and contracts | Complete source/feature inventory, listener/track/menu/search matrices, model coverage manifest, all 17 legacy-brief pages, runtime observations if possible, architecture decisions, storage protocol, schemas and OpenAPI. Review the five current SIMILE targets and both primary references, retaining the eight earlier compatibility targets and three older evidence images. Freeze adaptive mapping, zones, row-page contracts and integration gates; no unresolved JSON-only, authorization or compatibility conflict. |
| M1: JSON vertical workflow | One real event/session workflow from API to durable JSON to Timeline and Table. Include restart, invalid input, and stale-write tests before broad UI expansion. |
| M2: reliable management | Full CRUD, relationships, bounded batches, recovery, audit, authorization, imports, backup and restoration. Pass core storage/API scenarios. |
| M3: configurable workspace | All model families, schemas, shared filters, saved views, structured/JSON model editing, validation, preview, publication, reference-safe upgrades, synchronized edits and full table workflows. Both shipped visual models and capability fixtures must import, render, save and round-trip. |
| M4: live experience | SSE/polling, reconnect, SIMILE two-band navigation, full-filter density and local magnification, zones, server row pages, accessible editing, responsive layouts and visual regressions. |
| M5: release verification | Execute and pass section 50's test/integration gates before code delivery: migration round trips, real JSON fault/restart tests, clean setup, all acceptance scenarios, measured benchmarks, support limits and final evidence. |

Each implementation milestone M1-M5 must remain runnable and have a short evidence report; M0 produces reviewed contracts and discovery evidence. A mock-data screenshot is not completion of a storage/API milestone. Do not postpone correctness until after visual polish. Fix failed mandatory gates before claiming the next dependent milestone is complete.

**REQ-37 - Documentation deliverables.** Author project documentation in Markdown. Keep README practical: purpose, supported platforms/versions, installation, configuration, startup, local URL, sample JSON data, authentication bootstrap, backup warning, test commands, and links to detailed guides. Detailed documents cover source audit, architecture decisions, data/time schema, JSON storage/recovery, API, filtering, configuration precedence, user workflows, development, testing, performance, migration, backup/restore, deployment, troubleshooting, and requirements traceability.

During implementation, provide native OpenAPI and JSON Schema artifacts as machine-readable specifications, linked from Markdown. Preserve licenses/attribution, maintain a changelog, and document schema/API/storage version compatibility. Provide reproducible fixtures and test reports. No placeholder routes, fake persistence, unfinished required controls, example secrets, or database installation instructions belong in the delivered release.

Run formatting, linting, applicable type/static analysis, unit/integration/browser tests and the production build through documented commands and CI. Provide contribution guidance covering the development workflow, test expectations and change review. Verify both source policy and user permission boundaries. Treat skipped/unavailable checks explicitly, not as passes.

## 21. Decisions, exclusions, and prompt handoff

The following are deliberate design defaults for this revision, not claims about the legacy implementation. They remove ambiguity while keeping implementation choices evidence-driven.

| Decision | Rationale / boundary |
| --- | --- |
| JSON-only event/session persistence | Explicit user constraint; not negotiable through framework choice or scaling optimization. |
| JSON-backed configuration/audit/jobs | A database-free deployment with one recovery/backup approach; non-JSON static assets and secret configuration remain allowed. |
| Single server writer / local disk | Practical cross-file transaction and locking scope. Multiple API users remain supported. |
| Unified typed records / session children | Retains point/duration distinctions and genuine nested activities without duplicating records. |
| Ongoing sessions are explicit | Prevents empty legacy end fields from silently changing meaning. |
| Soft delete / bounded atomic batches | Recovery and predictable failure semantics without unbounded distributed transactions. |
| REST + SSE / polling fallback | Complete management plus committed updates without a required broker. |
| Versioned schemas/models and typed filters | Controlled customization and shared timeline/table meaning. |
| Framework/renderer choice deferred to M0 | Must follow source evidence, accessibility, maintenance, and measured behavior rather than an arbitrary stack mandate. |
| No automatic scheduling/recurrence engine | Preserve metadata/visual behavior; add these product capabilities only under a later explicit request. |

The source-only audit leaves legacy runtime behavior, installation viability, real throughput, and exact renderer tradeoffs unverified. These are M0/benchmark tasks, not invented facts or reasons to weaken mandatory requirements. Runtime/library versions and platform-specific locking/flush mechanisms must be verified when implementation begins. No mandatory product choice currently requires a new user answer to finish this prompt.

**Prompt-only completion gate.** Deliver this revised Markdown and a matching, visually checked PDF with eight embedded design screenshots and the three supplied evidence screenshots. Preserve the original brief, the newly supplied 17-page legacy PDF and revisions 2.0/2.1; include all companion audits, exact fixture/visual rules and evidence provenance. Confirm that no application code was produced. Remove instructions that could trigger implementation during refinement, including the older brief's immediate-implementation handoff. Do not describe the specification or mockups as proof that the future application is already correct.

**Later implementation completion gate.** Deliver runnable code, verified JSON storage, complete API/configuration management, synchronized timeline/table workflows, migration/backup tools, test results, benchmarks, and documentation only after implementation authorization. Evaluate completion against requirements and acceptance scenarios, not against the presence of files alone.

## 22. Worked contracts and traceability

These are specification examples, not application code. M0 must encode them in the native schemas/OpenAPI and add complete request/response examples before handlers are written.

| Example | Required interpretation |
| --- | --- |
| Point creation | Title "Telemetry received", kind `event`, start `2026-09-12T14:00:00.000Z`, end null, default JSON source. A successful create returns 201, Location, generated UUID, version 1, generation, and ETag. |
| Duration creation | Title "Observation window", kind `session`, start `2026-09-12T14:00:00.000Z`, end `2026-09-12T14:30:00.000Z`. Duration is 30 minutes, calculated rather than separately editable. |
| Ongoing/parented record | The same session with null end is explicitly ongoing. An activity is a separately stored point/session with that session's ID as parent; it is not duplicated in a stored child array. |
| Filter expression | An internal node has `op` equal to `and`/`or` and `args` children; `not` has one `arg`. A leaf has `op`, an allowed JSON Pointer `field`, and typed `value`/`values` when needed. Example meaning: status equals STARTED AND priority is at least 2, restricted to the declared schema scope. |
| Query request | Contains filter version/tree, source/schema scope, optional overlap window, ordered sort fields/directions, page limit, optional cursor, and includeTotal. Returns 200 with items, snapshot ID/revision/generation, nextCursor and declared totals. Reject cursor/query disagreement. |
| Stale update | The client submits an allowed patch with a valid generation and an old ETag. Return 412 problem details with code `record_version_conflict`, request ID and a safe current-version reference; do not apply any patch operation. |
| Replay | The original idempotency key and identical request replay the prior result within retention, after authorization/generation checks and before stale original If-Match rejection. |

The built-in filter leaf operator names are `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `in`, `contains`, and `exists`. `exists` accepts a boolean and distinguishes missing from explicit null. Empty `and`/`or` groups and `in` lists are rejected. A top-level null filter means all authorized records; clearing a saved filter is an explicit action. Typed equality to null matches explicit null only. These rules must be identical in API, UI, migration tests and exports.

| Requirement coverage | Minimum proof |
| --- | --- |
| REQ-01-06 | Source/dependency/architecture review; A01, A12, A15, A27, A32. |
| REQ-07-14 | Schemas and storage/recovery design; A01-A12, A23-A24, A31-A32. |
| REQ-15-19 | OpenAPI and query contracts; A03-A05, A08-A10, A13-A14, A28-A29. |
| REQ-20-27 | Configuration and shared UI/live state; A16-A22, A25, A29-A31. |
| REQ-28-32 | Auth/operations/migration; A14-A15, A23-A24, A27, A31-A32. |
| REQ-33-37 | Recorded benchmarks, all acceptance scenarios, runnable milestones, clean setup and documentation audit. |
| REQ-38-39 | Target-by-target listener and lifecycle tests; A33-A36, A43-A44. |
| REQ-40-42 | Model coverage manifest, all template/capability fixtures, management API and reference safety; A37-A41. |
| REQ-43 | Eight legacy-aligned design targets, supplied visual evidence and later browser comparisons; A25, A42, A45-A46. |
| REQ-44-48 | Complete brief/geometry/fixture coverage, compact menu, full-footprint packing and search projections; A45-A56 and companion layout/menu/search tests. |

Expand this map to per-requirement implementation paths and executable test IDs during implementation; scenario IDs alone do not prove coverage of every clause.

## 23. Legacy listener compatibility

**REQ-38 - Preserve interaction meaning, correct unsafe quirks.** Trace the complete `OB_TIMELINE.prototype.ob_setListeners` function at source lines 4232-4521, not merely its name. Inspect `move_band`, `sync_bands`, object construction/picking, descriptor opening, clock, scene updates and destruction. The implementation registers Three.js DragControls over scene objects; descendant picking is also relevant. There is no record-date assignment, REST save, or session resize in this listener. [S15-S16]

| Target / trigger | Audited legacy effect | Mandatory successor behavior |
| --- | --- | --- |
| Drag start | Stops the instance clock and selected scene's movement; saves the object's X coordinate. | Resolve target first, then capture pointer, mode, scene and initial state. Only an actionable gesture pauses enabled follow-now; locked/ignored hits do not. Cancel prior navigation motion. |
| Detail/overview band drag | Moves band X, preserves Y/Z, synchronizes other bands in that scene and shows the marker. | Uniform legacy centered bands preserve their scale and synchronized time. The SIMILE default follows section 47's fixed overview domain and moving detail-window highlight using its common mapping/inverse. No canonical writes or unrelated-instance movement. |
| Shaded region drag | Restores region-local position and transfers horizontal delta to its parent band. | In Navigate mode, pan time; annotation dates remain unchanged. Region editing is a separate explicit model-editor action. |
| Point, icon or session-bar drag | Restores child-local coordinates and transfers delta to the parent band. | In Navigate mode, pan time without modifying start/end, original dates, parent links or record versions. |
| Detail record release | Synchronizes bands and opens descriptor, even after a drag. | A click/tap selects and opens the inspector; a genuine pan does not open it accidentally. Preserve explicit inspect/reveal commands. |
| Overview record release | Repositions its parent, reveals markers and returns before the common release path. | Click/tap recenters the linked detail band on the record start and keeps its selection; a drag remains a pan. Update marker/calendar coherently and do not force an inspector open. |
| Group label/activity enclosure with `sortBy === "true"` | Resets coordinates and returns. | Non-draggable structural targets do not pan or edit. Explicit expand/collapse controls remain independently operable. |
| Other text/unrecognized target | Restores its coordinates; release may still run common date/motion logic. | Text associated with a record resolves to its stable record target. Decorative/unrecognized objects do nothing. |
| Normal release | Updates displayed date/calendar, renders and starts displacement-derived movement. | Complete or cancel one well-defined gesture, update date once coherently, and apply optional bounded inertia only for navigation. |

Distinguish click from pan using CSS-pixel movement, independent of device pixel ratio: proposed defaults are 4 px for mouse/pen and 8 px for touch, measured as maximum distance from pointer-down. Movement at or beyond the threshold is a drag. Expose validated sensitivity settings, not arbitrary handler code. A click selects without a write. Long press must not be the sole route to any command. Wheel/pinch zoom stays anchored to a declared pointer/center instant; prevent browser scrolling only while the timeline owns the gesture.

For Uniform fixed-duration scales only, let `s = millisecondsPerUnit / intervalPixels`. A band's center instant is `syncTime - bandX * s`; synchronized bands satisfy `otherBandX = draggedBandX * draggedScale / otherScale`. These positions and the legacy `intervalPixels` setting use model-coordinate units, not necessarily CSS pixels. Dragging content right exposes an earlier center time. With legacy HOUR/1000 and DAY/1000 model-unit bands, a 10-unit overview movement corresponds to 240 units in the hour band and a 14 min 24 sec earlier center. A34 remains this Uniform compatibility oracle. Adaptive mode instead uses the continuous mapping and inverse in section 47; never use one milliseconds-per-pixel ratio across a magnified boundary. Test screen-to-model conversion separately under both cameras and device scales. Calendar units use actual calendar boundaries, not the legacy 31-day approximation.

In Edit mode, only authorized record targets and visible handles alter a draft. Empty/background regions still pan; locked labels remain locked. Escape/pointer cancellation reverts an uncommitted draft and never saves. A successful release saves through the normal version-checked command; a rejected edit preserves the draft and confirmed geometry separately. Switching mode, view, camera or model cancels an active gesture rather than committing it accidentally.

These are intentional corrections, not missing compatibility: suppressing the post-pan inspector, repairing undefined point/icon origin coordinates, replacing object-name regular expressions with typed interaction metadata, correcting overview recentering, and replacing inconsistent displacement timers with tested motion. Record each correction in the legacy comparison report. Do not preserve a defect just to reproduce pixels.

## 24. Interaction lifecycle and isolation

**REQ-39 - Stable scenes and cleanup.** Maintain at most one active interaction controller per canvas. Mount, redraw, resize, camera switch, data reload, model switch and unmount must have explicit ownership and disposal for listeners, DragControls, timers, animation frames, pointer capture, observers, GPU resources and requests. Rebinding must dispose the old controller first. Source allocation of multiple scenes does not prove complete isolation: legacy nested band objects and instance-level synchronization/clock state can be shared.

Use per-instance state and per-scene navigation state with an explicit synchronization group. Linked detail/overview bands share time, not mutable configuration objects. Deeply isolate editable model state. Two mounted timelines can use the same immutable published model while retaining independent viewport, filters, selection, drafts and animation. No singleton handler may edit another workspace or instance.

Replace the legacy 5 ms movement intervals with elapsed-time, bounded animation-frame motion based on recent release velocity. Honor reduced motion, expose an off switch, and stop on new input, blur, hidden document, permission loss, unmount or explicit cancel. A genuine manual pan/zoom/recenter leaves follow-now paused at the chosen viewport until explicit resume. A non-navigating click or cancelled pre-navigation gesture restores the previous follow-now state; locked/ignored hits never pause it. Cancelling after navigation has changed the viewport keeps the chosen position and remains paused. Never enable follow-now merely because a timer restarted.

Handle pointer-up outside the canvas, pointer-cancel, lost capture, touch cancellation and window blur without stuck drag state or accidental saves. Ignore stale asynchronous responses using instance/query/generation identity; maintain the existing viewport while new data loads. Reload only when the buffered interval is genuinely exhausted. Fix the legacy broad OR threshold and type-dependent release dispatch rather than generating repeated loads during every small movement.

| ID | Additional acceptance scenario |
| --- | --- |
| A33 | Exercise background, detail/overview band, shaded region, duration bar, point, icon, record text, group label and activity enclosure targets. Assert target-specific behavior and zero record/annotation writes in Navigate mode, including unchanged versions after reload. |
| A34 | Prove the 10 model units / 240 model units / 14 min 24 sec synchronization example; test screen-to-model conversion under both cameras/device scales, zoom anchors, overview recenter, timezone/calendar labels, navigation direction and resize. |
| A35 | Test below/at/above mouse and touch thresholds, click versus pan, inspector opening, explicit Edit, disabled editing and snapping. Test pointer cancellation, lost capture, blur and mode/model/camera changes without unintended commits. |
| A36 | Repeatedly mount/redraw/switch models and cameras/unmount 100 times; verify one controller per active canvas, zero after disposal, no surviving timers/requests, and no monotonic resource leak beyond a documented bounded cache. |
| A43 | Mount two instances with the same model and different workspaces/filters. Pan, inspect, edit and preview independently; verify no viewport, configuration, data or permission leakage. Test linked scenes separately. |
| A44 | With deterministic clocks, test inertia on/off, reduced motion, follow-now resume/cancel, buffer boundaries and stale responses. No 5 ms busy loop, endless query churn, viewport jump or record mutation occurs during navigation. |

The existing historical source image is visual evidence only. M0 must attempt controlled legacy execution before claiming observed gesture parity; blocked execution is reported honestly. The source-derived compatibility tests remain mandatory even when that comparison is unavailable.

## 25. All-model coverage contract

**REQ-40 - All families, not only the default.** Support every model family and source-consumed model capability at the pinned baseline, including valid user-customized variants. The two standalone visual models have the same basename but different content: `models/regular_timeline.json` and `tests/models/regular_timeline.json`. Import them as distinct identities, retaining source path, checksum and provenance. Do not merge or overwrite them by filename. The two HTML entrypoints reference these templates; they do not establish additional inline visual models. [S11, S14]

| Legacy family | Required canonical treatment |
| --- | --- |
| Visual `params` + `bands` templates | Versioned visual models with stable band IDs, explicit detail/overview roles, validated parameters, styles, scales, camera and source bindings. |
| Per-band `model[0].sortBy` | Typed grouping field path and lane-order policy, independent of table sorting. Preserve missing/null/array-value semantics explicitly. No `eval`. |
| Runtime field/value `Map` named model | Schema-aware field catalog with type, label, allowed operators, provenance and paginated authorized value discovery. Do not persist transient Maps as authored models. |
| `json/event_or_session_model.json` | Informal data template/envelope adapter; preserve domain fields and relationships through canonical records and versioned custom-field schemas. It is not a visual model. |
| Four tracked saved-filter JSON files | Import default, guest and test identities separately; split mixed source, filter, grouping, camera and personal-setting concerns into explicit resources. Owner mapping is reviewed, not trusted from filenames. |
| YAML source `data_model` | Legacy JSON directory-template mapping used only by offline migration. Runtime sources remain logical namespaces with immutable ID-derived record paths. No database adapter is retained. |
| Record `render`, assets and descriptors | Validated rendering overrides, approved asset references and declarative inspector layouts. Preserve provenance; replace evaluated descriptor scripts with safe field-based layouts. |

The exhaustive property inventory in `docs/legacy-model-compatibility.md` is part of discovery, not optional reading. At minimum, cover the following authored properties, their actual consumers, defaults, precedence and explicit migration disposition:

| Surface | Required property inventory |
| --- | --- |
| Timeline parameters | `name`, `date`, `timeZone`, `title`, `data`, `data_default_port`, `data_sse_port`, `camera`, `descriptor`, `top`, `left`, `width`, `height`, `backgroundColor`, `color`, `fontSize`, `fontFamily`, `fontStyle`, `fontWeight`. |
| Band identity/layout/time | `name`, `height`, `x`, `z`, `depth`, `width`, `multiples`, `trackIncrement`, `intervalPixels`, `intervalUnit`, `intervalUnitPos`, `dateFormat`, `subIntervalPixels`, `model`. Separate authored intent from recalculated geometry. |
| Band styles | `color`, `textColor`, `dateColor`, `SessionColor`, `eventColor`, `sessionHeight`, `defaultEventSize`, font size/family/style/weight, `texture`, `image`, `textBackgroundColor`, `defaultSessionTexture`, `luminance`, `opacity`. Preserve case-sensitive import names. |
| Group definition | `sortBy`, declared-but-unconsumed `alternateColor`, and any additional raw array entries with diagnostics. |
| Record rendering | `color`, `textColor`, font size/family/style/weight, `backgroundColor`, `image`, `texture`, `luminance`, `opacity`, `textBackgroundColor`. Do not conflate the two background keys silently. |

Published models must never contain scene caches, object coordinates from a drag, derived tick data, sessions fetched for rendering, GPU objects or mutable layout Maps. Preserve authored layout intent separately from viewport-derived width/height/positions. Apply precedence from section 11, and display each effective value's origin in the editor. Loading a model must not overwrite its authored title/source binding with a hardcoded report name or discovered URL.

The source consumes only `params[0]` and `band.model[0]`; retain additional entries in import provenance and require explicit mapping, not silent discard. Similarly, declared-but-unused `alternateColor`, `defaultSessionTexture`, and unforwarded opacity/luminance do not prove legacy effects. Define validated new equivalents where meaningful; otherwise retain the raw value with a precise review diagnostic. Textures currently trigger a hardcoded cubemap, not arbitrary texture-path loading. Use approved assets, show missing-asset errors and require a chosen replacement; do not silently substitute the default model or unsafe remote content.

Cover MILLISECOND, SECOND, MINUTE, HOUR, DAY, WEEK, MONTH, YEAR, DECADE, CENTURY and MILLENNIUM within the supported date range. EPOCH/ERA are negative source sentinels with no verified usable scale: preserve their raw definition and block activation pending an explicit supported mapping. Unknown units/formats produce diagnostics, not fallback-to-hour behavior. Map every recognized legacy date-format string from the companion inventory, preserving 24-hour meaning where legacy `hh` is used; correct zero-based months, inconsistent padding and decade/century-label defects. Implement explicit UTC/IANA-zone formatting instead of pretending legacy arbitrary-zone support existed.

M0 produces a machine-readable compatibility manifest with a row for every shipped template, family and inventoried property/capability: stable ID; pinned source/path/lines/checksum where applicable; evidence type; canonical destination; preserved/corrected/mapped/retained-unresolved/excluded-safety disposition; diagnostic; fixture IDs; import/render/edit/save/reload/export tests; and current test status. Count total, mapped, unresolved, excluded and verified rows separately. Zero unclassified rows is mandatory; zero unresolved activation blockers is required for each activated model. Never claim all models passed merely because the manifest exists. Prohibited connectors remain explicit safety exclusions, not features to reintroduce.

## 26. Improved model management

**REQ-41 - A complete authoring workspace.** Provide Model Library, structured editor, validated JSON editor, preview, diagnostics, version history, semantic diff and publication review. The library supports search, type, owner, tags, status, version, source provenance, reference counts and archived items. Include visual models, data schemas, field catalog and source mappings as distinct views. Create, duplicate, import, export and archive are real workflows, not placeholder toolbar buttons.

The structured editor covers bands, lane grouping/order, time scales/formats, camera, styles and conditional rules, original-time overlays, regions, table columns and inspector layouts. Use stable keyed IDs when reordering. Expose every supported field through a structured control or a discoverable advanced panel and validated JSON editor. Both editors operate on the same draft and server validator; changing editor mode loses no fields. Field errors include location and explanation, and invalid JSON never replaces a previously valid published definition.

Draft preview is isolated from active saved views and canonical records. It can use authorized live data or a named deterministic fixture, with clearly separate preview query/selection state. Preview Timeline, Table and Inspector, including narrow screens and both camera modes. Cancel preview restores the previous effective settings exactly and writes no record or publication. Draft save persists only the draft resource through the normal concurrency protocol.

Publication review shows semantic property changes, before/after previews with the same data/time, affected filters/columns/assets, compatibility warnings, and every referencing view. Publishing creates one immutable definition version. Updating references is a separate explicitly selected bounded transaction: do not silently upgrade all consumers. Offer a combined publish-and-upgrade command only when the complete declared operation fits the transaction limits and commits atomically. Larger upgrades are separately acknowledged chunked jobs, with the publication retained even if a later chunk fails. Restoring an older appearance selects its retained version or publishes a new version; it never rewrites history.

**REQ-42 - Model-management API parity.** In addition to resource CRUD, define the following routes for `R = B/models` or `B/schemas`. All writes use the generation, ETag, permission, journal and audit rules already specified. Read-only validation/preview/diff requests must not advance canonical resource versions.

| Route | Contract |
| --- | --- |
| `R/{id}/drafts`, `R/{id}/drafts/{draftId}` | POST draft from a specified version; GET/PUT/PATCH/DELETE owned draft with strong concurrency controls. |
| `R/{id}/versions`, `R/{id}/versions/{version}` | GET immutable version history/definition; publishing creates versions, not PUT/PATCH on a published version. |
| `R/{id}/validate`, `R/{id}/preview`, `R/{id}/diff` | POST read-only bounded validation, effective-definition/data preview and semantic comparison. Declare version/draft inputs and authorization scope. |
| `R/{id}/publish` | POST with draft ETag and idempotency key; create immutable version, optionally upgrading an explicitly listed bounded set of view references with expected versions. |
| `R/{id}/references`, `R/{id}/references/upgrade` | GET paginated authorized usage/impact; POST explicit version-checked upgrade command. Incompatible schema upgrades require a migration plan/job. |
| `R/{id}/archive`, `R/{id}/restore` | POST metadata lifecycle changes with current ETag; referenced versions remain readable. Permanent deletion is allowed only when all reference/retention constraints permit it. |
| `B/model-packages/imports`, `B/model-packages/exports` | POST jobs with manifest, stable ID/reference remapping, checksums, version compatibility and declared approved assets. Preview import diagnostics before commit. |
| `B/field-catalog`, `B/field-catalog/values` | GET typed authorized field metadata and paginated, scope-aware distinct values. Values must include missing/null semantics and never leak another source/workspace. |
| `B/views/{id}/effective-settings` | GET resolved configuration with value origins, pinned definition references, applicable limits and resource revisions. Never expose secrets. |

Keep package definitions and authoritative import manifests in ordinary JSON. An optional archive is a transport wrapper for JSON and approved static assets, not a new store; validate paths, hashes, expanded size and references before extraction/commit. A definition-only export is self-describing and explicitly lists external dependencies. Import collisions offer explicit create-copy or version-checked replacement, never basename overwrite. Reuse the same server contracts from the UI, CLI and external clients.

| ID | Additional acceptance scenario |
| --- | --- |
| A37 | Import both shipped visual templates as distinct models; render all bands, navigate, edit supported configuration, save/reload/export/re-import and compare canonical meaning. Exercise every source-consumed capability through representative custom variants. No default-model fallback or silent field loss. |
| A38 | Test all inventoried properties and recognized date formats, all valid units and cameras, arbitrary permitted grouping fields, long/custom field names, missing/null/array values, assets, source bindings and descriptor replacement. Verify precise diagnostics for every ambiguous/ignored/unsafe input. |
| A39 | Edit a draft through structured and JSON editors, switch between them, validate and preview across all views, cancel and reopen. Published versions, active references and record bytes/versions remain unchanged until the appropriate explicit commit. |
| A40 | Two authors edit/publish the same draft; stale operations conflict. Publish v2 and upgrade only two of five references; three remain pinned to v1. Invalid/stale/unauthorized selections reject the entire bounded combined command. |
| A41 | Import/export a package with ID collisions, dependencies and missing assets; preview mappings, cancel, then commit explicitly. Test archive/restore/deletion protections and incompatible schema/filter/column impact. Assert ordinary JSON persistence and audited counts. |

## 27. Visual design and screenshot contract

**REQ-43 - Legacy-aligned visual targets.** Embed all eight proposed PNG screenshots and all three user-supplied evidence screenshots in both Markdown and PDF. The proposed images are static document mockups, not implemented controls, application tests, migration results or measured performance. The supplied screenshots are user evidence; the historical repository image has separate attribution. Preserve those distinctions in captions and future comparisons.

The 17-page legacy brief governs the optional Classic blue compatibility composition, not revision 2.3's default. Preserve its metallic toolbar, grouped blue bands, type gutter, thin bars, glyphs, reference marker, calendar/descriptor and Table shell when this model is selected. The new SIMILE reference and five current targets in sections 46 and 52-58 take precedence for the default. Orthographic remains the default camera. Do not reinstate revision 2.1's tall header/permanent left sidebar. Dark/neutral and custom models remain first-class alternatives; a new default does not erase their capabilities.

Two deliberately separate deterministic fixtures are pictured. Classic blue uses the exact 14-record 18 May 2021 fixture from section 36, with EVT-004 selected and reference time 15:00. Legacy dark uses 40 synthetic records, 20 per SOURCE1/SOURCE2, on 18 March 2024, window 17:00-21:00, reference time 20:00 and overview 00:00-24:00. Its Activity 5_1 records match aliases SOURCE1-14/SOURCE2-14; Activity 0_3 matches SOURCE1-05/SOURCE2-05. This dark fixture demonstrates the supplied behavior; it does not claim to reconstruct every record in the user screenshots.

Classic screenshots use 1600 x 900 CSS pixels; dark stress screenshots use 1600 x 1000 to keep their activity labels readable. All are captured at device scale 2. Their fixture data is supplied in `docs/ui/v2.2/design-fixtures.json` as specification data, not an application store. Aliases map to canonical UUIDs through an explicit fixture adapter. Actual implementation must additionally pass 1280, 1024 and 390 px widths, 360/768 px boundaries and wide desktops, with the responsive rules in section 35. The strict 2 CSS-pixel geometry tolerance applies to the Classic blue reference fixture, not arbitrary customized models.

| ID | Additional acceptance scenario |
| --- | --- |
| A42 | Capture real browser screenshots for all eight target states with their declared fixtures and clocks. Compare legacy shell, geometry, selected IDs, table/count equality, descriptor, source regrouping, label collisions, yellow matches and findings-only overview. Add expanded details, model editors, loading/empty/stale/error/conflict/read-only, narrow screens and both cameras. Attach visual diffs and functional evidence; report justified deviations. |

The eight states do not exhaust required screens. CRUD forms, trash/restore, filters, schema/source/group/settings management, model drafts/previews/diffs/publication, import diagnostics, permission states and accessible alternatives remain mandatory. Retain the useful model-authoring workflows specified in section 26, but adapt their entry points and styling to this legacy shell. The archived revision 2.1 model-editor images are historical workflow sketches, not authority to restore its dashboard-like main screen. Future verification screenshots must come from the actual application.

## 28. Visual target: Classic blue Gantt

V01 - Proposed design mockup. Exact 14-record legacy-brief fixture; type0/type4/type1 bands; Navigate mode; EVT-004 selected without changing its teal fill or Nominal metadata; Monday-first calendar; reference marker at 15:00; overview contains the same 14 records at their real times. Bar coordinates follow the text contract rather than inconsistent illustrative pixels in the older PDF.

![V01 proposed Classic blue Gantt with legacy toolbar, calendar and overview](docs/ui/v2.2/ui-classic-gantt.png)

## 29. Visual target: Classic blue Table

V02 - Proposed design mockup. Same shell, date, filter, type order, 14 records and selected EVT-004. Full Table hides the Gantt overview. Group counts are 6/4/4; duration values, glyphs and colors follow the exact fixture. Selection is independent of source status and keyboard focus.

![V02 proposed Classic blue Table with shared calendar and selected record](docs/ui/v2.2/ui-classic-table.png)

## 30. Visual target: Classic blue Split

V03 - Proposed design mockup. At 1600 px, the calendar is hidden by default and the remaining content is divided 60/40 around a 6 px separator. Both views retain the same selection and records; the narrower table intentionally scrolls horizontally, with identity columns pinned in the implementation. No tiny-font shrink-to-fit substitutes for accessible content.

![V03 proposed side-by-side Gantt and Table with legacy shared toolbar](docs/ui/v2.2/ui-classic-split.png)

## 31. Visual target: Dark timeline and descriptor

V04 - Proposed design mockup. Forty synthetic records from two sources share a dark timeline with activity tracks and light overview. Selecting SOURCE2-02 opens its descriptor on the right, including original/current dates, source metadata and the full title. Raw legacy tolerance is labeled, not silently assigned invented units.

![V04 proposed dark legacy timeline with selected activity descriptor on the right](docs/ui/v2.2/ui-dark-descriptor.png)

## 32. Visual target: Filter-driven source grouping

V05 - Proposed design mockup. The same dark fixture is regrouped by source through view/filter configuration, showing SOURCE1 on a dark band and SOURCE2 on a neutral band. Record IDs and dates do not change. Grouping, source predicates, table ordering and model colors remain separately manageable. The optional descriptor is closed here; overview visibility is an independent view setting.

![V05 proposed source-grouped legacy timeline using the same forty records](docs/ui/v2.2/ui-dark-grouped.png)

## 33. Visual target: Search for 5_1

V06 - Proposed design mockup of the supplied search behavior. Detail retains all 40 records. Exactly two Activity 5_1 labels receive yellow backgrounds; overview contains only those two matching records, not their unmatched parents or siblings. Search results do not edit stored rendering metadata.

![V06 proposed search for 5_1 with yellow text backgrounds and two overview findings](docs/ui/v2.2/ui-search-5_1.png)

## 34. Historical visual reference

The following image is copied from the pinned legacy repository's documentation, not captured from a legacy execution during this audit. It illustrates the neutral timeline/overview presentation and is not one of the eight successor design targets. Its data differ from both new design fixtures. Preserve upstream attribution and applicable license notices. The supplied 17-page legacy PDF additionally preserves the blue original reference and its illustrated proposed Gantt/Table figures. [S17, S18]

![Historical OpenBEXI Timeline repository screenshot, supplied legacy documentation](docs/ui/v2.1/legacy-reference.png)

The detailed source audits distinguish intended compatibility, source defects and proposed improvements. Screenshots alone cannot establish gesture behavior, configuration coverage, CRUD durability, performance or accessibility.

## 35. Complete brief and Classic compatibility baseline

**REQ-44 - Preserve the complete 17-page brief.** Revisit every page and numbered requirement of `OpenBEXI_Timeline_Rebuild_Prompt_legacy.pdf`, SHA-256 `814e8bb6ff57845d6b46092345fed08409e7d452903ad9f27e9f14e9ddcba697`. This is distinct from the earlier seven-page archive. The [coverage matrix](docs/legacy-brief-coverage.md) records all 17 pages, figures and 58 review items; the [visual contract](docs/legacy-visual-contract.md) preserves the full geometry, tokens, calendar, table, responsive and fixture rules. Every retained item must map to implementation/tests before release. Revision 2.3 scopes the exact blue geometry and scalar transform below to the optional Classic model with Uniform scale; they are not the SIMILE default or an Adaptive-map oracle.

Precedence is explicit: current user constraints and this specification override the older brief's immediate implementation command, optional/non-JSON database possibilities, incomplete CRUD qualifications and ambiguous time boundaries. The older brief's exact text/fixture overrides its illustrative pixels. Retain visual continuity and all source-backed models; correct security defects, inaccurate geometry and raw-regex/color-based search membership. Do not silently declare missing requirements optional.

| Region at 1600 x 900 CSS pixels | Required geometry and tokens |
| --- | --- |
| Main toolbar | x=0, y=0, w=1600, h=56; silver-to-blue-gray gradient #D3D8DF to #6C8A9C; 40 x 40 desktop hit areas and 24-28 px toolbar icons. |
| Filter strip | x=0, y=56, w=1600, h=56; source, type/group, range, zoom, Fit, Now, explicit Reload, Navigate/Edit and connection state. Extras use overflow before clipping. |
| Timeline and side pane | Timeline x=0, y=112, w=1304, h=620. Right calendar/inspector x=1304, y=112, w=296, h=740. |
| Ruler and plotting domain | Ruler y=112..152. Gutter x=0..88, plot x=100..1292. Major ticks x=100, 398, 696, 994, 1292; 15-minute minor ticks. |
| Classic bands | type0 y=152..400; type4 y=400..604; type1 y=604..732. Alternating #A6D7F8 / #99BFD3; gutter #82A9BF. Larger logical layouts use bounded row pages; legacy internal scrolling is an explicit compatibility setting. |
| Overview and footer | Overview x=0, y=732, w=1304, h=120, neutral #D9DBDE, covering 00:00-24:00 UTC for the fixture. Footer x=0, y=852, w=1600, h=48. |
| Record geometry | 10-12 px duration bars, square/1 px corners; 32 px reference track pitch; 12-16 px point glyphs with at least 24 px desktop interaction targets. |
| Text and selection | Body/event text 14 px, tick text 13 px, type labels 22 px. Labels normally 8 px after the bar; alternate placement/extra tracks avoid clipping. Selection uses a 2 px #168BFF outline with 2 px gap, retaining fill and glyph. |

At this viewport, use `x(t) = 100 + 1192 * ((t - 13:00) / 240 minutes)`. EVT-004 is x=720.83..919.50, with a reference/playhead pin at x=696 for 15:00. The reference marker is not necessarily Now. A separately labeled Now marker is shown only where meaningful; it must not move the reference time or create false elapsed progress. Adapt screen-to-model coordinates for the camera without confusing these acceptance CSS coordinates with legacy scene units.

Full Table preserves the same shell and right-pane boundary and hides the overview. Controls occupy y=112..164; header y=164..208. Group headers are 32 px; Comfortable rows 34 px and Compact rows 28 px. The 14-row Comfortable fixture ends at y=780; pagination occupies y=780..852. Column widths are checkbox 44, ID 112, Type 92, Event 440, Start UTC 148, End UTC 148, Duration 132, Indicator 188: exactly 1304 px. Keep checkbox/ID sticky under deliberate horizontal scrolling; resizing/hiding/reordering has a restore-default action.

Table rows alternate #FFFFFF / #F0F8FD with #C8DDEA grid; group headers #C8E8FA; selected row #DCF1FF with checked box and 3 px #168BFF left rule; hover #E8F5FF and focus a distinct 2 px ring. Use tabular numerals, 14 px text and 10 px cell padding. Initially group in type0/type4/type1 order and sort by start then ID within each group; offer an explicit ungrouped mode. Collapse preserves counts/selection. Use HH:mm:ss with a visible date/zone caption for single-day data, and YYYY-MM-DD HH:mm:ss with wider columns/horizontal scrolling for multiple dates. Current range and All matching have explicit shared scope semantics under sections 05/10; point End displays a dash, point duration zero, unknown duration a dash.

The optional white calendar is Monday-first with May 2021/18th selected for the fixture, a #27B8F5 selected-day circle and an independent Today outline. Calendar navigation preserves window span and selected record, flagging an out-of-range selection. Below it, show selected ID/full title/type/start/end/duration/indicator and Open details. The right descriptor exposes full authorized fields in a 360 px drawer or accessible dialog; Escape closes and restores focus. The dark model may show the descriptor directly in the right pane, as supplied evidence demonstrates. Read-only policy disables writes without hiding inspection.

At 1200-1599 px keep the layout flexible and move lower-priority toolbar controls into overflow. Below 1200 px collapse the calendar to a drawer. Below 768 px use compact controls, a Filters popover, full-width view tabs and at least 44 px touch targets. Split uses the 60/40, 6 px divider and breakpoint rules in section 13. Retain the shell during loading; empty results keep axis/headers and reset actions; disconnected data is marked stale with last-successful time and retry; validation/save failures retain the draft.

Require static reference geometry within 2 CSS px at 1600 x 900, allowing font antialiasing differences. Test 1280/1024/390 widths and boundary transitions separately. Record tokens, implemented component rules and justified departures in `docs/ui-spec.md`. Exact example dimensions do not justify hardcoded event positions, clipping other datasets, or inaccessible contrast in customized themes.

## 36. Authoritative Classic blue fixture

**REQ-45 - Preserve fixture identity and geometry.** These are the 14 synthetic acceptance records from page 17 of the legacy brief. Date 18 May 2021, UTC; visible range 13:00-17:00; reference time 15:00; initially select EVT-004. Ten finite durations map to canonical sessions and four explicit points map to events with null end. The legacy word event in a general UI caption does not erase the canonical distinction. Aliases are fixture/external IDs mapped deterministically to UUIDs; indicator metadata maps through an explicit schema/adapter, never through selection state.

| Alias | Type | Title | Start UTC | End UTC | Duration | Indicator | Color |
| --- | --- | --- | --- | --- | --- | --- | --- |
| EVT-001 | type0 | Antenna allocation | 13:10:00 | 14:15:00 | 01:05:00 | Planned | #253C78 |
| EVT-002 | type0 | Orbit propagation | 13:35:00 | 15:10:00 | 01:35:00 | Running | #4C7900 |
| EVT-003 | type0 | Command preparation | 14:00:00 | 14:50:00 | 00:50:00 | Complete | #601654 |
| EVT-004 | type0 | Telemetry downlink | 15:05:00 | 15:45:00 | 00:40:00 | Nominal | #008A80 |
| EVT-005 | type0 | Station handover | 15:30:00 | 16:20:00 | 00:50:00 | Linked | #986015 |
| EVT-006 | type0 | Archive transfer | 16:00:00 | 16:50:00 | 00:50:00 | Warning | #486A85 |
| EVT-007 | type4 | Data validation | 13:15:00 | 13:55:00 | 00:40:00 | Complete | #674E8F |
| EVT-008 | type4 | Packet decode | 14:10:00 | 15:20:00 | 01:10:00 | Running | #006969 |
| EVT-009 | type4 | Quality review | 15:25:00 | 16:10:00 | 00:45:00 | Planned | #16833F |
| EVT-010 | type4 | Report build | 16:15:00 | 16:45:00 | 00:30:00 | Planned | #8A511C |
| EVT-011 | type1 | AOS | 13:10:00 | - | 00:00:00 | AOS | #008535 |
| EVT-012 | type1 | Sync | 14:15:00 | - | 00:00:00 | Sync | #2056BC |
| EVT-013 | type1 | Warning | 15:20:00 | - | 00:00:00 | Warning | #E79915 |
| EVT-014 | type1 | LOS | 16:50:00 | - | 00:00:00 | LOS | #C82620 |

Exactly these 14 records appear in the fixture overview, located from their timestamps, not decorative marks scattered across the day. Counts are type0=6, type4=4, type1=4. Preserve original colors/glyph semantics in both views and display Nominal separately from EVT-004 selection. Viewport culling or collapsed groups do not change the base total.

The writable acceptance sequence changes EVT-004 end to 16:00, yielding duration 00:55:00 and endpoint x=994, then reloads to prove JSON persistence and restores the initial fixture. Use isolated test data, expected versions and explicit Edit/form commands; default Navigate dragging cannot perform this edit. Record original start/end separately and retain them unless the command explicitly changes those fields.

## 37. Compact menu and descriptor continuity

**REQ-46 - Preserve command coverage and placement.** Trace menu construction and each actual handler, not icon filenames or assumptions. The [menu/search audit](docs/legacy-menu-search-audit.md) records that the power/start-stop assets are connection/account state, not playback, and the circular-arrow legacy control invokes go-to-current-time rather than a general reload. Preserve both behaviors with accurate accessible names; an explicit Reload command is a recommended separate addition. [S20]

| Legacy position / command | Required successor meaning |
| --- | --- |
| Left: connection/account | Show connection/account state and authorized account actions. Do not turn this into an invented simulation play/pause switch. |
| Calendar | Show/hide calendar and date navigation. Preserve optional calendar state across saved-view reload. |
| Legacy circular arrow | Go to current time/recenter. Keep it distinct from Reload and from enabling continuous Follow now. |
| Filter/group control | Open source predicates, named filters and grouping configuration. Filter and grouping changes can produce the alternative arrangement demonstrated by user evidence. |
| Search icon and field | Submit the declared search grammar with Enter or the icon; expose clear, match count, next/previous match and search mode without moving essential controls out of reach. |
| Center report time | Reflect the active report/reference time and display zone; distinguish pinned/reference time from live Now. |
| Right: Gantt/Table/Split | Compact extension of the legacy shell. Shared filter/search/selection state survives view changes. |
| Overview eye | Show/hide the overview independently of grouping, search or inspector. Reopening uses the current correct scope. |
| 2D/3D camera | Switch source-supported cameras with equivalent picking/selection/navigation and no data mutation. |
| Settings and help | Reach models, fields, styles, table columns, preferences and contextual help. Settings cannot expose secrets or execute user scripts. |

Recommended additions stay in the compact secondary strip or overflow: explicit Reload, Navigate/Edit, undo/redo, save view, model draft/library access, search next/previous and fit-to-matches. Show state and tooltips; keyboard access and focus order follow the visible order. No required legacy command is lost at responsive widths, hidden behind an unlabeled icon, or rendered as a fake working control.

Selecting a detail record opens or updates the right descriptor with stable ID, full label, original/current dates, duration, source/namespace, schema fields, status, description and allowed edit actions. Preserve legacy field visibility through safe declarative inspector models. Filter changes can hide the selection but must identify that state instead of substituting a different record. Overview click/recenter keeps the section 23 activation policy; explicit inspect remains available. A genuine pan does not accidentally open a descriptor.

## 38. Track allocation and text collision safety

**REQ-47 - No unintended visual overlap, including labels.** Analyze `get_first_free_tracks`, `get_room_for_session`, their callers and text measurement before implementing the replacement. The [layout audit](docs/legacy-layout-audit.md) records the complete chain, a source-derived busy-track counterexample, inconsistent text measurement and an overview reservation scale defect. The functions express an intent to pack sessions/activities, not a proven guarantee that every legacy image is collision-free. [S19]

Real overlaps in record time are valid data and must remain unchanged. Layout only assigns screen tracks and label positions. For each independently rendered item, compute its actual projected bar/point/icon geometry plus resolved label ink bounds, padding, parent/enclosure boundaries, original-time/tolerance graphics when displayed, and selection/focus outlines. Use the effective post-precedence font, weight, style, size, multiline layout and device/camera transform; wait for font readiness and invalidate measurements when assets/fonts change. Do not estimate complete label width only from character count or the band's default font.

Maintain a typed occupancy model per band/group and test the complete intended track block before assigning a parent and its activities. Never accept the first apparently large gap without checking all occupied tracks and descendant extents. Use stable record IDs and deterministic tie-breaking; preserve reusable prior positions where they remain valid to minimize reflow. Group sorting, record sorting and track packing are separate concepts. Require at least 4 CSS px clearance between unrelated visible footprints, with a separately bounded measurement epsilon of at most 0.5 CSS px, not an overlap allowance. Also prevent a label from crossing its own start icon or bar unless an explicit inside-label style reserves sufficient space; left-side placement must account for the icon before the bar.

Bar times stay fixed. Resolve a collision by allocating another logical track, placing a label on a valid alternate side, or reserving a taller row for explicitly supported multiline text. Prefer complete labels; controlled ellipsis is a last resort under a declared model overflow/expanded-label policy, with visible keyboard-accessible full text plus focus/hover and descriptor access. Do not silently omit labels or records to report zero overlaps. Long unbroken strings, labels longer than the viewport, large approved fonts and icons must have a readable expanded path without painting into the gutter/calendar or changing dates. Section 48 exposes excess rows through server pagination; bounded local overflow for one tall item is not permission to increase the whole webpage or silently drop tracks.

Nested structural containment is intentional: an enclosure may contain its own child bars, and a record's selection/focus ring may surround its own geometry. Declare those relationships so tests do not mistake them for collisions. They do not excuse one child's text crossing a sibling or unrelated bar. Invisible enlarged interaction targets may overlap only with deterministic accessible target resolution; visible marks still obey the layout contract.

Recompute or validate occupancy after filter/group/model/font changes, zoom, camera changes, resize, child expansion, search highlight padding, selection, edits and live updates. Culling uses full display bounds, so a relevant offscreen bar whose label is onscreen is not incorrectly omitted. In dense overview modes, overlap may be represented by explicit counts/clusters rather than readable individual labels; drill-down must reveal exactly the represented members, and search mode excludes all nonmatches from those aggregates. Do not reuse a detail-band text width with an incorrect overview scale multiplier.

Verification must inspect actual projected/rendered rectangles and full accessible text, not only mocked allocator output or screenshots. Exercise empty tracks, occupied positive/zero/negative legacy coordinates, multi-track parents, touching intervals, deeply nested activities, point/icon-only records, offscreen-spanning sessions, baseline overlays, varied fonts, search backgrounds, both cameras and randomized dense fixtures. No navigation or allocation test may change canonical dates, original dates or versions.

## 39. Search highlights and findings-only overview

**REQ-48 - Preserve the supplied search behavior safely.** The third attached screenshot visibly demonstrates a `5_1` search, yellow Activity 5_1 labels and a sparse findings-only overview. The user additionally requests `0_3`; it is a separate required test/example, not a second visibly evidenced input in that same image. Source inspection confirms contextual detail plus narrowed overview, but legacy code uses mutated rendering colors and raw regular expressions to determine matches. Replace those mechanisms without losing the interaction. [S20]

Let `C` be the authorized base result after source/schema scope, saved structured filters and the explicitly chosen time-scope policy, at one generation/revision. Let `M` be the IDs in C matching the active search. In ordinary contextual search, the detail timeline retains C and only matching label backgrounds become #F8DF09 with contrasting #111 text. Search, selected state, hover and focus remain independent. Yellow authored styles must never determine membership in M. The overview shows only M while search is active, including correctly scoped density summaries; unmatched parents, siblings and enclosure graphics must not reappear as data.

An overview axis, reference marker and viewport window are navigation chrome, not search findings, and may remain. During search, a current nonmatching selection stays in the inspector with an explicit outside-results indication but is not forced into the overview. No-match search leaves detail context intact and the overview data layer empty with zero matches. Clearing search removes only the transient match overlay, restores authored styles exactly and returns overview data to its normal declared C scope. Do not alter stored `render`, record versions, model definitions or status to highlight results.

Default search uses case-insensitive Unicode-normalized literal terms over title, description and explicitly declared searchable scalar fields. Any term is the legacy-like default: whitespace/semicolon separates terms outside double quotes, quoting preserves a phrase and empty terms are discarded. Within quoted text, backslash may escape a double quote or backslash; reject invalid escapes and unterminated quotes. Offer explicit All terms and Phrase modes with a documented versioned grammar; Phrase treats the trimmed input as one literal phrase without term splitting. Underscores and regex characters are literal; `5_1` and `0_3` are not wildcard patterns. Do not search arbitrary serialized JSON, secret fields, raw executable regex or another workspace. Bound input to 512 characters and 20 terms; validate malformed quoting with an actionable error.

Search spans the declared authorized query scope, not just currently loaded detail objects. Bind query text, grammar/mode, field/schema scope and time policy to the same snapshot/generation contract as records; return explicit `baseTotal`, `matchTotal`, match IDs/page cursor and match-field metadata. Do not mislabel loaded matches as the total. Large results remain paginated; overview density/marks and next/previous navigation must use the same predicate/revision. Obsolete responses are discarded. A new search does not pan/zoom automatically; next/previous/reveal and Fit matches are deliberate commands. The normal overview domain remains stable unless explicitly fitted, and out-of-domain findings remain discoverable through counts/navigation.

Table defaults to contextual C with the same label highlight and selection. Its explicit Matches only toggle projects M and displays both base and match counts. Turning search into a persistent structured filter is a separate confirmed action. Export/bulk selection explicitly chooses selected IDs, C under the active scope, or M; a search highlight alone cannot silently narrow an existing batch/export. Ancestor context stays separately flagged and never counts as a match or automatically joins a matches-only mutation.

Extend the structured query/overview contracts with a read-only, versioned search specification and `context`/`matches` projection, rather than introducing a second search authority. Search/overview/field-catalog endpoints enforce the same authorization and JSON-backed/in-memory index boundaries. Recompute results coherently after explicit query/view changes and according to section 10's pinned-versus-live policy for incoming changes: pinned browsing retains old C/M rows, overview and counts together until an allowed refresh; live mode and successful local edits refresh the shared snapshot. Preserve drafts, selection and viewport, and apply permission invalidation immediately. Search-state persistence is an explicit saved-view preference, never a record write.

| ID | Additional acceptance scenario |
| --- | --- |
| A45 | Classify every item in the 17-page legacy brief and 58-item coverage matrix, including previously omitted CI/contribution/source-policy and visual requirements. Link each retained item to implementation and tests; all exclusions follow current user constraints. |
| A46 | Load the exact Classic blue fixture at 1600 x 900: geometry within 2 CSS px, counts 6/4/4, x=720.83..919.50 for EVT-004, reference x=696, correct calendar/overview/table. Edit end to 16:00, obtain duration 00:55:00/x=994, reload durable JSON, then restore. |
| A47 | Exercise every legacy menu command, accurate account/go-now/Reload meanings, overview toggle, filter regrouping, settings and descriptor. Repeat at responsive widths; no command disappears or silently changes behavior. |
| A48 | Reproduce allocator busy-track, font-override and overview-scale counterexamples from the layout audit. Replacement layout prevents unrelated bar/point/text collisions without changing record times, dropping IDs or hiding full text. |
| A49 | Stress actual rendered footprints across long/unbroken/multiline labels, large fonts/icons, nested activities, model/group changes, pan/zoom/cameras, resize, selected/search styles and live edits. Confirm deterministic logical tracks, bounded pages/explicit item overflow and no unintended intersection; never unbounded webpage growth. |
| A50 | Search `5_1` in the 40-record fixture: C=40 and M={SOURCE1-14,SOURCE2-14}; exactly two yellow labels and two overview data records. Detail remains contextual and no unmatched parent/sibling enclosure appears in overview. |
| A51 | Search `0_3`: C=40 and M={SOURCE1-05,SOURCE2-05}. Repeat in blue/neutral/custom models using equivalent fixtures; retained metadata, colors, model versions and selection are unchanged. |
| A52 | Test no matches, clearing, authored yellow backgrounds, missing render, permission-hidden fields, Unicode, literal regex punctuation, Any/All/Phrase grammar and malformed input. No crash, color-based false match, unauthorized disclosure or persistent styling mutation. |
| A53 | Search beyond loaded detail rows under live writes and changing filters/sources; overview results, counts, next/previous and paginated matches share the right snapshot. Reject stale responses and generation mismatch without viewport jumps. |
| A54 | Switch contextual/matches-only Table, select filtered-out records, export C versus M, and invoke bulk actions. Verify explicit scopes, base/match counts, stable IDs, ancestor exclusions and consistent detail/overview semantics. |
| A55 | In both blue and dark models, inspect activity/event/session details, original/current fields and metadata on the right. Test calendar open/closed, expanded drawer, Escape/focus restore, read-only sources, failed saves and selection hidden by a new filter. |
| A56 | Restore all menu/filter/group/search/overview/model/descriptor preferences after reload where declared; verify ephemeral state remains ephemeral, no executable configuration, no unsupported connector, and no cross-instance/workspace leakage. |

## 40. Visual target: Search for 0_3

V07 - Proposed design mockup for the user's additional requested search. The same 40-record fixture retains its detail context, highlights exactly two Activity 0_3 labels and shows only those two records in the overview. This is a new design/test example, not a claim that the supplied third image displayed that query.

![V07 proposed search for 0_3 with exactly two highlighted labels and overview findings](docs/ui/v2.2/ui-search-0_3.png)

## 41. Visual target: Filter and model access

V08 - Proposed design mockup. Filters, grouping, model selection and overview/calendar toggles are reached from the compact legacy menu, with explicit Apply/Reset and model-draft/library access. Full model CRUD, validated JSON editing, preview, diff and publication remain required under section 26; this popover is an entry point, not their replacement.

![V08 proposed legacy-shell filter, grouping and model settings popover](docs/ui/v2.2/ui-filters-models.png)

## 42. User evidence: Overview and descriptor

E01 - User-supplied screenshot, preserved unaltered. It shows a dark detail timeline, bottom overview and a right descriptor with original/current dates and metadata. It is evidence of the user's legacy workflow, not a newly executed runtime test. Record count and tiny/partially clipped original labels are not treated as acceptance-safe layout measurements.

![E01 user screenshot showing the legacy overview and right-side descriptor](docs/ui/v2.2/evidence-descriptor.png)

## 43. User evidence: Alternative filtered view

E02 - User-supplied screenshot, preserved unaltered. The user identifies it as the same timeline under another filter/configuration. SOURCE1 and SOURCE2 appear in contrasting stacked bands. Preserve filter-driven grouping and model variations; the image alone does not specify the exact serialized filter or prove that overview visibility is tied to grouping.

![E02 user screenshot showing SOURCE1 and SOURCE2 grouped bands](docs/ui/v2.2/evidence-grouped.png)

## 44. User evidence: Yellow search findings

E03 - User-supplied screenshot, preserved unaltered. The visible input is `5_1`; matching Activity 5_1 labels have yellow backgrounds and the light overview shows the findings rather than all detail context. Preserve that behavior safely. The separate `0_3` example is provided in V07 and acceptance A51.

![E03 user screenshot showing 5_1 search highlights and a findings-only overview](docs/ui/v2.2/evidence-search.png)

## 45. Sources and reference standards

Source observations were made from a shallow local clone on 12 September 2026 at commit `cf5d263853e550aab44d3d1959637c1e324b719e`. Links below are pinned where applicable. This is a targeted static audit, not a claim that legacy code paths were executed. See `docs/legacy-source-audit.md` and the new companion audits for evidence, limitations and the complete 17-page brief comparison. User-supplied screenshot provenance is recorded in `docs/ui/v2.2/README.md`.

- S01 - [Legacy package manifest](https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/package.json): frontend dependency declarations.
- S02 - [Legacy Maven manifest](https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/pom.xml): Java level, server and connector dependencies.
- S03 - [Frontend source](https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js): rendering, activity initialization, navigation, grouping and editing paths.
- S04 - [Illustrative event/session model](https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/json/event_or_session_model.json): legacy envelope, dates and metadata.
- S05 - [Default source configuration](https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/yaml/sources_default.yml): JSON path templates and other connector examples deliberately excluded.
- S06 - [Default saved filter settings](https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/filters/default_filter_setting.json): source, presentation and named-filter configuration.
- S07 - [JSON file manager](https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/com/openbexi/timeline/data_browser/json_files_manager.java): read/filter/write behavior and update/delete stubs.
- S08 - [AJAX servlet](https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/com/openbexi/timeline/servlets/ob_ajax_timeline.java): action-based dispatch and method coverage.
- S09 - [Legacy Swagger](https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/swagger/openbexi_timeline_swagger.yaml): incomplete advertised API.
- S10 - [Legacy Dockerfile](https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/Dockerfile): deployment assumptions requiring later validation.
- S11 - [Regular timeline visual model](https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/models/regular_timeline.json): parameters, bands, scales, colors and grouping.
- S12 - [Descriptor sidecar manager](https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/com/openbexi/timeline/data_browser/event_descriptor.java): date-derived descriptor files requiring ID-based migration.
- S13 - [Historical sample data](https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/json/space_exploration.json): historical timestamps, text fields and absent IDs.
- S14 - [Separate test visual model](https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/tests/models/regular_timeline.json): same basename as production, different authored values.
- S15 - [Complete legacy listener](https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L4232-L4521): drag dispatch, pan, release, descriptor and inertia paths.
- S16 - [Three.js r168 DragControls source](https://github.com/mrdoob/three.js/blob/r168/examples/jsm/controls/DragControls.js): dependency-baseline picking and pointer behavior; not proof of an installed or running legacy version.
- S17 - [Historical repository screenshot](https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/doc/openbexi_timeline_space_exploration.PNG): supplied documentation image reproduced in section 34.
- S18 - [User-supplied 17-page legacy illustrated brief](OpenBEXI_Timeline_Rebuild_Prompt_legacy.pdf): full text, original/proposed visual references, exact layout and 14-record fixture; retained unmodified.
- S19 - [Legacy track allocation and text measurement](https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L3172-L3297): `get_first_free_tracks`, `get_room_for_session` and measurement, with callers and defects traced in the layout audit.
- S20 - [Legacy frontend menu and search paths](https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js): menu/search audit links individual handlers and the server JSON-manager search implementation at the same pinned commit.

Normative reference standards are chosen for specific contracts, not as claims about the newest available versions:

- N01 - [OpenAPI 3.1.1](https://spec.openapis.org/oas/v3.1.1.html): API contract representation.
- N02 - [JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12): validation dialect.
- N03 - [RFC 3339](https://www.rfc-editor.org/rfc/rfc3339.html): timestamp foundation; this specification deliberately restricts accepted precision and leap seconds.
- N04 - [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html): HTTP semantics and conditional requests.
- N05 - [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html): problem-details response format.
- N06 - [WCAG 2.2](https://www.w3.org/TR/WCAG22/): applicable AA accessibility criteria.
- N07 - [RFC 6902](https://www.rfc-editor.org/rfc/rfc6902.html): JSON Patch operations with application path restrictions.

Primary reference inputs for revision 2.3 are the two user-supplied SIMILE screenshots reproduced in sections 57-58. The [SIMILE band/ether documentation](https://simile.mit.edu/timeline/docs/basics.html) and [HotZoneEther documentation](https://simile.mit.edu/timeline/docs/hot-zone-ether.html) corroborate synchronized bands and nonuniform local magnification; they do not establish an automatic density solver or server row pagination. [D3 continuous scales](https://d3js.org/d3-scale/linear) document numeric piecewise interpolation and inversion, an established-library candidate to evaluate at M0. These are conceptual references, not an instruction to install the historical SIMILE runtime or an assertion of current dependency compatibility.

## 46. Primary SIMILE visual and zone contract

**REQ-49 - SIMILE structure is the new default.** Use the two user-supplied screenshots as primary visual evidence. Reproduce their presentation, not their historical content: a large light main timeline above a shorter, always-visible synchronized overview. Display actual authorized application events and sessions loaded from the JSON-backed server. Do not hardcode screenshot names/dates, silently seed demonstration data, or substitute a task-table Gantt, calendar, cards or marketing page. An empty source remains honestly empty. Timeline/Table/Split and all legacy model-management capabilities remain required alternate workflows.

Point events use small colored glyphs with adjacent labels. Duration sessions use thin colored horizontal bars from true start to true end, with adjacent or clearly reserved above-bar labels. Use compact readable typography, a near-neutral #EEEEEE main field, #DDDDDD overview, subtle vertical grid lines and bottom time-axis labels on each band. Individual rows are reusable tracks, not permanent task-table rows. Preserve the compact legacy toolbar meanings, filters/grouping, search and explicit Navigate/Edit distinction. Calendar/descriptor are optional right-side panels or narrow-screen drawers; they must not displace the two-band default with another primary layout. The SIMILE view keeps its overview visible; the legacy hide/show-overview capability remains in compatible alternate models, not as a hidden way to remove this default's required second band.

The proposed 1600 x 900 reference shell reserves 48 px for the toolbar, 42 for filters/range/manual zoom/Auto scale, 600 for the main band, 146 for overview and 64 for row navigation/status. The plot spans x=20..1580; axes reserve 32 px at the bottom and scale/zone labels reserve 64 px at the top of the main band. Use 13 px labels, 11 px ticks, 8-10 px marks/bars and a 32 px reference track pitch, yielding 15 full rows. Do not shrink labels to fit more data. These are new design defaults, not pixel measurements of the attachments. At other sizes, recompute capacity while retaining both bands, legible typography and reachable controls. At 390 px, compact menus and a time-focused window are permitted, but the overview and previous/next-row controls remain visible. Touch targets require 44 CSS px effective hit areas. The Classic fixture retains its own geometry only when selected explicitly.

Zones remain versioned visual-model annotations with stable IDs, finite ordered start/end instants, optional title, authorized band/group scope, validated color and opacity. A zero-width zone is either rejected or explicitly represented as an annotation line by its schema, not silently widened into a duration. Default colored fills are translucent; render overlapping zones in stable z-order behind the grid, markers, session bars and record text. Optional zone labels occupy reserved collision-safe space. Zones span the data area, not axes/toolbars/descriptor. Non-color cues and accessible details identify their boundaries and titles. They are neither records nor density contributions.

Project each zone boundary with that band's own mapping. The detail may be nonlinear while overview stays linear. Do not copy pixel positions or widths between bands. Clamp drawing at visible edges, preserve true dates and show the same authorized annotations on every row page in their applicable groups. Search changes record findings, not zones; any separate Hide zones option is explicit. Zone navigation pans in Navigate mode; editing a zone is an authorized, version-checked visual-model operation. Changing page, scale or zoom never mutates zone dates or record JSON.

The five new targets and two unaltered evidence images are embedded below and indexed in the [current visual gallery](docs/ui/v2.3/README.md). Their operational data is a static specification fixture, not the application's actual dataset. Future implementation screenshots must render actual test JSON through the real server and label any demonstration fixture honestly.

## 47. Local density-aware time magnification

**REQ-50 - A continuous shared mapping, not uniform zoom alone.** Implement the precise [adaptive scale contract](docs/adaptive-scale-contract.md). The server computes density and validates an immutable map over a fixed finite analysis domain O, normally the broader overview interval. It uses every authorized record matching the fixed structured filter within O, including records absent from the current row page and sessions crossing its boundaries. Moving the detail viewport inside O does not redefine the user's filter; a Current range table is a projection, not a rewritten base predicate. Contextual search highlights do not replace context density with match density.

The initial `density-log-v1` algorithm requests 128 UTC-duration bins, configurable 16-256, with fewer only when the domain contains fewer milliseconds. Boundaries are anchored to O. Each bin's density is point/zero-duration count plus average active-session occupancy plus half the count of true session starts/finite ends. Count canonical records once, including child records independently; exclude synthetic rendering copies, context-only ancestors, labels and zones. Long sessions contribute overlap occupancy even when neither endpoint is visible. Ongoing sessions extend to O's end for density, not the changing wall clock. Compute exact statistics across the complete filtered projection; do not present page sampling as complete density.

With bin density d, maximum D and allowed ratio R (default 8, range 1-8), weight is 1 when D=0, otherwise `1 + (R-1)*log1p(d)/log1p(D)`. Normalize cumulative weight-times-bin-duration to positions u from zero to one. Empty/equal density produces Uniform geometry; positive base weights keep quiet intervals visible. The ratio bounds relative slopes, not a promise that every bin can have a large minimum pixel width. Arbitrarily simultaneous events retain their common x coordinate and require more rows. Keep exact arithmetic fixtures separate from density-derived production examples.

Within ascending knots `(Ti,ui)` and `(Ti+1,ui+1)`, use `m(t)=ui+(ui+1-ui)*(t-Ti)/(Ti+1-Ti)` and its algebraic inverse. With CSS plot left L, width P and mapped viewport `[a,b]`, render `x(t)=L+P*(m(t)-a)/(b-a)`. Every point, session endpoint, original-time graphic, zone, tick and hit-test uses this same mapping within a band. Reject duplicate/reversed knots, nonfinite values and nonpositive slopes. Use an established reviewed scale/shaping library where applicable and independently validate the invariants; do not use one global milliseconds-per-pixel multiplier across different slopes.

Session width is `x(end)-x(start)`. Preserve true endpoints and use clipped continuation cues for offscreen portions. Axis ticks use real calendar boundaries and adapt their label frequency to the local available spacing. Mark scale changes with reserved bracket/scale labels and transition cues, including local relative magnification or tick interval. Do not imply that equal distances represent equal durations. Keep Uniform/Auto scale and manual zoom available. Scale cues must be distinct from colored annotation zones.

The linear overview maps O independently and highlights `[m^-1(a),m^-1(b)]`. During main dragging, freeze m and translate a/b by the pointer delta in mapped coordinates. During anchored zoom, hold the pointer's mapped instant while changing mapped span; boundaries may limit the anchor explicitly. Overview recentering converts its pointer to time, then applies m to the main band. Dragging the selected range body retains mapped span and the grabbed instant's fractional position; each edge handle changes its corresponding time boundary while fixing the other, with validated minimum span and no inversion. Provide keyboard equivalents and distinct accessible range/edge hit targets. A constant mapped span can represent different UTC durations across hot regions; the overview highlight changes width accordingly. Explicit typed date ranges instead preserve their exact UTC endpoints. The old 10/240-unit band-sync oracle applies only to Uniform mode.

Page changes preserve O, a/b, map/layout IDs, axes, reference time, zones and overview. Pan changes a/b/layout but not m while inside O. Domain extension, explicit filter or scale-parameter changes create new coherent identities; clamp at O rather than extrapolating forever. Mode/map replacement preserves visible UTC endpoints and selection, accepting that interior x positions may redistribute; exact pointer anchoring is guaranteed during a gesture with its frozen map, not simultaneously with arbitrary new knots. Keep the same temporal focus in view and avoid animated label crossings.

Apply the companion's explicit geometry hysteresis: compare knot positions at common instants, retain geometry for differences <=0.002 only under compatible inputs, at most 30 seconds; replace at most once per two seconds after 500 ms input idle. Explicit Recompute bypasses these delays. Active navigation/edit holds geometry. Fresh data may use retained knots only under a new manifest recording current density/snapshot and geometry lineage; never pair old snapshot identities with new counts. Permission changes invalidate affected state immediately. These geometry rules do not turn stale data into a successful live update.

Separate continuous inverse view coordinates from millisecond-precision canonical data. A conservative integer fetch envelope may aid indexing, but exact view bounds govern membership and totals. Adapt camera projection to preserve a common time-to-screen-x mapping across rows. Unsupported Adaptive/camera combinations must present an explicit compatible-mode choice; silently applying row-dependent inverse mappings is forbidden. Uniform legacy camera coverage remains mandatory.

## 48. Server-driven vertical row pagination

**REQ-51 - Page excess tracks within the same time interval.** The server prepares a deterministic global logical-row layout from the entire eligible filtered detail projection under one snapshot, map, model, grouping, expansion and render profile. Then page that layout vertically. Do not fetch arbitrary record chunks and repack each chunk independently, change the horizontal range to retrieve the next page, or load the complete record list into the browser. A logical row can contain several noncolliding records; grouping headers and expanded nested tracks are explicit structural rows.

Use the measured available main-band data height after reserving axes, scale/zone labels and navigation. Derive row capacity from readable row height, and use cumulative heights for variable-height rows. The server accepts both a height budget and row ceiling and selects a complete row prefix that fits. Text, font, icons, outlines, baselines and parent enclosures participate in full-footprint packing; preserve the 4 CSS px clearance contract. A tall individual row has an explicit bounded internal-scroll/expanded-detail alternative, never unreadable shrinkage or indefinite webpage growth.

Place previous/next-row controls immediately below or alongside the main/overview assembly, with stable row-range and page/position indicators. The overview remains visible. Distinguish loaded record count, total records in the interval and total logical rows; one row is not necessarily one record. Disable impossible navigation and expose loading/failure/retry accessibly. Switching pages keeps the same interval, scale, x positions, reference clock and zones, and does not dismiss a selected off-page record's descriptor. Explicit Reveal selection locates its row; it never silently navigates time merely because a page changed.

The global allocator uses server-approved font files and a versioned shaping/measurement profile, not character-count guesses or uploaded client widths for arbitrary records. The client waits for fonts and checks actual projected bounds; a profile mismatch requests a corrected layout instead of silently repacking or changing page membership. Cursor identity binds layout, width, height/reservations, camera, profile, scope, grouping and expansion. Resize or configuration change produces a new layout and reanchors to a stable visible record/row, preserving temporal endpoints. Uniform/Adaptive switching may alter total rows, but changing only the row page may not.

Oversized groups or nested blocks split at logical-row boundaries with clearly flagged continuation breadcrumbs. Repeated headers/ancestor context never become duplicate canonical records, search findings or bulk selections. Multi-group render instances have stable distinct instance keys while canonical totals remain deduplicated. Normal complete page traversal returns every intended data instance exactly once. Optional old-layout placement reuse is explicit in the layout key; identical inputs otherwise yield identical allocation.

Ordinary row responses are capped at 1,000 projections and 2 MiB, with a 50-row default ceiling and 100-row maximum. Height-derived capacity can be much smaller. If a complete row range exceeds response limits, use separately identified payload fragments of that same row range, not misleading next-row/time cursors. Return `pageComplete` only after all fragments. Allow at most eight fragments per logical page; reject an over-limit request before its first fragment, recommending fewer rows or an approved render profile. Even a single oversized row returns an actionable error rather than successful truncation. These limits constrain delivery, not canonical record retention.

Pinned browsing retains its snapshot/layout/map and row positions while writes arrive, with a changes-available notice. Refresh or an authorized local edit prepares and atomically adopts a new snapshot, density, map, layout, counts and anchored page. Live mode follows the same coherent replacement policy. Never briefly mix rows from one revision with totals/overview from another. Expired handles and permission changes are explicit; do not silently restart at page one or conceal inaccessible data under stale counts.

## 49. Dynamic server view protocol

**REQ-52 - Bounded detail, density and overview transfers.** Extend the REST surface using the normative [adaptive query contract](docs/adaptive-query-contract.md). Let B be `/api/v1/workspaces/{workspaceId}` and Q be `B/query-sessions/{queryId}`. A query session is an ephemeral read-only view handle over existing snapshot infrastructure, not an authentication session, timeline session, new database or durable-write transaction. Its creation/release must not advance workspace revision or write search styles into records. Canonical CRUD still uses all existing authorization, ETag, retry and JSON durability rules.

| Endpoint family | Required view behavior |
| --- | --- |
| POST B/query-sessions; GET/DELETE Q | Create, inspect or release an authorized immutable view query. Bind source/schema/filter/search, model versions, O, display zone and mode. Return 200 ready or 202 preparing with status location, never an unbounded record array. |
| GET Q/density; GET Q/maps/{mapId} | Complete-filter bounded density statistics and immutable validated map knots/provenance. Row cursors are not density inputs. |
| GET Q/overview; GET Q/zones | Lightweight broader-period marks/aggregates and independent authorized annotations. Search overview uses only findings. Bound payloads and identify any group/zone continuation. |
| POST Q/layouts; GET/DELETE Q/layouts/{layoutId} | Prepare/inspect/release global logical rows for the exact viewport, geometry, grouping and registered render profile; return status, identities and row/record totals. |
| GET Q/layouts/{layoutId}/rows | Height-aware row range or opaque row/fragment cursor, bounded projections, completeness and separate continuation types. |
| GET Q/layouts/{layoutId}/placement/{recordId} | Authorized placement and row cursor for explicit reveal; return outside-layout rather than moving time implicitly. |

Requests include exact typed time range or mapped a/b, filter/search grammar and mode, grouping/sort/expansion, model versions, requested row/fragment cursor, row ceiling, available CSS height/width, approved font/style profile and camera. Validate redundant representations for agreement. Display resolution is a layout/aggregation hint, never an authorization boundary or permission to omit records. Record overlap uses section 05, including sessions beginning before the interval. Footprints such as visible baseline/label extensions may require separately flagged `footprintOnly` context, excluded from time-window totals.

Responses bind workspace generation, snapshot/revision, query/map/layout/profile identities, exact visible bounds, conservative fetch bounds, O, stable row ordinals/heights, total rows, render-instance total, record totals and match totals with explicit scopes. Define C as the full fixed authorized structured-filter result, C_O/C_W as its overview/detail projections and M as the independent search subset. Return base/match totals for C/M, overview totals for C_O/M_O and detail totals for C_W/M_W. Loaded-page counts are separate. In ordinary search, the page projects C_W plus separately flagged authorized footprint-only/ancestor context, density uses C_O and overview uses only M_O; unmatched parent/enclosure data stays out of that overview. Context extras cannot inflate detail totals or density. Zones and viewport chrome may remain because they are not findings. Clearing search restores normal overview without rewriting JSON.

Add all new visual settings to the existing typed JSON model/view APIs and editors: scale mode/algorithm/parameters, time domain policy, row spacing and overflow, zone styling/visibility, grouping, profile selection and personal preferences. Preserve immutable published model versions, explicit upgrades, effective-setting precedence and reset-to-inherited behavior. Server ceilings and authorization cannot be bypassed by a saved model. Computed knots, query/layout handles, fetched rows and transient highlights are derived view state, not authored model payloads to persist on every navigation.

Reuse immutable backing snapshots and existing retention budgets: five minutes, four per principal and 256 MiB globally for retained query/layout working data. At most two layouts per session; one active preparation per principal, two globally, queue of eight. Bound request bodies to 64 KiB, preparation to 30 seconds, projections to 16 KiB and overview to 1,000 marks/cells and 2 MiB per response. Zones use 128 per page, maximum 512. Reserve capacity before promising a result; overload returns 429/Retry-After, not a sampled or truncated success. Do not duplicate the snapshot memory allowance under a new handle family.

Cache server indexes/projections only in memory or disposable ordinary JSON, and browser records in bounded memory only. Cache keys include authorization, generation, snapshot, filters, model/profile, domain, geometry and projection. Fetch only the requested detail page plus bounded useful adjacent prefetch; never prefetch every page. Navigation, zoom, filter changes and row changes issue the appropriate scoped requests, reusing density/map/overview when their semantic inputs did not change. Keep a monotonically increasing client intent/request identity; cancel obsolete requests and reject late replies even when cancellation arrives too late. Handle loading, empty, unavailable, expiry and stale states distinctly.

Live geometry retention is explicit provenance, not stale density presented as fresh. Keep one replacement preparation in flight and coalesce newer intents. Apply the complete accepted bundle atomically. Notice latency has a one-second p95 target; warm Adaptive replacement has a three-second p95 target after eligible idle and cold preparation a ten-second p95 target for the reference tier, separately from section 47's geometry hysteresis. Uniform's existing latency target remains. A fast notice is not a successful completed detail refresh. Preserve drafts/selection where authorized; revocation clears affected cached records, counts and density immediately.

## 50. Test and integration gate before code delivery

**REQ-53 - Execute the verification plan before delivering code as complete.** Once implementation is authorized, execute the [integration test and delivery plan](docs/integration-test-plan.md), not merely write a plan or demonstrate mock screenshots. Bind results to the actual delivered commit, lockfiles, fixture checksums, fonts, runtime/browser binaries and supported filesystems. During this prompt-only revision, no application integration, durability, browser interaction or performance test is claimed as run.

| Gate | Evidence required before completion |
| --- | --- |
| G0: contracts | Reviewed architecture, complete source/feature inventory, JSON/OpenAPI/schema contracts, current visual precedence, density/row/profile definitions, deterministic fixtures and requirement-to-test map. Resolve conflicting assumptions before dependent code. |
| G1: components | Formatting, lint, applicable type/static analysis, production build, unit and seeded property tests. Independently test mappings/inverses, time boundaries, density, packing, fonts, filters/search and cancellation. |
| G2: real server | Actual HTTP plus disposable real JSON roots: CRUD, source permissions, models/settings, cursors, complete-filter queries, faults, retries, restart, backup/restore, concurrent clients and generation changes. No mock persistence pass. |
| G3: browser integration | Real production frontend/server workflows: two-band pan/zoom, zones, local scale, row/fragment pages, search/descriptor, Table/Split, model lifecycle, edits/conflicts, reconnection and multi-instance isolation. |
| G4: quality | Actual screenshots/traces and projected/pixel bounds, manual and automated accessibility, security probes, payload/memory/frame measurements and cold/warm performance distributions. |
| G5: clean delivery | Clean checkout/package install, build/start, migrate, restart/restore and full supported-matrix execution on the candidate; final traceability and honest limitations before handoff. |

Run storage suites on Windows/NTFS and a Linux single-writer container with a persistent local volume. Run real desktop Chrome/Edge/Firefox workflows against Windows and Chromium/Firefox against Linux; freeze exact versions at G0. Verify desktop, breakpoint and 390/360 px layouts, device scale 1/2, keyboard, touch-pointer paths and 200% browser zoom. Browser emulation is not physical-device evidence, and WebKit is not a native Safari certification. Do not advertise untested environments as verified. Unsupported camera/mode cases require a visible diagnostic and tested Uniform alternative, not a silent capability loss.

Mandatory fixtures cover sparse/empty data, dense clusters, many genuinely simultaneous sessions, long/ongoing/zero-duration sessions, offscreen endpoints, nested and out-of-parent activity, overlapping zones, nonlinear knot crossings, long/bidirectional labels, rapid navigation/reordered replies and changing server data. Preserve Classic-14 and Dark-40 compatibility tests and add AS-MAP-01, AS-UI-01 and ROW-05 oracles from the companions. Run at least 1,000 deterministic generated cases per mapping/layout property; retain failing seeds and minimized counterexamples. Expected IDs and coordinates must come from an independent oracle, not a second call to production code.

Kill/restart around every journal commit stage; inject disk-full, permission/file-sharing failures, invalid indexes, second-writer ownership and interrupted restore. Inspect actual committed JSON/versions after restart and lost-response retry. Process termination tests do not establish power-loss safety. Test every new density/map/layout/overview/fragment endpoint for hidden-field or cross-workspace leakage, forged cursors, oversized work, stale authorization and read-only bypass.

Store commands, exit codes, environment and fixture manifests, per-test pass/fail/skip results, HTTP/storage traces, browser PNGs/traces/diffs, manual accessibility evidence, raw benchmark samples, security findings and clean-install logs under `artifacts/verification/<commit>/<run-id>/`. Every mandatory requirement, A01-A74 and companion case needs a test/result link. Zero required failures is necessary; skipped, blocked, not-run, flaky or missing evidence cannot be relabeled passed. Fix defects and rerun affected suites and shared-contract regressions. Do not call the implementation ready or deliver it as complete while a mandatory gate is unresolved.

## 51. Adaptive and row-page acceptance scenarios

The following extend, not replace, all earlier acceptance scenarios. They are future executable obligations; static image QA cannot satisfy them.

| ID | Required scenario and outcome |
| --- | --- |
| A57 | Load actual authorized JSON into the default SIMILE view: large light detail, smaller visible overview, bottom axes, markers/labels and true-duration bars. Empty sources do not show hardcoded historical or demo content. |
| A58 | Render overlapping labeled zones behind records in both bands; independently verify each start/end at Uniform and nonlinear scales. Page/zoom/navigation never changes annotation JSON or alignment. |
| A59 | Independently recompute complete C_O density, including records absent from the current page, long/ongoing sessions and equal-time events. Page order/capacity does not affect statistics or mapping. |
| A60 | Run AS-MAP-01: 1000 px full-domain positions 50/300/700/950; crossing session spans 50..700 and zone 200..600. Validate strict monotonicity, continuity, ratio bounds, inverse error and invalid knots. |
| A61 | Run nonlinear pan/zoom oracle: a/b=.1/.5 plus 100 px right drag gives .06/.46, W=00:36..01:54, overview highlight150..475. Test pointer anchoring, domain limits, overview recenter, calendar and explicit typed ranges. |
| A62 | Switch Uniform/Auto scale; retain temporal endpoints/selection and correct dates. Verify visible scale-transition cues, fixed gesture maps, hysteresis/provenance, 30-second retention limit, explicit Recompute and reduced motion. |
| A63 | Through real HTTP, ROW-05's five simultaneous sessions with row ceiling2 yield row pages2/2/1. Union has exactly five data IDs once; every page keeps interval, map/layout identity, axes, reference and zones. |
| A64 | Resize height/width, fonts, grouping and nested expansion; derive readable capacity and new layout identity, reanchor explicitly and retain temporal focus. Oversized blocks use continued rows; no unlimited webpage growth or local page repacking. |
| A65 | Exceed record/byte caps and verify numbered same-row-range payload fragments, explicit incompleteness, eventual complete union and separate next-row cursor. Reject >8 fragments before first delivery; no skipped oversized row. |
| A66 | Query sessions starting before W/O, ending after it, ending exactly at left, right-edge points, ongoing and zero-duration sessions. Use exact continuous view bounds for counts; conservative fetch envelopes do not add members. |
| A67 | Search a paginated view: detail retains C_W context, yellow labels reflect loaded matches, global match counts remain exact and overview contains only M_O, including off-page/outside-W findings. Density/row membership and stored colors do not change. |
| A68 | Fire rapid pan/zoom/filter/page intents with deliberately delayed/reordered replies and aborted requests. Only the current semantic bundle can commit; old requests cannot overwrite newer data or show mixed identities. |
| A69 | Traverse row pages during five writes/second: pinned state remains stable with notices. Live/local-edit refresh swaps coherent rows/map/counts/overview with explicit geometry lineage. Expiry/restore/revocation invalidate handles correctly. |
| A70 | Assert bounded detail and overview payloads, admission/memory limits, authorized aggregate drill-down and cache keys. No download-all request or undisclosed sampled density may occur; zones/context never inflate record totals. |
| A71 | Inspect actual projected text/icon/bar bounds under both supported cameras, long labels, breakpoint layouts and font delays. Test keyboard/page announcements, accessible full labels, contrast, touch targets and non-color zone/scale cues. |
| A72 | Measure cold/warm preparation, row queries, save/live latency, frames and memory on fixed supported environments. Separate notices from complete detail; retain raw distributions and explicit unsupported stress results. |
| A73 | Run real JSON integration, crash/retry/restore and endpoint security suites, then clean install/build/start/restart on each supported platform against the exact candidate. Preserve canonical data and model versions through navigation. |
| A74 | Before delivering implementation as complete, pass G0-G5 and provide commit-bound requirement/test evidence with no unresolved mandatory failures or checks silently skipped. Static screenshots and a written test plan alone cannot pass. |

## 52. Visual target: SIMILE Uniform scale

V09 - Proposed static design. Actual implementation must use server-provided application records. This separate 48-record operational fixture uses 12 September 2026 UTC, W=08:00-17:00, O=00:00-24:00 and reference 12:30. Auto scale is off. The first page shows 23 records on rows 1-15 of a 40-row authored illustrative layout; the overview contains all 48. Bars crossing the interval retain continuation cues, with bottom axes and two overlapping annotation zones.

![V09 proposed SIMILE two-band layout with Uniform scale and colored zones](docs/ui/v2.3/ui-simile-uniform.png)

## 53. Visual target: Adaptive rows page one

V10 - Proposed static design using AS-UI-01's hand-specified accepted map, not a claimed output of an implemented automatic solver. The 12:00-13:00 interval has four times the local scale of the surrounding context. Scale brackets and finer bottom ticks make the change explicit. The same 23 detail records, zones, reference and 48-record overview remain. This fixture deliberately centers 12:30 under both Uniform and Adaptive; arbitrary map changes cannot preserve every interior screen position.

![V10 proposed SIMILE local magnification with rows 1-15](docs/ui/v2.3/ui-simile-adaptive-page-1.png)

## 54. Visual target: Adaptive rows page two

V11 - Proposed static design of rows 16-30, containing the next 15 records. Only vertical record membership changes. The interval, map, scale cues, axes, zone x boundaries and overview viewport/data are identical to page one. These authored rows demonstrate the pagination contract, not a running server allocator.

![V11 proposed second vertical page with unchanged time mapping and zones](docs/ui/v2.3/ui-simile-adaptive-page-2.png)

## 55. Visual target: Paginated search findings

V12 - Proposed static search for Telemetry in the same fixture. Five records match across the full result; only two matches are on this loaded 23-record first page and receive yellow labels. The overview contains exactly all five findings, not only loaded matches or unmatched parents. Zones and viewport navigation remain because they are not record findings. Search does not alter the contextual page layout or the C-based map.

![V12 proposed paginated context with yellow search labels and full findings-only overview](docs/ui/v2.3/ui-simile-search.png)

## 56. Visual target: Narrow SIMILE timeline

V13 - Proposed static target at 390 x 844 CSS pixels, with an explicitly focused 12:00-13:00 interval and the same broader overview. Both bands and row navigation remain visible. This interval has 40 detail records; 12 are on the illustrated page, while overview still represents all 48 in O. The one truncated label requires the declared focus/touch/descriptor full-text path in implementation; this static image does not prove that interaction or accessibility works.

![V13 proposed narrow two-band timeline with zones and row controls](docs/ui/v2.3/ui-simile-mobile.png)

## 57. Primary reference: SIMILE duration bands

E04 - User-supplied screenshot, preserved unchanged. It establishes a large light detail band, small colored point glyphs, labeled duration bars, bottom time axes and a shorter synchronized overview. Historical names and dates are visual evidence only; do not recreate them as production application data.

![E04 unmodified user SIMILE screenshot showing duration bars and overview](docs/ui/v2.3/evidence-simile-durations.png)

## 58. Primary reference: SIMILE colored zones

E05 - User-supplied screenshot, preserved unchanged. It shows dense small labeled markers, a translucent orange time-region overlay and the corresponding lower-band interval at a different scale. Use its two-band structure and presentation as the primary visual direction alongside E04; current requirements, exact contracts and actual authorized application data govern behavior.

![E05 unmodified user SIMILE screenshot showing colored zones in both bands](docs/ui/v2.3/evidence-simile-zones.png)

End of specification and generation prompt. Application implementation remains a separate, explicitly authorized task; the integration gate activates before code is delivered as complete.
