# Backend Verification

This records actual backend tests for the JSON timeline service, visual-model catalog, styled/nested layouts, structured filtering/search and full-query table API, executed on Windows with the project virtual environment. It is not a claim that every product acceptance gate has passed.

## Executed Commands

```powershell
.venv/Scripts/python -m pytest tests/server -q
.venv/Scripts/python -m ruff check server tests/server scripts
```

Latest complete-suite run during the current release integration: **377 passed,
two failed, one skipped**, in **128.57 seconds**. Both failures are old table
fixtures containing `data.status:null` or a numeric status; the new strict built-in
schema rejects them at startup before table sorting. They are recorded as pending
fixture/contract integration, not a green full-suite result. The skipped test needs
actual Windows symlink-creation privilege. A separate portable reparse-attribute
test passes but does not replace that filesystem test.

Before those catalog/identity integrations, compiled startup-validation changes
passed the then-complete **282-test** suite in **31.07 seconds**. New storage suites
subsequently passed **95 tests with one skip**. The final focused seven-case run
also passed, adding interrupted initial seeding, bounded raw-file rejection,
portable reparse rejection and explicit verification that split recovery actually
retires an old shard. These overlapping runs are not additive test totals.
Scoped Ruff checks for the changed repository, migration, benchmark and storage
test files reported **All checks passed**. Pytest emitted two upstream deprecation
warnings from Starlette TestClient/httpx and the AnyIO BlockingPortal alias.

The API was also smoke-tested through a real FastAPI `TestClient` lifespan: public health returned 200 and authenticated initialization returned the 48-record shared sample. Real HTTP, browser, standalone and cross-provider end-to-end evidence is maintained separately by the integration owner.

## Exercised Coverage

| Area | Executed Assertions |
| --- | --- |
| Authentication | Public bounded health; unauthorized workspace denial; bearer challenge; no-store headers; token absent from health and export. |
| CORS | Null origin denied by default; explicit null-origin preflight succeeds; opt-in does not remove authentication; wildcard configuration rejected. |
| CRUD | Create, supplied-field update, soft delete, tombstone lookup and restore; audit/version increments and server-committed result. |
| Preconditions | Missing headers rejected; generation conflict; stale ETag rejection; read-only missing-outcome lookup leaves revision unchanged. |
| Idempotency | Identical create retry returns the same result/revision; different content with the same key conflicts; persisted outcome lookup. |
| Revision capacity | The final safe-integer workspace revision can commit; a subsequent record mutation fails before altering any JSON file. Original idempotent replay still succeeds at capacity and after reopening the root. |
| JSON validation | Duplicate properties, NaN, Infinity, lone surrogate and unsafe integer rejected. Invalid dates, timezone omission, excessive fractional precision, event end, unsafe color, unknown field and missing parent rejected. |
| Relationships | Parent session cannot be implicitly deleted while it has an active child. |
| Search and scopes | Search narrows overview while preserving detail context and identical complete density; counts remain full-scope rather than loaded-page counts. |
| Row pages | All sample records appear once across pages; fixed map identity, exact row capacity and nonoverlapping measured footprints; tampered cursor rejected; placement resolves to its row/page. |
| Grouping | A structural source header consumes its own row and precedes source records. |
| Snapshots | A mutation does not change an existing query's density; a new query sees the added record; explicit export count equals complete record payload. Internal query copies omit only the unused export digest, remain isolated from later writes/caller edits, and do not invoke checksum calculation. Public exports still hash and cannot disable integrity through query parameters. |
| Artifact lifecycle | Four-query limit enforced; explicit release permits replacement; expiry produces an expired-query response. |
| Single writer | Second repository owner is rejected while the first lock is held; closing permits reacquisition. |
| Interrupted commit | Injected installation failure after the committed journal decision freezes access; restart redoes record, revision and outcome; retry remains single-commit. |
| Prepared transaction | A journal with no committed decision does not publish its proposed revision. |
| Concurrent writes | Eight competing edits from the same version produce one winner and seven version conflicts, with exactly one revision increment. |
| Storage | Persisted records use JSON files; no database artifact is introduced. |
| Completeness | Missing workspace metadata never reseeds or overwrites existing records; missing record files fail startup; configured empty sources survive export and the first write; missing selected model fails before seed persistence. |
| Export CLI | Uses the complete snapshot endpoint; validates schema, scope, count, IDs and model references; rejects redirects without forwarding the bearer token; refuses overwrite; removes its own partial output on simulated fsync failure. |
| Density math | Half-open right-edge exclusion, zero-duration points, ongoing overlap and true endpoint accounting. Twenty seeded 200-record fixtures compare optimized occupancy/overview counts with an independent interval/bin oracle; nonuniform bins, outside-domain records, millisecond domains and exact large integer overlap totals are exercised. |
| Exact indexed packing | One thousand seeded arbitrary-order inputs compare the accelerated allocator with original first-fit placement. Exact four-pixel touching, duplicate intervals, the small-input path, 25,000 simultaneous footprints, invalid values and the portable temporary-index memory rejection are checked. Page-budget buckets preserve original item order. |
| Map math | Strict monotonicity, endpoints zero/one, bounded slope ratio and decimal transport precision. A 1 ms view in a millennium-scale domain retains a correct 500 px midpoint in a 1000 px plot. |
| Date and text parity inputs | UTC date round trips at years 0001/9999 and offset input; shared sharp-s and dotted-I casefold; quoted search grammar. |
| Measured labels | Wide and narrow glyphs have different measured widths; measured ellipsis fits its tested bound; unsupported glyph is diagnosed. |
| Legacy visual catalog | Flat presets normalize deterministically to published version 1; reads do not write workspace files; the first authorized record mutation freezes those publication dates before advancing snapshot time. |
| Model lifecycle | Draft creation/update, immutable version publication, no implicit apply, archive/unarchive, archived edit/publish/apply rejection, usage and referenced-model deletion guards. |
| Explicit Apply | Older published version can be pinned; all definition settings update together; model revision stays unchanged while workspace revision advances; range, overview and reference time remain unchanged. |
| Model concurrency | Stale revision rejected; four competing edits yield one winner; retry returns the original result; record/model idempotency-key reuse conflicts. |
| Model recovery | Interrupted model/outcome installation recovers catalog, workspace revision and outcome; all record file bytes remain unchanged. |
| Model validation | Unknown fields, wrong types, invalid options, numeric timezone offsets and lowercase IANA variants rejected; UTC/New York/Paris/Tokyo accepted through the shared catalog; 100-model and 32-version ceilings enforced; canonical default pin required. |
| Snapshot checksums | Original legacy content verified before normalization; tampered content rejected; canonical export rehashed and revalidated; RFC 8785 numeric serialization and UTF-16 property ordering exercised. |
| Complete table traversal | Table traverses all 48 query records independently of the loaded two-row timeline page; 17/17/14 paging has no duplicate or omitted IDs; previous-page replay retains the exact payload and provenance. |
| Table sorting | NFC/code-point ordering, astral/BMP strings, case-sensitive comparisons, ascending ID ties, multi-column ordering, instant-based date sorting and null/missing-last rules in both directions. Unsupported status types are checked across the complete selected projection, not just the first page. |
| Table windows and search | Half-open points/zero-duration sessions, overlapping and ongoing sessions, fractional-millisecond bounds, context/matches counts, all-query records outside the overview domain and normalized default cursor identities. |
| Table cursor stability | Later writes do not change pinned pages; new query sees new records; two-entry LRU eviction can rebuild the same order; changed query, sort, projection or capacity and altered cursors are rejected. |
| Table payload limits | Eighteen large records with float arrays require multiple deterministic byte-bounded pages; actual canonical HTTP bodies remain within 2 MiB; every ID appears exactly once and page counts remain stable. |
| Table validation | Allowlist and parameter validation, empty results, authentication, expiry, signed-zero normalization and the 34-significant-digit boundary are exercised. |
| Presentation validation | Unknown properties, unsafe/invalid/deep field pointers, duplicate source styles, blank inspector labels, unsupported fonts/icons/colors and arbitrary formatter identifiers are rejected. Escaped own-property JSON pointers and scalar label text are exercised. |
| Styled geometry | Unstyled models preserve previous geometry. Band/source/record precedence, bold-italic metrics, icon footprint/height, measured multiline wrapping, explicit newlines, overflow/full labels and baseline coordinates/height are checked. Point-only four-line labels reserve 144-pixel rows, or 148 with a baseline below the complete label stack; a ten-pixel marker radius preserves icon and left-label clearance. Insufficient effective height fails without publishing a layout. |
| Typed grouping | Number/text/boolean/null/missing ordering, descending within each present type, NFC-equivalent group merging and composite-value rejection are exercised. |
| Nested pages | Five connected records page 2/2/1 in explicit preorder with stable placement and clipped enclosure continuation flags. Out-of-window and cross-group parents are not injected or connected; cycles fail. Canonical records/counts are not duplicated for enclosures. |
| Presentation persistence | Published definitions preserve optional presentation, apply removes stale presentation when switching to an older plain model, complete exports revalidate, record styles and model pins survive repository close/reopen, and the original committed outcome remains recoverable. Invalid settings overrides fail import. |
| Filter predicates | Equality/inequality/order/membership/contains/exists/overlaps, typed operands, timestamp equivalence, NFC/code-point order, literal casefolded text and exact string-array membership are covered. Missing/null three-valued boolean logic is explicit. |
| Filter limits | Unknown fields/operators, wrong types, numeric date operands, non-ISO dates, unexpected keys, empty groups, 100-node/eight-level bounds and 100-value membership limits are enforced. Invalid typed branches cannot hide behind short-circuiting. |
| Extended search | Any/All/Phrase, case sensitivity, selected scalar fields, quoted terms/escapes, declared Unicode whitespace, original-code-point limits and 20-term limits are exercised. Phrases cannot span field boundaries. |
| Shared filtered snapshot | Expression-filtered counts, density, overview and table agree on the same immutable record set; a later mutation changes only a new query, and unknown query-filter keys are rejected. |
| Startup validation | Complete offline registered-schema validation, explicit declared dialect, UUID/date-time/Unicode/integer/reference parity, one record-local and one relationship pass, deterministic bounded readers, failure drain before owner release. |
| Journal v2 | Complete checksummed before/after preparation, target installs before commit marker, true subprocess exits and injected failures, old-state rollback/new-state redo, two restarts, interrupted recovery, missing targets, path/checksum/revision conflicts and legacy v1 interpretation. Known commit remains successful if cleanup fails. |
| Storage admission | One MiB raw record bound plus canonical record-size validation; bounded descriptor read and in-read change detection; complete journal limit before preparation; external target changes freeze writes without overwrite. |
| Authoritative shards | Deterministic UUID-prefix splitting, four MiB shard bound, manifest/checksum/count validation, no mixed legacy/shard authority, all records validated at startup, source-independent date edits, record/model revisions, actual split rollback/redo. |
| Offline migration | New inactive destination only; complete records/outcomes/identity metadata preserved, source JSON unchanged, unknown authority rejected, incomplete destination cannot start, competing writer and nested/existing paths rejected. |

Test files are in `tests/server/test_api.py`, `test_repository.py`, `test_geometry.py`, `test_row_packer.py`, `test_security.py`, `test_export_cli.py`, `test_models.py`, `test_table_query.py`, `test_presentation.py` and `test_filters.py`. Fixtures create temporary JSON roots and do not mutate the user's persistent application data.

The separately executed benchmarks and raw reports are documented in [Performance
Measurements](performance.md), not counted as pytest cases. Original production
startup exceeded 120 seconds; normal startup after validation changes measured
107.667 seconds. Explicit authoritative shards reduced a later normal 100,000-record
startup observation to 16.369 seconds with complete validation and 25 shards.
The earlier service-only run measured 6.96-second query/density preparation,
43-millisecond overview aggregation and 12.71-second full-month allocation. None
of these single observations certifies the controlled performance gates.

## Not Established

The failure injection is deterministic process-level evidence, not a power-cut experiment. Filesystem corruption, disk-full behavior at every fsync/replace boundary, Windows hardware durability and backup restore remain unverified. Tests do not certify public-network deployment, role/permission isolation, adversarial multi-tenant workloads, all normative resource ceilings, million-record performance, batch recovery, arbitrary legacy-model migration, arbitrary font shaping or complete model compatibility. Content hashing is integrity checking, not authenticity; broader Python/JavaScript differential and browser evidence is maintained by the integration suite rather than inferred from these unit tests.

The current endpoints and precise first-slice limitations are documented in [Implemented Python API](api.md). The product specification remains the release target; this test result is evidence for the implemented increment only.
