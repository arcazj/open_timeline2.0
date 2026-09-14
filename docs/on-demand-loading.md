# On-Demand Server Loading

The legacy launcher now opens the HTTP client on its configured real source.
It does not render the bundled demo while starting, and does not substitute that
demo when a request fails. Existing server views remain visibly last-confirmed
until retry succeeds. Opening `dist/index.html` directly remains independent:
it uses its complete embedded snapshot, or a complete JSON file you import.

## Start

Rebuild and restart the Python process to adopt this implementation:

```powershell
npm run build
.venv/Scripts/python.exe scripts/serve-legacy.py --yaml yaml/multiple_sources_test.yml
```

Open the printed client URL, normally `http://127.0.0.1:8769/`. For earthquake
and volcano sources use `yaml/earthquake_volcano_data.yml`, normally port 8770.
Existing profiles need no changes. They default to background initialization
and lazy data loading. Paths must be readable by the Python server.

## Optional YAML Settings

These keys augment the existing global profile; retain its `version`, server
host/port/state settings, `legacy` and `data_sources` definitions.

```yaml
server:
  # Retain the other server keys from the existing profile.
  startup_mode: background
  data_loading: lazy

loading:
  buffer_ratio: 0.25
  cache_mib: 64
  index_refresh_seconds: 30
  initial_range:
    from: "2024-03-18T19:00:00Z"
    to: "2024-03-18T21:00:00Z"
```

`initial_range` is optional. Without it, startup selects a latest calendar
partition without reading event payloads; the legacy presentation model still
controls the initial display scale. A configured initial range is useful when
the newest directory is empty or the desired historical interval is known.

`buffer_ratio` accepts 0-1, `cache_mib` accepts integer values 8-256, and
`index_refresh_seconds` accepts 5-3600. Invalid settings fail startup rather
than being silently ignored. `data_loading: eager` retains complete-load mode.
`startup_mode: foreground` separately controls waiting before opening HTTP.

## Window Reads And Navigation

- The main query covers the visible interval plus 25% on each side by default.
- The server reads only relevant date partitions and files whose indexed actual
  event/session/zone bounds overlap that interval. Long sessions beginning in
  earlier partitions and nested activities remain discoverable.
- The server caches converted file images, bounded to 64 MiB by default. Repeated
  reads verify path safety and file metadata before reusing an unchanged image.
- During dragging, a throttled prefetch favors the direction of travel, adding
  up to another buffer on that side. The browser keeps one active prefetch and
  one replaceable pending intent; the server admits one speculative read with
  a five-second budget. A busy prefetch is skipped, not treated as loaded data.
- Broader overview metadata is requested separately after the main rows render.
  It does not download the broader interval's complete record payloads to the
  browser. Overview publication waits while navigation is active.
- Replacement queries use request identities and cancellation. Earlier, slower
  responses cannot replace the latest view. Speculative results never change
  the displayed source or silently turn errors into empty results.
- Vertical pages retain their query, map and source image. Index progress and
  filesystem changes do not reshuffle a pinned page.

Files are the minimum I/O unit: a large legacy JSON file must still be parsed
when first needed. Pagination bounds browser output, not the size of a single
source file. Existing file, traversal, record and execution limits still apply.

## Cold Index And Completeness

There is no reliable way to find an arbitrarily long session in an unknown old
file from its directory date alone. A first background pass therefore reads
files to build a disposable interval index. This work does not gate HTTP
readiness or the first real-data window.

Before the index is verified, queries explicitly report `coverage.complete:
false`. Counts and overview are provisional; automatic density scaling stays
uniform instead of claiming to use the complete filtered dataset. Manual zoom
and navigation remain available. A record not yet discovered in an old file is
not represented as a confirmed absence.

When indexing completes, **Refresh verified view** replaces the provisional
query on request. New queries then include indexed cross-partition sessions and
use complete filtered density for adaptive scaling. Index completion alone does
not move the current page, change its scale, or close an open dialog.

`legacy-file-index.json` lives in the configured writable state directory,
separate from all read-only source roots. It stores paths, file fingerprints,
time bounds, identifiers and validation signatures, not an archive copy or a
database. Atomic replacement and a checksum protect against interrupted writes;
invalid indexes are discarded and rebuilt. Warm starts recheck unchanged file
metadata without reparsing every event file. The index is bounded to 64 MiB;
the existing default admissions are 20,000 files and 250,000 records.

Metadata is rechecked periodically; new requests adopt observed changes, while
existing queries remain pinned. `checkedAt` identifies the last verification
pass, not a transactional snapshot of independently written external files.
Malformed files, conflicting identities, exceeded limits or incomplete scans
keep coverage unverified. The UI never claims these were fully loaded.

## Diagnostics And Export

Readiness means source metadata and window APIs are available, not that every
archive file has been indexed. The authenticated local endpoint
`GET /api/v1/workspaces/default/legacy/loading` reports index progress and,
for an all-source administrator, bounded-cache and read metrics.

Complete JSON export remains explicit and validates the full configured
archive. It never exports only the most recently loaded page. The unbounded
record collection route rejects lazy-mode reads without a time domain; use
query sessions for browsing and the existing snapshot-export API for a complete
copy. Standalone import limits still apply to exported datasets.

## Verification

On this Windows workspace, a controlled 360-file, three-source fixture with
indexing deliberately paused produced the following results on 2026-09-13:

| Measurement | Desktop 1600 x 900 | Mobile 390 x 844 |
| --- | --- | --- |
| Process launch to client URL available | 1.06 s | 1.22 s |
| Browser navigation to first real rows | 1.28 s | 1.39 s |
| Event bytes read for the initial window | 1,422 | 1,422 |
| Background files read at that point | 0 | 0 |
| Prefetch requests during the exercised workflow | 2 | 3 |

These are separate URL and browser timings, not a production archive benchmark
or a universal latency guarantee. Payload size, disk speed and machine load
matter. The tests also verify that releasing the index makes an old crossing
session available, without automatically replacing the pinned page.

Actual first-view screenshots from that fixture:

![Desktop real-source first view with provisional coverage](ui/lazy-real-desktop.png)

![Mobile real-source first view with provisional coverage](ui/lazy-real-mobile.png)

Focused verification commands:

```powershell
.venv/Scripts/python.exe -m pytest tests/server/test_partitioned_legacy_repository.py tests/server/test_launch_configuration.py
node --test tests/client/window-loading.test.mjs
node --test tests/integration/legacy-parity.test.mjs
npm run build
npx playwright test tests/e2e/startup.spec.mjs tests/e2e/lazy-loading.spec.mjs tests/e2e/calendar-momentum.spec.mjs tests/e2e/standalone.spec.mjs
```

Coverage includes zero-payload repository opening, complete vs provisional
density, earlier overlapping sessions/zones, changed/deleted/malformed files,
warm-index reuse, source permissions, immutable pages, complete exports,
startup failure, request failure/retry, bounded drag prefetch, desktop/mobile
rendering and offline operation. Legacy source bytes are checked unchanged.

The final regression run passed 925 server tests (one skipped), 220 client
tests, 39 cross-provider integration tests and 41 Chromium browser tests.
The browser run includes the new loading tests plus calendar/momentum,
source selection, retained-scene navigation, Help and direct-file standalone
checks. Both main and overview canvases passed desktop/mobile pixel checks.
This is task-specific verification, not certification of the entire release
or every supported browser/platform.
