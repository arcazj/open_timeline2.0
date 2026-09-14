# Implemented Python API

This documents the implemented JSON timeline service, visual-model catalog and presentation extension, structured queries and immutable full-query table API, not completion of the full product specification. The service uses ordinary JSON files only. There is no SQL, NoSQL, embedded database, search database or broker dependency.

## Startup and Ownership

The application factory is `server.app.main:create_app(data_root=None, token=None, seed_path=None, metrics_path=None)`. Tests supply a temporary data root and explicit token. For Uvicorn, set the environment first and use `server.app.main:app`:

```powershell
$env:OPENBEXI_API_TOKEN = '<a-random-secret-of-at-least-24-characters>'
$env:OPENBEXI_DATA_ROOT = 'C:\timeline-data'
.venv/Scripts/python -m uvicorn server.app.main:app --host 127.0.0.1 --port 8765
```

The token is operator configuration, not embedded in the client. The default root is `var/timeline` within the project. Initial data comes from `data/default-dataset.json`; existing roots are never silently reseeded. `/` serves the generated `dist/index.html`, or a clear 404 if the client has not been built. The application module also supports `python -m server.app.main`, with loopback binding and optional `OPENBEXI_PORT`.

Only one process may open a data root. A nonblocking OS-enforced `portalocker` lock rejects a second writer; do not configure multiple Uvicorn workers over the same root. Within the owner process, a mutex serializes mutations and snapshot acquisition. Startup validates the complete schema, record count, IDs, source scope and selected-model reference. Missing workspace metadata in a nonempty root is an error, never permission to reseed; missing records fail startup instead of producing a falsely complete export. Empty configured sources remain in the catalog.

The layout service uses the shared registered Noto Sans metrics at `shared/fixtures/font-metrics.json`, plus the 700-normal, 400-italic and 700-italic companion files. Unsupported glyphs produce an explicit diagnostic rather than guessed widths.

## Authentication and CORS

`GET /api/v1/health`, `/health/live`, `/health/ready`, and `/api/v1/capabilities` are public and expose no credentials or record payloads. Workspace data, queries, mutations, export and the native OpenAPI require `Authorization: Bearer <token>`. Root JSON identities now provide viewer/editor/admin roles, workspace/source grants, hashed expiring tokens, revocation, durable command results and inactive-root credential recovery. The configured startup token bootstraps an empty identity store once; changing it does not reset an existing store. Field-level authorization and full administration UI remain release work. See [identity operations](identity.md). There is no cookie authentication or implicit trust based on source origin. API responses are `Cache-Control: no-store`.

CORS is disabled by default. An operator may set an explicit comma-separated `OPENBEXI_CORS_ORIGINS`, for example `http://127.0.0.1:5173`. A standalone file connection requires explicitly including the literal origin `null`; that opt-in still requires the bearer token. Wildcard origins are rejected. `null` includes opaque origins besides local files, so enable it only when this tradeoff is accepted. Allowed methods and request headers are enumerated; credentialed cookies are not enabled.

## Routes

Let `B=/api/v1/workspaces/default` and `Q=B/query-sessions/{queryId}`.

| Method and Route | Implemented Behavior |
| --- | --- |
| `GET B`, `GET B/status` | Current source, generation/revision, active record count, settings, models, source IDs and capabilities. |
| `POST B/query-sessions`, `POST B/records/query` | Prepare an immutable filtered snapshot and density map; returns 200 and query/map IDs. |
| `GET Q` | Query manifest, fixed revision and complete filtered counts. |
| `GET Q/density` | All-domain filtered density bins, never current-page sampling. |
| `GET Q/maps/{mapId}` | Immutable map; mismatched query/map returns a conflict. |
| `GET Q/overview` | Compact full-domain marks, matching marks only when contextual search is active. |
| `GET Q/zones` | Snapshot annotation zones overlapping the analysis domain. |
| `POST Q/records/query` | Independently sorted, cursor-paginated table records from the complete immutable query snapshot. |
| `POST Q/layouts` | Global measured allocation for one exact detail interval and render profile. |
| `GET Q/layouts/{layoutId}/rows?cursor=...` | One complete bounded logical row page; opaque layout-bound cursors. |
| `GET Q/layouts/{layoutId}/placement/{recordId}` | Placement and page cursor, or `outsideLayout:true`. |
| `DELETE Q/layouts/{layoutId}`, `DELETE Q` | Release in-memory artifacts. |
| `GET B/records?limit=100&offset=0` | Current active-record list; not an immutable cross-request query cursor. |
| `GET B/records/{id}` | Canonical active record and ETag; `includeDeleted=true` includes a tombstone. |
| `POST B/records` | Create a record with server-owned identity/version/audit fields. |
| `PUT B/records/{id}` | Replace every declared mutable field; kind remains immutable. |
| `PATCH B/records/{id}` | Bounded JSON Patch with explicit null and array semantics. |
| `DELETE B/records/{id}` | Soft delete with body-free 204 and ETag; active children prevent implicit deletion. |
| `GET/POST B/events`, `B/sessions`; `GET/PUT/PATCH/DELETE B/events/{id}`, `B/sessions/{id}` | Kind-enforcing typed aliases; mismatched item kinds return 404. |
| `POST B/records/batch` | Validate and commit up to 500 mixed record operations atomically at one workspace revision. |
| `POST B/records/{id}/restore` | Restore a tombstone using its current version. |
| `GET B/command-results/{clientCommandId}` | Read-only lookup of a committed write outcome. |
| `GET B/snapshot` | Explicit complete workspace snapshot including tombstones, models, zones, filters and settings. |
| `GET B/models`, `GET B/models/{id}` | Bounded canonical model catalog, usage and model ETags; `includeArchived=false` filters the list. |
| `POST B/models/validate` | Read-only validation of `{definition}`; returns `{valid,errors:[{path,code,message}]}`. |
| `POST B/models` | Create a new draft with a server-generated model ID. |
| `PUT B/models/{id}` | Update metadata and/or replace the complete draft definition. |
| `POST B/models/{id}/publish` | Append an immutable published version, clear the draft; never auto-apply. |
| `POST B/models/{id}/archive`, `/unarchive` | Explicit lifecycle changes; archived published versions remain readable. |
| `POST B/models/{id}/apply` | Atomically pin `{version}` and update definition settings while preserving navigation focus. |
| `DELETE B/models/{id}` | Delete only an unreferenced model; current default and last model are protected. |
| `GET B/openapi.json` | Authenticated native OpenAPI 3.1.1 with bundled 2020-12 schemas, examples and exact route inventory. |
| `GET B/audit` | Capability-checked, source/owner-scoped metadata audit pages with pinned revision cursors. |
| Catalog, settings and identity routes | See the complete native contract and catalog/identity guides below. |

The exact mutable representation, patch allowlist, 201/200/204 behavior, explicit cascade/restore and retry transport are documented in [record commands](record-command-contract.md). Payloads are validated without coercion. Dates require an ISO timezone and millisecond-or-coarser precision; mutable canonical times normalize to UTC. Unknown or server-owned record fields reject. Custom data requires an exact published workspace schema pin; unpinned records admit the declared built-in data fields only. Sources/groups, schemas, saved filters/views and personal/workspace settings have common Local/Server authoring commands with immutable publications and reference checks. See [configuration contracts](configuration-catalog-contract.md) and the [native API guide](api-contract.md). Complete workspace/root administration and all remaining release routes are not implied by this subset.

## Writes and Recovery

All mutations require `X-Workspace-Generation` and `Idempotency-Key`. Existing-record mutations also require `If-Match: "<generation>:<version>"`; existing-model mutations use `If-Match: "<generation>:<modelRevision>"`. Keys contain 1-128 ASCII letters, digits, underscores or hyphens. Version checks and writes occur under one mutation lock. Record and model commands share the scoped outcome namespace: reusing one key across resources conflicts instead of creating an unrelated second write.

Create/update/restore responses are `{record,durability:'server-committed',generation,revision}`. DELETE returns 204; its full durable result remains available by original command key. Batch results include indexed items and one workspace revision. A successful identical retry returns the original result without creating another version. Reusing a key for different content or route returns 409. Outcome keys are scoped to the authenticated principal; generation participates in the fingerprint. A generation change rejects an old request before replay lookup, and historical restored outcomes cannot be returned as current-generation results. A missing outcome is not proof that an in-flight request can never commit; reconnect must not automatically submit a new mutation.

Workspace revisions remain safe integers. A new record mutation at the maximum revision returns 413 `revision_capacity` without changing state; a previously committed identical request can still replay at that boundary. Model commands enforce their workspace/model revision ceilings separately.

Storage consists of `workspace.json`, record JSON, `outcomes/{hash}.json`, a transient `transaction.json`, and the writer lock. Existing layout1 roots retain `records/{uuid}.json`; explicit offline layout2 migration replaces those files with checksummed `storage-layout.json` and authoritative JSON shards of at most 4 MiB. Both layouts validate every record before readiness. Individual layout1 record files have a 1 MiB raw-read limit and retain the 256 KiB canonical record limit. No database or authoritative cache is introduced.

Every new journal uses v2: complete checksummed before/after PREPARED is flushed before target installation, then COMMITTED is flushed before publishing the new revision. Recovery rolls back PREPARED and redoes COMMITTED; old v1 journals retain their former redo-only interpretation. Complete envelopes are capped at 32 MiB before preparation. Path/checksum/revision/conflict validation precedes recovery writes. Installation failure freezes access until restart; the original command key remains the recovery identity. Cleanup failure after a known commit does not invalidate success. See the [protocol and migration ADR](adr/0002-json-transaction-v2.md).

New workspace writes also append metadata-only `audit/{revision}.json` and `audit-state.json` in that same transaction. Audit chains and root identity state are validated before readiness. [Complete-root backups](adr/0004-complete-root-backup.md) preserve records, catalogs, outcomes, identities and audit history; isolated restore rotates generations and revokes old credentials. Current history policy retains all entries; pruning/compaction and tracked online backup jobs remain separate work. Tests establish process-interruption recovery for exercised paths, not Windows power-loss, hostile filesystem or full production qualification.

The optional `scripts/export-dataset.py` CLI calls only the explicit complete-snapshot endpoint and validates schema, IDs, scope, count and references before writing. It rejects all HTTP redirects so bearer credentials cannot follow a redirect destination. It refuses existing output paths, fsyncs newly created output and removes its own partial file on a caught write failure. Its admitted standalone export is at most 64 MiB and 25,000 records. Abrupt process termination can still leave a partial CLI-created file; the next invocation refuses to overwrite it, and normal import validation rejects incomplete content. This is an export helper, not a certified backup/restore system.

## Versioned Visual Models

The exact envelope and command semantics are documented in [Visual Model Catalog](model-catalog-contract.md). The supported definition has nine required fields: theme, row height, font size, grouping, display unit, time zone, scale mode, ratio and bins. It also accepts the optional versioned `presentation` extension described below. Unknown properties are rejected. The shared exact-case IANA catalog at `shared/fixtures/time-zones.json` and Python's installed zone data must both support the requested name. Numeric offsets and casing variants are not silently accepted.

Each model has one editable draft, metadata, an optimistic `revision`, active/archived lifecycle and up to 32 contiguous immutable published versions. The catalog contains 1-100 models. Duplicate/import is create with a copied complete definition and a new name, never overwrite by ID. Update accepts only name, description, tags and/or a complete draft. Publishing requires an active draft; it appends one version and never changes the workspace selection. Existing pinned query/layout artifacts remain valid.

Apply checks the model ETag, requires an active published version, and atomically writes `settings.modelId`, `settings.modelVersion`, all nine definition settings and the optional presentation. Applying a definition without presentation removes any prior `settings.presentation`. It preserves range, overview, reference time and filter configuration. Apply increments workspace revision but leaves model revision and published history unchanged. Other successful model edits increment model revision and workspace revision. Archived referenced versions remain renderable; archived models cannot be edited, published or newly applied. Usage currently covers the one workspace-default reference implemented by this service.

Model mutation responses are `{model,settings,durability:'server-committed',generation,revision}`; delete returns `model:null`. Model metadata, settings, workspace revision and outcome use the same before/after journal as record writes. Model-only commands do not rewrite record files or shards; layout2's manifest revision advances with the workspace. Same-key retries and read-only command-outcome lookup work for model mutations, including recovery after an interrupted commit. Trusted principal identity is recorded in outcome metadata and record creation/update audit fields.

Legacy flat presets remain accepted for import. Reads normalize them to a deterministic published version 1 and pin the old default to version 1, using the original snapshot timestamp. Startup and reads do not migrate files. The first authorized record or model mutation persists this canonical catalog atomically before advancing the snapshot timestamp, freezing legacy publication dates. Canonical imported catalogs require an explicit valid default version pin.

Input `contentSha256`, when present, is verified over the original records/zones/models/filters/settings using RFC 8785 before normalization. Complete exports recompute that SHA-256 after canonical model conversion. The original checksum is not reused after conversion or record reordering. This provides content-integrity checking, not source authenticity, encryption or a replacement for backup certification.

Internal immutable query acquisition copies the same complete authoritative state without computing an export-only digest. It does not weaken startup/import validation or query admission, and no public option exposes an unhashed export. `GET B/snapshot` always computes its checksum over the isolated complete copy.

## Query Semantics and Limits

Input and response shapes extend [First Implementation Slice](implementation-slice.md). `filters` accepts only `sourceId`, `kind` and optional `expression`. These predicates define the complete active projection C. An expression is `{version:1,root:<node>}` with at most 100 nodes and depth eight. Boolean nodes are `{op:'and'|'or',args:[...]}` and `{op:'not',arg:...}`. Leaves support `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `in`, `contains`, `exists` and `overlaps`. Value predicates use `field` and `value`; `in` uses 1-100 `values`; `exists` requires a boolean value; `overlaps` uses strict ISO `from`/`to`. Text `contains` additionally accepts boolean `caseSensitive`, default false. There are no regex, SQL, executable expressions or undeclared field access.

The allowlist and types are in `shared/fixtures/filter-fields.json`: core identity/title/kind/source/parent/schema text fields, date fields, order/version/schemaVersion numbers, tags/groupIds string arrays, and fixed data text fields status/system/type/description/text. Arrays support only contains-membership and exists. Contains on text means literal substring; on an array it means exact normalized element membership. Other text comparisons are NFC-normalized, case-sensitive Unicode code-point order. Date comparisons use instants, not ISO spelling. Incompatible field values reject the query instead of being silently coerced.

Missing values produce an unknown predicate result except for explicit exists. `not` does not turn unknown into a match; `and`/`or` use three-valued logic and only true records enter C. Present null is distinct from missing and supports equality, inequality and membership; ordering or contains on a null record value produces unknown. All predicate branches are evaluated so a type error cannot be hidden by short-circuiting.

Search accepts `searchMode:'any'|'all'|'phrase'`, `searchCaseSensitive` (default false), and optional `searchFields` containing 1-16 unique declared scalar pointers. Defaults are title and data.description/text/system/type/status. Any/All split whitespace and semicolons outside quotes; Phrase treats the trimmed decoded input as one literal substring. Quoted content and escaped quote/backslash are supported; malformed quotes/escapes reject. Limits are 512 original Unicode code points and 20 terms. Shared Unicode casefold is used when case-insensitive; case-sensitive search still NFC-normalizes. Numeric/boolean selected search values use canonical text; null/missing and composite values do not provide searchable text. An All query may satisfy different terms in different fields; a single phrase cannot span field boundaries.

`baseTotal` and `matchTotal` describe C and its matches; overview counts describe the fixed analysis domain O; detail counts describe the exact detail window W. Search keeps detail context and only narrows overview marks. Density always uses C within O. Points and zero-duration sessions follow half-open membership; ongoing sessions are clipped to O for occupancy, not to wall-clock time. Maps use Decimal arithmetic and transport normalized knots as decimal strings with at most 34 significant digits.

## Presentation and Nested Layouts

The optional `presentation` model field and layout input follow [Presentation Extension v1](presentation-contract.md) and the strict shared schemas. Band colors/geometry/axis format IDs, source palettes, safe JSON-pointer grouping, scalar label fields, approved fonts/icons, inspector fields, baselines and nesting are accepted. Unknown fields, prototype-related pointers, arbitrary CSS, formatter code, font URLs and image URLs are rejected. Settings presentation is validated during complete snapshot import as well as model commands.

`POST Q/layouts` accepts a frozen presentation plus optional `theme` and `displayUnit`; it never looks up a mutable current model while laying out an existing query. With neither explicit presentation nor new record styling, previous geometry and row packing remain unchanged. New-style items return resolved `style`, measured `labelLines`, signed per-line `labelInkOffsets`, `labelLineHeight`, `labelOffsetY`, `geometryOffsetY`, `fullLabel`, parent/depth/ancestor metadata, and optional `iconX` and baseline coordinates. Record overrides are a strict allowlist in `record-render.schema.json`. Resolution happens before measurement, and renderer output must consume the returned profile.

The four registered Noto Sans variants provide measured advance/ink extents. Labels wrap by measured code-point prefixes and ASCII-space boundaries, respecting explicit newlines. A bounded ellipsis marks remaining content; `fullLabel` retains the complete text for expanded inspection. Icons reserve a fixed 16-pixel box plus padding. Original-date baselines use the same immutable time map and include their footprint and height. Effective global row height is rounded up from the resolved geometry, capped at 192 pixels; insufficient height for one row returns `row_height_limit`, never a zero-progress page.

Point rows reserve the full multiline label stack, including cases without any duration record to enlarge the row. Point icons sit five pixels left of the marker's actual radius, and left-side labels finish before the icon box. Point baselines sit below the complete label stack when present. These resolved coordinates are part of the shared Python/JavaScript geometry contract, not renderer-side guesses.

Typed grouping supports number, NFC text, boolean, null and missing values. Type order stays number/text/boolean/null/missing; descending reverses values within each present type, leaving null/missing last. Objects and arrays are rejected. Nesting uses one record per row in deterministic preorder; siblings use explicit order then start/end/ID. Only eligible same-group parents connect. Filtered, unauthorized or out-of-window parents are not injected. Enclosures describe connected parent blocks and never add canonical records. Row responses include clipped enclosure fragments with continuation flags; loaded counts exclude those repeated decorations. Existing 1000-record/2 MiB logical page limits still apply.

Overview marks additionally return their pinned `sourceId` and `render` overrides so the same pure style resolver can color overview and detail without another record fetch. Aggregate marks remain neutral and cannot imply a single source's color. Presentation changes never modify record dates, versions, parent relationships or transient selection/search metadata.

Guardrails are four retained queries per authenticated principal, a five-minute fixed query lifetime, two layouts per query, and one shared 256 MiB owned query/layout graph budget. Admission scratch and accounting indexes have separate explicit ceilings; these are not whole-process RSS guarantees. Public query/layout creation can return preparing `202` with `Location` and `Retry-After`, or ready `200`; poll the owned status URL until ready or failed. `Prefer: respond-async` requests immediate preparing status after admission. Preparation is limited to one active operation per principal, two globally, eight queued, and a 30-second publication deadline. Cancellation keeps active input charges and permits until work actually exits. See the [native API contract](api-contract.md) for exact response schemas and the currently measured admission-latency limitation.

These are safety ceilings, not certified performance claims. Layout width is 64-8192 CSS pixels; base font size 10-32; requested row height at least `max(32,fontSize+19)` and at most 128 on the legacy path or 192 on the enhanced path; available height at least one effective row and at most 8192. Approved authored label/record font overrides are 11-24 pixels. Page capacity is `min(100,floor(availableHeight/rowHeight))`. Global first-fit packing reserves measured bar/marker and label footprints with 4 CSS pixel clearance; explicit nesting instead uses consecutive preorder rows. Group headers consume rows.

Groups of at least 128 packed items use a coordinate-compressed interval/row-bitset index that returns the exact same first compatible row in the original record order. Smaller groups retain the reference scan. A portable 128 MiB temporary-index accounting ceiling fails with 413 `layout_capacity` before an over-budget bitset update; no incomplete layout or slow unbounded fallback is published. This index estimate is not a bound on whole-process RSS, coordinate objects or retained query/layout memory. Query-local parsed dates and exact integer range accumulation avoid repeated per-bin parsing without changing the full-scope density/overview counts. Page preflight buckets preserve original item order while avoiding a complete record rescan per logical page.

Row pages use zero-based inclusive `startRow`, exclusive `endRow` and zero-based `pageIndex`. Allocation is fixed before paging. A logical page above 1000 record projections or the reserved 2 MiB response budget is rejected before the layout is published, never silently truncated. Oversized-page fragmentation is not implemented. Overview above 1000 records uses counted overlap bins; a long session can contribute to several bins, while `total` remains a distinct-record count. Aggregate drill-down is not implemented.

## Full-Query Table API

`POST Q/records/query` maps to provider method `queryRecords(queryId,input)`. It reads the existing immutable query snapshot, not the loaded timeline row page or a second snapshot pool. It never changes workspace state or requires mutation preconditions, but bearer authentication and query lifetime rules still apply.

```json
{
  "scope": "all",
  "projection": "context",
  "sort": [{"field": "start", "direction": "asc"}],
  "limit": 100,
  "cursor": null
}
```

Omitted values use the defaults shown. `scope` is `all` or `window`; projection is `context` or `matches`. All scope addresses all of the query's filtered C, including records outside overview domain O. Context keeps search context; matches explicitly selects M. No new filter/search predicate is silently inferred from a table page.

Window scope requires `window:{from,to}` using strict ISO instants, with optional `viewFromMs` and `viewToMs` exact decimal strings. Each supplied decimal bound is authoritative and otherwise falls back to its corresponding ISO instant. The positive window must remain within query domain O. Response normalization returns `from=floor(left)` and `to=ceil(right)` as UTC millisecond ISO strings, plus both exact decimal bounds. Those ISO values are conservative retrieval bounds, not membership predicates. Decimal strings have at most 34 significant digits, no exponent, and normalize signed zero to `0`. All scope accepts only absent/null window. Changing a current-range window creates a distinct table cursor identity, without redefining C or the map.

Canonical point events and zero-duration sessions use `[left,right)` membership. Other sessions use interval overlap, including sessions beginning before the window and ongoing sessions with null end. The table has one entry per canonical record; it does not repeat structural group headers or multi-row timeline projections.

Sort contains one to three distinct `{field,direction}` entries. Canonical fields and schema-declared scalar `/data/...` pointers are admitted through the query's `fieldTypes` registry. Built-in pointer aliases normalize to canonical table names; custom paths remain JSON Pointers. Dates compare instants, numbers numerically, booleans false before true, and strings by NFC-normalized Unicode code points, without locale collation. Present values precede explicit null, which precedes missing, in either direction. Final ties use ascending canonical ID. Arrays can be displayed but are not scalar sort keys. Schema scope must declare compatible field types throughout the complete query; no type is inferred from only a loaded page.

Responses include query/snapshot/generation/revision provenance, `tableId`, normalized scope/window/projection/sort/limit, `baseTotal`, `matchTotal`, `total`, `matchActive`, and `items:[{record,match}]`. `baseTotal` counts C within the table's chosen scope; `matchTotal` counts M within that scope; `total` counts the selected context or matches projection. Empty search has `matchActive:false`, even though every context record is a match. These are complete-scope totals, never the loaded timeline count.

Paging fields are zero-based inclusive `startIndex`, exclusive `endIndex`, zero-based `pageIndex`, `pageCount`, previous/next opaque cursors and `pageComplete:true`. Empty results have one empty page, zero indices and null cursors. `limit` is an integer from 1 through 1000, default 100. Each page is the longest sorted prefix within that record ceiling and the byte budget. Per-item cost is its RFC 8785 encoded length plus one comma byte; the item budget is 2 MiB minus a fixed 16 KiB envelope reserve. The HTTP response itself uses canonical JSON and is checked against 2 MiB. Consequently a large-record page may contain fewer than the requested limit, but never skips a record, mislabels a partial page or invents page counts. All boundaries are computed against the complete sorted projection.

Cursors are authenticated and bind the query snapshot, normalized defaults, scope/window, projection, sort, limit and page boundary. Changing any of those inputs cannot reuse a cursor. Later record/model mutations do not alter existing pages; a new query observes the new revision. Two table orderings per query are retained in an LRU cache. Evicted orderings rebuild deterministically from that same immutable query, so valid cursors survive cache eviction until query expiry/release. Timeline row cursors cannot be used as table cursors. Existing placement lookup supports an explicit reveal action for a table record and returns outside-layout when it is not in the current timeline layout.

Table errors are 400 `invalid_table_cursor`, 422 `invalid_table_query` or `invalid_table_sort`, 413 `table_payload_limit`, and the existing missing/expired query errors. The older `GET B/records` current-state list remains available but is not the immutable table traversal API.

Errors use `application/problem+json` with `code`, `message` and `status`. Common statuses are 400 malformed JSON/cursor, 401 authentication, 404 missing record/handle/outcome, 409 generation/key/relationship conflicts, 410 expired query, 412 stale record version, 413 size limit, 422 validation, 428 missing write preconditions, 429 artifact capacity, and 503 unavailable or unknown commit outcome.

Remaining product gates include field-level authorization, complete workspace/root administration, all-model legacy compatibility, full migration/jobs, live synchronization qualification, retention/compaction, production backup/restore scale evidence, comprehensive cancellation/resource admission and oversized-page fragmentation. See the [release checklist](release-checklist.md), native contract's pending-route ledger and implementation status. Passing individual API tests is not full-release certification.
