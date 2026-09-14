# Integration Test and Code-Delivery Plan

Revision 2.4 planning supplement, prepared 12 September 2026. This is a future verification contract, not application code or an execution report. No test, browser workflow, benchmark, security scan or storage fault experiment is claimed as run. The current task remains prompt refinement; implementation starts only after explicit user authorization, with G0 readiness required before dependent code.

The main specification governs canonical records, JSON persistence, security and all-model compatibility. The required implementation uses a Python backend and modular JavaScript/Three.js frontend, orthographic by default. A light two-band timeline retains bottom axes, vertical zones, nonlinear detail mapping and complete-scope density. Server mode pages server-owned rows; Local mode computes equivalent rows from a complete bundled/imported JSON dataset. A generated self-contained index.html must work through file:// without any server or external assets. Classic blue and dark remain compatibility fixtures. The [adaptive scale](adaptive-scale-contract.md), [query/row](adaptive-query-contract.md) and [provider/standalone](provider-standalone-contract.md) contracts govern shared behavior; tests must not invent competing semantics.

## 1. Gates Before Code Delivery

Freeze requirement IDs, supported platforms, contracts, fixtures, expected results and repository-native verification commands before dependent handlers. Map REQ-01-59, A01-A92 and every companion case to tests and evidence, checking the final main-document numbering before release. New modes do not replace existing coverage.

| Gate | Required exit evidence |
| --- | --- |
| G0: Contract readiness | Freeze Python/JavaScript module boundaries, provider parity, complete-snapshot format, offline authority, fallback/reconnection, scale/row contracts and declared limits. Approve OpenAPI/JSON schemas, fixtures, oracles and this plan before dependent implementation. |
| G1: Component correctness | Formatting, lint, type/static analysis, Python/JavaScript unit/property parity and production builds pass. Test modular imports and the single-file dependency closure. Regression tests reproduce relevant legacy failures before validating replacements. |
| G2: Real server integration | API, authorization, real-JSON persistence, process-fault/restart, backup/restore and concurrency suites pass on both storage platforms. |
| G3: Browser integration | Production frontend plus real Python server passes complete workflows, synchronization, paging and models; the generated file:// artifact separately passes Local CRUD/export and provider parity with networking blocked. No mocked persistence success path. |
| G4: Quality and limits | Visual, manual accessibility, security and supported-scale performance gates pass with retained evidence. Unsupported stress results are disclosed separately. |
| G5: Clean delivery | Clean-install/rebuild the exact Server candidate and verify migrate/restart/restore. Copy only generated index.html into an otherwise empty directory and pass the Local suite without Python, Node or a web server. Review commit-bound evidence before code handoff. |

G1-G5 must run before delivering implementation code as ready or complete. Incremental review material must be labeled incomplete and cannot bypass dependent gates. Mandatory failures, missing environments, skipped tests, unexplained flakes or missing evidence block the corresponding gate and final delivery. Never count skipped/blocked/not-run as passed, silently remove a required test, or weaken a target after observing failure. Fix defects and rerun affected suites plus shared-contract regressions; retain earlier failures and explain any retries.

CI runs G1 on every change and affected integration/browser suites on shared-contract changes. A release candidate runs the complete supported matrix. Evidence must identify the delivered commit and dependency lockfiles; results from an earlier candidate cannot certify changed code.

## 2. Supported Verification Matrix

G0 records exact supported versions, CPU, filesystem, runtime, fonts and browser binaries in a machine-readable manifest.

| Environment | Mandatory verification |
| --- | --- |
| Windows Python server on NTFS | Clean build/install, full API/storage faults and restart; actual Chrome, Edge and Firefox desktop workflows. |
| Linux single-writer container, persistent local filesystem volume | Same API/storage/recovery suites and clean deployment; Chromium and Firefox browser integration against that server. |
| Standalone file:// | Actual Chrome, Edge and Firefox on Windows; Chromium/Firefox on Linux. No server process, disabled networking, absent sibling assets, both worker-enabled and worker-denied execution. Browser-specific failures block that advertised Local environment. |
| Browser geometry/input | 1600x900, 1440x900, 1280, 1024 and 390 px widths; 360/768/1200/1440 breakpoint boundaries; device scales 1 and 2, 200% browser zoom, keyboard and touch-pointer paths. |
| Additional claims | WebKit engine checks are not native Safari/iOS evidence. Native Safari, physical mobile devices or other filesystems need their own passing matrix before those environments are advertised as verified. |

Network/shared-disk multi-writer deployment stays unsupported. Distinguish responsive emulation from physical touch/device testing. Use isolated disposable roots, ports and credentials; never run destructive fault cases against user data.

## 3. Deterministic Fixtures

Every fixture has canonical UUID mappings, checksums, generator version/seed, schemas/models, authorized principals, clock, expected IDs/counts and cleanup instructions. Expected sets come from independent reference calculations, not the production query/layout function.

| Fixture | Exact purpose and oracle |
| --- | --- |
| Classic-14 | Preserve all 14 original aliases/times/colors, groups 6/4/4 and EVT-004. In its linear compatibility mode, end 15:45 to 16:00 changes duration 00:40:00 to 00:55:00 and endpoint 919.50 to 994, then reload and restore. |
| Dark-40 | C=40. Search `5_1` gives exactly SOURCE1-14/SOURCE2-14; `0_3` gives SOURCE1-05/SOURCE2-05. Context remains 40; overview data and match counts contain exactly two. |
| AS-MAP-01 | Reduced four-bin unit oracle: O=[00:00,04:00) UTC, density [0,3,3,0], R=4, weights [1,4,4,1], normalized knots [0,.1,.5,.9,1]. The four-bin test does not relax production bin limits. |
| AS-UI-01 | Light visual target: O=00:00-24:00, accepted hand-specified knots (00:00,0), (12:00,12/27), (13:00,16/27), (24:00,1); W=08:00-17:00. This is a mapping/render oracle, not evidence that a density solver produced those knots. |
| ROW-05 | Five overlapping sessions P01-P05, all [10:00,11:00), identical style and stable ID order, ungrouped without headers. Five 32 px rows, 64 px available height and rowLimit=2 yield 2/2/1; combined pages contain each ID once. |
| Boundary/privacy | Points, equal endpoints, ongoing and cross-window sessions, nested/out-of-parent activities, missing fields, zones, authored yellow, long/bidirectional labels, denied sources and two isolated workspaces. |
| LOCAL-COMPLETE | A versioned complete-scope package with all records, definitions, source policies and approved embedded assets. Declare exact IDs, member hashes and schema/model references; a server row-page envelope containing a strict subset is an explicit negative fixture. |
| PROVIDER-PARITY | Identical canonical JSON, profiles, fixed clock, filters and complete dataset in Python and JavaScript. Expected sets, density components and row membership are independently defined; provider-local handle/epoch identifiers are not required to match. |
| Scale tiers | Seeded 1,000 / 100,000 / 1,000,000-record fixtures; typical tier has 100 groups and average serialized record <=2 KiB. Stress is unsupported until measured, never substituted for typical correctness. |

Include empty, one-instant, equal-density, distant-outlier, concentrated-density and hidden-row-page variants. Keep those separate from Classic-14; adding density records must not alter its authoritative count.

## 4. Unit and Property Tests

Test canonical validation, schema/version references, structured filters, Unicode search, half-open windows, valid/invalid leap years, DST gap/fold and historical dates. A session ending at 10:00 does not match [10:00,11:00); a session spanning 09:00-12:00 does; a point at 11:00 does not. Zero-duration sessions use point inclusion while retaining their kind. Run these in Python and JavaScript, including strict JSON rejection, missing/null distinction, integer precision and nonfinite numbers.

Explicitly exercise MILLISECOND, SECOND, MINUTE, HOUR, DAY, WEEK, MONTH, YEAR, DECADE, CENTURY and MILLENNIUM, plus every inventoried format. Check years 0001, 0099, 0100, leap-century boundaries and the supported upper date boundary without JavaScript's short-year reinterpretation or a 1970 cutoff. Combine a millennia-wide O with a 1 ms detail window near its far endpoint: normalized floating-point cancellation must not collapse a/b, alter membership or evade the rendered inverse tolerance. Calendar intervals use actual zone/calendar boundaries, not fixed 31-day months or 365-day years. Unknown formats/units and unsupported sentinels produce matching diagnostics, never fallback-to-hour. Record timezone-data/runtime versions and investigate cross-provider differences rather than blessing whichever result appears first.

For AS-MAP-01 on a 1000 px nonlinear plot, 00:30/01:30/02:30/03:30 map to 50/300/700/950. Session 00:30-02:30 spans [50,700]; zone 01:15-02:15 spans [200,600]. The same zone on the linear 1000 px overview spans [312.5,562.5], not the detail coordinates.

With mapped viewport [.1,.5], W is 01:00-02:00. Drag content right 100 px: viewport [.06,.46], W=00:36-01:54, and 01:30 moves 500 to 600 px. The linear overview highlight moves [250,500] to [150,475]. Zoom 2x about 01:30 from the original viewport yields [.2,.4] and W=01:15-01:45. Every vertical page preserves these values.

Also drag the overview selection body: grabbing 01:30 then moving to 02:45 gives [.6,1], W=02:15-04:00 and highlight [562.5,1000]. Right edge to 02:30 gives [.1,.7]; left edge to 00:30 gives [.05,.5]. Verify no flipped/zero span, minimum 1 ms, cancellation without writes and keyboard equivalence in both providers.

For AS-UI-01, normalized detail x is 1/3 at 12:00, 2/3 at 13:00 and .5 at 12:30. Orange zone 12:10-12:45 spans [7/18,7/12]; cyan 12:30-13:20 spans [.5,25/36]. The linear overview's W highlight is [8/24,17/24]. Overlapping zones are intentional background annotations; their fill/label layers must not obscure records or become density contributions.

Property suites check finite endpoints, strict monotonicity, continuity at every knot, bounded positive slopes, deterministic mapping independent of input/page order, and forward/inverse round trips. Use the scale contract's integer-millisecond round-trip bound (1 ms) or rendered inverse error <=0.25 CSS px; real projection assertions allow <=1 CSS px. Run at least 1,000 deterministic generated cases per mapping/layout property, retaining failing seeds and minimized counterexamples. Cover empty/equal density, extreme permitted magnification, unit/domain boundaries and invalid parameters.

Validate full label/icon/baseline footprints, complete parent blocks and the legacy occupied-track counterexample. Require 4 CSS px unrelated-footprint clearance with <=0.5 px measurement epsilon, not allowed overlap. Test own-icon clearance, measured fonts, wrapped labels, camera projection, bounded caches and cancellation. Navigation, layout and search must not change canonical bytes or versions.

## 5. API, JSON and Synchronization

Run contract tests through HTTP against real temporary JSON roots. Independently parse every persisted document and inspect committed versions, journals and query revisions. Cover CRUD, nested batches, model/schema drafts and publication, filters/settings, read-only sources, ETags, idempotency, import/export, jobs, backup/restore and permissions.

Assert ROW-05 through Server HTTP endpoints and the Local provider interface. Every response binds the same provider epoch/snapshot, map and layout; all vertical pages retain W and O. Concatenation has no missing/duplicate data IDs; continuation headers never inflate counts. Changing filters, geometry, model or expansion rejects incompatible cursors explicitly. Record pagination is not row pagination. Traverse Server page ten during five writes/second without endless restarts.

Changed height/reservations invalidate old cursors. An oversized first row uses bounded scrolling or row_height_limit, never an empty no-progress page.

Recompute density independently over the entire authorized filtered C within O, including records absent from loaded rows. Page changes cannot alter bins, domain, totals or mapping. Search M affects findings-only overview membership, not authorization or implicitly the contextual base. Test offscreen findings, parent exclusions, zero matches and authored yellow; restore exact styles on clear.

Assert baseTotal/matchTotal for C/M, overviewTotal/overviewMatchTotal for C_O/M_O, and detailTotal/detailMatchTotal for C_W/M_W. Conservative fetchWindow envelopes, footprintOnly instances, ancestors and continuation headers never inflate exact window totals. Domain extension replaces the complete bundle; no extrapolated page reuses old map identity.

Verify 1,000-projection/2 MiB response bounds, oversized nested-block row continuation and same-page payload fragments. Fragment cursors cannot advance time or masquerade as next vertical rows. Page completion is explicit only after all fragments; incomplete content is labeled. Reject a logical page requiring more than eight fragments before its first fragment, suggesting fewer rows or an approved profile. If one row alone exceeds that cap, return row_payload_limit, never a successful truncated row.

Use two browsers plus API writers. Pinned mode retains one complete old rows/map/density/count set and announces changes. Live mode stages a coherent replacement query/map/layout/anchored page, then swaps atomically; no frame mixes revisions. Test update coalescing, successful local edits, permission revocation, disconnect/replay, duplicate/reordered SSE, fallback polling, stale replies, expired cursors and restored generations. Selection/drafts survive when authorized; revoked content disappears immediately.

Freeze geometry during active gestures. Test hysteresis at/beyond 0.002 normalized change, 30-second retention expiry, two-second replacement spacing and 500 ms idle. Test interactionHold above threshold and minimum 1 ms zoom without rounding inverses. Retained knots need fresh snapshot/density provenance, never stale counts labeled current. Explicit Recompute bypasses delays; permission enforcement never waits for idle. Replacing a map preserves UTC window endpoints, not every interior pixel.

Kill the server before/after PREPARED, each target replacement, COMMITTED and publication; restart twice. Before commit, recover the complete old transaction; after commit, recover the complete new transaction exactly once. Inject disk-full, access denial, file-sharing contention, corrupted indexes, interrupted backup, second writer and out-of-band edits. Retry a lost successful response without duplication. Preserve forensic files on failure; do not claim power-loss safety from process-kill results.

## 6. Browser, Visual and Accessibility Journeys

Server E2E uses real responses and durable reload/restart assertions; Local E2E uses the actual packaged file and verifies persistence only through explicit JSON export/re-import. Load the light default; verify two temporal bands, bottom axes and a complete-scope overview. Draw zones behind records through each band's transform; clip at boundaries without covering axes or intercepting navigation. Zones are annotations, not timezones, sessions or density contributions.

Pan, zoom, change vertical page, reveal an unloaded selection, search, filter, regroup, inspect, edit, conflict, cancel and switch Timeline/Table/Split. Repeat under resize, delayed fonts, both cameras and two independent instances; test disclosed Uniform transition when Adaptive is camera-incompatible. Assert coordinate and record-ID behavior, not merely successful clicks. Test all model families and library/JSON editor/preview/diff/publication workflows, including two of five references upgrading while three stay pinned.

Capture actual browser PNGs, traces and visual diffs for default/selected, zones, nonlinear boundary crossing, each row-page state, search, full Table/Split, model management and loading/empty/stale/error/read-only/conflict states. Freeze fonts/clock/data; use independent pixel/DOM/projected bounds and nonblank canvas checks. Classic's 2 px reference tolerance applies only to its declared linear fixture, not the new light layout.

Run automated accessibility checks plus manual keyboard, focus restoration, screen-reader names/counts/page changes, non-color search/zone cues, touch alternatives, contrast and reduced-motion reviews. Table/inspector must expose every authorized record; canvas-only or hover-only access cannot pass. Retest focus and selected-record reachability across row fragments, pagination and responsive transitions.

## 7. Performance, Security and Evidence

Use the frozen 4-core/16-GiB/local-SSD environment and production build. Run at least five cold starts and thirty warmed samples; report distributions and raw data. Retain main targets: readiness <=30 s; typical warm page/save p95 <=300 ms; supported linear workspace <=3 s; frame p95 <=33 ms; no repeated >200 ms stalls; server RSS <=2 GiB with 20 clients/five aggregate writes per second. Adaptive cold preparation has a separate provisional p95 <=10 s target, with overview/status visible <=3 s; status-only is not interactive complete detail.

Measure density/layout creation separately from row fetch, including concurrent live rebuilds. Uniform live confirmation remains p95 <=1 s. Adaptive notice/stale indication is p95 <=1 s; coherent warm refresh is p95 <=3 s after eligible idle, cold refresh p95 <=10 s. Measure geometry hysteresis separately; notices never count as completed swaps. Server page requests must not download all records; explicit complete Local-export preparation is a separate operation. Assert bounded payload/cache/worker/queue growth and complete-scope correctness after cache rebuild. Run 100 mount/filter/page/model/reconnect cycles and compare settled memory. A faster incomplete result fails.

Attack all query/density/layout/overview/zone/fragment and mutation endpoints for cross-workspace leakage, forged scopes/cursors, hidden-field counts, traversal/reparse escapes, hostile labels/assets, oversized inputs, expensive predicates, token revocation and read-only bypass. Exhaust session/layout/memory admission: require explicit 429 without evicting promised handles. Permission changes invalidate whole affected snapshots; no stale density or count leaks survive.

Store evidence under `artifacts/verification/<commit>/<run-id>/`: manifest with exact commands/exit codes, environment and fixture hashes/seeds; JUnit/JSON results with pass/fail/skip counts; HTTP/contracts and sanitized traces; storage crash/recovery logs; browser traces/screenshots/diffs; accessibility checklist; benchmark raw samples/profiles; security findings; clean-install transcript; and requirement-to-test status. Report missing artifacts as missing. Final delivery includes reproducible commands and unresolved limitations, never a mockup or a green summary standing in for these gates.

## 8. Standalone Dependency Closure

Generate index.html through the production packaging command from modular sources. Copy only that file to a new directory with spaces and non-ASCII characters; start a fresh browser profile at its file:// URL with external networking denied and no Python, Node, CDN, web server or sibling files available. Local startup and every required workflow must function, not merely render an initial canvas.

Audit the build dependency graph and observe actual requests. JavaScript, Three.js, styles, fonts, icons, textures, shaders, approved assets, schemas, workers and initial data must be embedded or generated in memory. No runtime HTTP(S), CDN, local-file fetch, dynamic import or source-map dependency may be necessary. Distinguish internal data/blob URLs from external requests. Reopen after deleting build directories and caches to expose accidental development dependencies. Record console errors, rejected requests and canvas pixels; a missing texture/font or silent fallback cannot pass unnoticed.

Test Blob workers normally and with construction blocked or unsupported. The cooperative fallback must run the same algorithms, show progress/cancellation, keep controls responsive and produce identical final semantic results; no server-only computation remains hidden behind a worker. Verify the eight-millisecond work-slice budget and cancellation at slice boundaries, including parsing/validation of admitted large JSON. Revoke object URLs and dispose workers, listeners, timers and GPU resources through repeated import/provider/model switches.

Current bounded implementation has the embedded worker and a functional direct fallback, with focused worker/browser regressions linked from [standalone mode](standalone-mode.md). Direct fallback is not yet cooperatively sliced. The eight-millisecond fallback gate above remains required and cannot be marked passed from functional startup-denied tests or a single 25,000-record worker responsiveness observation.

Import strings containing closing-script sequences, quotes, Unicode separators and hostile HTML/URLs. Embedded JSON must remain inert data without breaking HTML parsing or executing metadata. Reject remote asset references or unresolved dependencies through the documented import policy; do not fetch them silently. Verify the standalone file contains no API tokens, bootstrap secrets, server paths, private keys, hidden records or unauthorized metadata. A shipped artifact cannot make formerly exported data remotely revocable.

## 9. Provider Parity and Complete Data

Run the same fixture manifest and at least 1,000 seeded property cases through Python Server and JavaScript Local providers. Compare exact canonical IDs, kind/time/filter/search results, counts, group order, parent context and normalized validation codes. Use Unicode 15.1 tables and default non-Turkic `NFC(fullCaseFold(NFC(text)))` for caseless comparison; validate the original input's 512 search/500 title codepoint limits before folding. Include astral characters, combining sequences, fold expansion and characters whose casefold differs from lowercase. Runtime-default Python Unicode or JavaScript Intl behavior is not an oracle. String ordering uses NFC codepoints and is case-sensitive; present values precede explicit null then missing in either direction, final ID ties stay ascending and mixed nonnull types fail. Strict timestamps, safe integers and finite numeric fields must agree. Compare density counts and overlap-length integers exactly, including decimal-string transport above 2^53; normalized occupancy/knots use the declared floating tolerance. Independently verify forward/inverse and rendered bounds at 1 ms/0.25 CSS px/1 CSS px. Transport cursors and epoch/layout IDs remain provider-scoped, not identical strings.

For identical render profiles, compare row membership/order, complete fragments, context exclusions, zones and relative placement. Different shaping metrics require an explicit different profile/layout identity and collision-free validation, not silent repacking of an existing page. Cross-profile/provider comparisons retain exact eligible IDs/counts and time-coordinate tolerances without pretending different shaping engines must allocate identical row breaks. Exercise all time units and cameras, Uniform/Auto, overview drag/resize, search, filters, Table/Split, descriptor, selection, model drafts/validation/publication and source policies in both modes.

A Local package is complete for its declared authorized workspace or source-set scope. A time/search/page-filtered export cannot masquerade as that complete package. Validate schema/version, unique IDs, manifest counts/member hashes, every relationship, required definitions and embedded assets before an atomic memory swap. Independently verify structured-member SHA-256 over UTF-8 RFC 8785 canonical JSON, including its own property-order rules, and raw asset-byte hashes; preserve original string codepoints rather than rewriting data through search normalization. Reject duplicate JSON property names, duplicate IDs, lone surrogates, nonfinite numbers, unknown future formats, missing child/model/asset, corrupt hashes, invalid dates and over-limit allocations. None of these failures or an aborted import changes the active dataset. Retain the previous workspace and draft on failure.

Reject server page/fragment/overview envelopes as complete snapshots, even if they contain plausible event arrays. Test a partial cache with loaded count 100 and declared full total 10,000: it cannot report complete density or enable full Local editing of that supposed server scope. An explicitly imported independent Local dataset must not claim unavailable records from a former Server scope. A self-consistent manifest or copied origin metadata is not authentication or cryptographic proof of Server authority; SHA-256 checks integrity, not trust.

Complete Server export pins one authorized snapshot, traverses all required records and dependencies and validates final membership, rather than exporting only the current row page. Cancellation, concurrent writes, scope revocation and truncated transfer cannot produce a file labeled complete. Import/export round trips preserve IDs, times, metadata, models, filters, zones and intended references within the declared scope.

## 10. Local Edits, Outage and Reconnection

Local create/update/duplicate/delete/restore, nested commands, models, filters and settings operate in memory with local epoch/revision semantics. Verify both views update coherently, undo uses the declared local history and source-policy restrictions remain effective. Local success means memory changed, not that server JSON was committed or a disk file was overwritten. Ordinary downloads expose Prepared/Download requested, not an unverifiable Saved acknowledgment. A download click cannot clear modification state; user confirmation or reimport/hash verification establishes preservation of that particular revision. Known failure/cancellation retains changes, and unobservable destination/cancellation status stays explicit. Browser refresh/close may lose unexported work and must not be advertised as durable autosave.

Export a versioned complete JSON package, reopen a fresh copy of index.html, import it and assert exact data/configuration restoration. No localStorage, IndexedDB, service-worker cache, hidden database or automatic host-file write becomes an alternative store. Native file access, if offered as an optional enhancement, cannot be needed for core file:// import/export and must retain explicit user control.

Exercise no configured endpoint, refused connection, DNS/timeout, malformed response, disconnected SSE and outage after a successful Server session. Pure Local startup attempts no network access. Local is available without waiting for an optional configured Server probe, bounded to two seconds. A late successful probe cannot switch providers after user interaction. Fallback uses only a known-complete approved local bundle and clearly identifies its scope/version; partial cache remains limited/read-only or requires import. Never silently replace current work with a different bundled dataset.

401/403 means authentication/authorization failure, not ordinary outage or permission to expose cached protected data. File-origin Server connection must use explicit opt-in CORS policy and authenticated requests; Origin:null is not trusted identity. Test preflight, denied origins, absent/revoked tokens and logout. Tokens stay in memory and never enter the HTML or JSON package. Browser/CORS failures must give actionable connection state without weakening authorization.

Lose the reply after a Server commit, then disconnect. Mark the write outcome uncertain; do not repeat it as a Local mutation or quietly declare rollback. Reconcile through `getCommandOutcome`, mapped to authorized read-only `GET B/command-results/{clientCommandId}`, or an explicitly confirmed retry under the original idempotency/generation protocol, never an unsolicited write on reconnect. Test pending, committed, failed, not-found and expired/unknown outcomes; not-found is not proof an in-flight request cannot arrive later. Switching providers clears incompatible query/layout/cursor state and preserves or explicitly discards drafts only with user intent.

Local edits never upload or merge automatically when connectivity returns. Offer an explicit switch, retain an exportable Local copy and load a fresh authorized Server snapshot separately. Any later import/merge follows reviewed mapping, current permissions, version conflicts and existing transaction limits; a local revision is not a Server ETag. Test simultaneous Server changes, restored generations, lost credentials and repeated reconnects with zero unsolicited writes.

## 11. Local Limits and Final Evidence

The initial tested Local envelope is 25,000 records, 64 MiB decoded bundle including at most 32 MiB assets, 128 MiB query working data, two query sessions/two layouts per session, one worker, one active preparation and a queue of eight. Advertise limits and test one below, exactly at and one above; reject before partial installation. Raising a limit needs new benchmarks, not silent truncation. Benchmark parse/validation, font readiness, usable detail, full-scope density/layout, paging, edits/export and cooperative fallback, including bounded large-JSON parsing rather than a single blocking loop. Record browser process memory, long tasks, cancel latency and post-disposal memory separately from logical allocation budgets. Progress is not completion; Server's 100,000-record target is not a Local claim.

Add the packaged HTML checksum/size, dependency-closure report, blocked-network log, no-server process evidence, downloaded JSON fixtures, Python/JavaScript parity diffs, worker-fallback traces, both-mode screenshots and outage/reconnection state traces to the commit-bound report. G3-G5 cannot pass while either required mode, any retained feature or any mandatory platform lacks evidence. All of these remain future tests; this document does not report an executed application result.
