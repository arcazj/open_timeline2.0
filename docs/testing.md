# Testing the Implementation

The implementation suite combines deterministic core tests, real Python HTTP/provider comparisons, JSON-repository fault tests and Playwright operating the actual bundled Three.js application. It covers the runnable timeline and supported visual-model catalog, not the complete release test plan in the modernization prompt.

## Reproduce

Install the locked Node and Python dependencies, then run each command separately:

```powershell
npm ci
uv sync --locked
npm test
uv run pytest tests/server -q
uv run ruff check server tests/server scripts
npm run test:parity
npm run build
npm run test:e2e
```

The browser configuration uses Microsoft Edge on this Windows development machine. Set `OPENBEXI_BROWSER` to another compatible Chromium executable to exercise it. On platforms using Playwright's bundled Chromium, install it with `npx playwright install chromium`. Other engines/platforms are not certified by this run.

## Candidate Verification

After source changes are frozen, run the implemented-surface verifier into a new
directory. It refuses an existing evidence directory:

```powershell
npx playwright install chromium firefox
uv run python scripts/verify-candidate.py --matrix --output artifacts/verification/local-candidate-01
```

The verifier runs Ruff, JavaScript tests, Python tests, real-HTTP parity, native
OpenAPI validation, two deterministic builds, the primary browser suite and the
optional focused engine matrix. Its manifest includes source/lockfile hashes before
and after, command exits/durations, JUnit results, bundle hashes and browser reports.
It strips production `OPENBEXI_*` configuration from test processes, except an
explicit test browser executable. All server fixtures use their own temporary roots.
Failures, interrupted work, changed sources and skipped cases remain incomplete,
never passed. A timed-out owned command tree is stopped before proceeding.

The focused matrix currently exercises standalone and configuration Apply workflows
on Chromium/Firefox and Windows Edge; it is not every G3/G4 case on every engine.
The [container target](container.md) provides isolated Linux execution. The checked-in
GitHub workflow runs Windows/Linux and Python 3.12/3.13 with immutable action pins,
read-only repository permission and no publishing step. It has not been remotely
executed merely because its YAML is present. Action usage follows the upstream
[checkout](https://github.com/actions/checkout),
[Node setup](https://github.com/actions/setup-node),
[Python setup](https://github.com/actions/setup-python) and
[artifact upload](https://github.com/actions/upload-artifact) interfaces.

`passed-checks` means these commands passed on an unchanged candidate, not that all
legacy behavior, manual accessibility, controlled performance, migration or G0-G5
requirements are complete. `releaseApproved` deliberately stays false; release
approval still requires the separate requirement-by-requirement evidence map.

Python integration fixtures use temporary JSON directories, ephemeral loopback ports and a test-only token. Teardown stops the child process and validates the temporary path before removing it. Tests never use a user's configured production data root.

## Coverage

- Core tests include 5,000 seeded property iterations across decimal mapping, original packing, styled layout, range-index packing and overview aggregation, plus interval, Unicode search, import, source, command, calendar and worker cases. These counts are property iterations, not thousands of separate browser tests.
- Backend tests exercise record validation, version conflicts, idempotency, authentication, CORS, immutable query/layout handles, row budgets, single-writer exclusion, concurrent mutation serialization and journal recovery. See the backend evidence document for exact scope.
- Differential tests use a real Uvicorn process and compare Python with the Local provider for uniform and adaptive maps, complete-filter density, typed filter trees, explicit search modes, presentation geometry, table sorting, all row pages and overview. They verify complete ID traversal without duplicates.
- Offline browser tests copy **only** `dist/index.html` to a path containing spaces and block every HTTP request. They check real WebGL framebuffer colors, changing canvas pixels, embedded font readiness, nonoverlapping DOM labels and desktop/mobile geometry.
- Interaction checks cover row paging without map/overview movement, search-only overview, selection, independently paginated table/Split, pan, zoom, overview navigation, complete CSV export, JSON mutation/export/reimport and invalid imports. Structured filter tests retain malformed raw drafts during structural edits and verify that the visible predicate is the submitted predicate.
- Connected browser tests create a record through the actual API, kill and restart Python, verify disk persistence, trigger complete-snapshot fallback and explicitly reconnect without write replay. Authentication failures are tested separately from transport failure.
- Catalog tests exercise immutable publication, explicit active-version pins, archive/reference guards, concurrent revisions, ambiguous command replies and complete history round-trips. Browser checks cover structured/JSON editing, resizable independent preview, reload-safe uncertain model-command recovery, portable definition exchange and narrow-screen controls.
- Presentation checks cover measured multiline labels, bold/italic fonts, icons, nested sessions, original-time baselines, source colors, configured descriptor fields, date formats and axis placement. Point-label/icon/baseline spacing and tall Split rows have explicit regressions.
- Source-race checks delay refresh replies, selected-record reads, retained-worker status replies and prior-query cleanup while switching sources. Old successes, cleanup failures and authorization failures must not change the new source, query, generation or selection.
- Startup checks hold the worker's initialization reply, exercise early actions and reject initialization to verify an accessible error. A paused-import regression switches all three views before the new layout is ready, then verifies all 1,101 exported CSV record IDs exactly once.
- Worker checks verify real file-based offline import and traversal of all 25,000 records, continued browser event-loop heartbeats, startup-denied direct fallback, fatal-worker isolation, explicit recovery and preservation of a healthy modified local branch through a server outage. These checks do not certify all performance budgets or cooperative scheduling in direct fallback mode.
- Legacy dry-run fixtures preserve distinct production/test provenance, classify every pointer and hash sensitive or executable text instead of exposing it in reports. Unsupported semantics block conversion; these tests do not claim complete legacy migration support.

## Output and Interpretation

### Local Server Paths: 2026-09-13 UTC

The [local source-path guide](local-source-paths.md) documents the implemented
token-free loopback mode, server-approved path selection, favorites,
ALL/NAMESPACE grouping and navigation beyond the current query/archive edges.
The final standalone bundle is
`bd7185e4f0ef7638c9e6b58e5b4c9644a0d90b5f181719df2440d8466a5d37b7`.

| Check | Final Result | Evidence |
| --- | --- | --- |
| JavaScript core | 192 passed | `output/local-paths-client-final.xml` |
| Python API/repository | 840 passed, 1 skipped | `output/local-paths-server-final.xml` |
| Real HTTP provider parity | 38 passed | `output/local-paths-provider-final.xml` |
| Full Windows/Edge browser suite | 125 passed, 0 skipped/flaky/retried | `artifacts/browser/local-paths-final-results.json` |
| Focused layout/browser suite | 13 passed | `artifacts/browser/local-paths-layout-fix-results.json` |
| Ruff and OpenAPI consistency | Passed | Final CLI checks |
| Source-path preview PDF | 5 pages rendered and visually inspected | `output/pdf/OpenBEXI_Local_Source_Paths.pdf` |

The final full browser run started at `2026-09-13T16:50:17.209Z` and completed in
627.8 seconds. Captures are under `artifacts/browser/local-paths-final-verified/`.
The build was unchanged throughout this final run. The focused run is overlapping
coverage, not 13 additional distinct release tests. Python's skipped
`test_record_symlink_and_recovery_parent_symlink_are_rejected` case could not
create a Windows test symlink (WinError 1314); two upstream Starlette/AnyIO
deprecation warnings remain.

The first full browser attempt found a tall-label mobile Split overlap. Visual
review then found date-button clipping, and an intermediate run was stopped for
that correction. The fixes use measured row height and explicit toolbar minimum
widths, with new clipping/overlap assertions. The initial failure report is
retained as `artifacts/browser/local-paths-first-results.json`. An integration
fixture naming collision was also restored before the successful 38-case rerun.

New checks exercise exact-origin/loopback restrictions, no bearer headers in
local mode, stable private identity across restarts, source-byte preservation,
multiple/empty selections, remembered favorites, three namespaces, source-owned
zone filtering in both providers, past/future query-edge navigation and pinned
held-drag geometry. Existing outage, source-race, model, record-edit, worker,
standalone, search, table and pagination checks passed on the same candidate.

Production captures use a complete 1,153-record snapshot for its declared
March 17-25 range, not the 124,969-record full archive scanned at that time.
Three-namespace/path-picker captures use clearly labeled temporary test data.
Both capture reports match the final bundle hash. Poppler reported unavailable
unused display-font aliases; all five rendered pages and their text bounds were
checked without visible missing glyphs or clipping.

This is scoped implementation evidence, not approval of all legacy models,
independent per-namespace pagination, performance budgets, browser/platform
matrix or G0-G5 release gates. The new production instance was not left running;
the environment blocked its background launch. The guide includes its command.

### Hazard Compatibility Verification: 2026-09-13 UTC

The [hazard rendering comparison](hazard-rendering-parity.md) records the current
scoped results for bundle
`738d811266304f8444978ed7d0a121f8031b93fecb03f608efcfc1cbb422e42a`:
186 client, 830 Python, 37 real-HTTP integration and 122 browser cases passed.
One Python symlink-security case was skipped because Windows denied test symlink
creation. The final full browser run began at `2026-09-13T15:18:26.252Z`, finished
in 550.5 seconds and had no skipped, flaky or retried cases. Its archived copy is
`artifacts/browser/hazard-final-results.json`; captures are under
`artifacts/browser/hazard-final/`. The first full attempt's startup-readiness
failure remains archived separately; the comparison documents the fix and reruns.

New coverage includes all eight embedded legacy hazard icons, measured macron
labels, compact point packing, quarter-hour grid divisions and offline hazard
search at desktop/mobile sizes. Independent actual-data checks compare 42 records
across three row pages and a 383-record overview between providers, retaining
source-file hashes. Ruff and OpenAPI checks pass. These results verify this
implemented surface, not all historical models or the complete release gates.

### Historical Verified Run: 2026-09-13 UTC

The full browser run began at `2026-09-13T02:06:34.684Z` (September 12 in the workspace's America/New_York time zone).

This is the third-increment baseline, not verification of subsequent full-release
changes. Later candidate manifests and scoped reports supersede it only for the
source/build hashes and cases they actually exercised.

| Check | Result |
| --- | --- |
| JavaScript core | 73 passed, including 5,000 seeded property iterations |
| Python API/repository/export | 194 passed in 39.66 seconds |
| Real HTTP cross-provider parity | 20 passed |
| Playwright | 72 passed, 0 skipped, 0 flaky, 0 retries; full run in 244.5 seconds |
| Ruff | Clean across server, server tests and Python scripts |
| Standalone build | Successful; 48 complete sample records; no external runtime imports |
| Preview PDF | Fifteen pages rendered with Poppler and visually inspected |

Total: **359 test cases passed**, plus the property iterations. Environment: Windows x64, Node 24.13.0, Python 3.12.14, Microsoft Edge 153.0.4234.32, Playwright 1.63.0. Browser checks include desktop, narrow Split, a narrow model library and DPR 2 canvas alignment. The final suite includes startup, source-switch, model-command, filter-draft and import-layout regressions found during verification. The nested-page traversal test waits for exact row boundaries before checking every canonical ID, rather than accepting an unchanged page count as readiness. Python emitted two upstream Starlette/AnyIO deprecation warnings; there were no final-suite test failures. PDF rendering reported unused display-font warnings, with no visible missing glyphs or document layout defects in the fifteen inspected pages.

The legacy CLI was also exercised on both shipped production/test fixtures. It emitted separate blocked dry-run reports without changing the catalog, and an attempt to reuse an output path was rejected. These manual CLI checks and separately repeated diagnostic tests are not added to the 359 automated-case total.

`artifacts/browser/results.json` contains the most recent Playwright run and the standalone bundle hash recorded when the run starts. Screenshots and failure traces are beneath `artifacts/browser/results/`; a filtered test run replaces the previous browser report. `dist/build-manifest.json` records bundle/input hashes and dependency versions. The curated implementation preview rejects a failing/flaky report or a bundle hash mismatch, requires all fifteen named captures, and must be regenerated after code changes. Keep the build frozen while tests run and publish only a full-suite run.

Tests verify the working-tree build being exercised. No commit has been created or release tag signed. Results do not imply that all legacy models, worker/cancellation budgets, very large datasets, cross-platform recovery, end-user accessibility or the full G0-G5 matrix passed. See [implementation status](implementation-status.md) for the explicit remaining work.
