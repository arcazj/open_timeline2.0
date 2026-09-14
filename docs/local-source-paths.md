# Local Server Paths

The Python server reads approved legacy JSON paths. The browser only selects
source IDs advertised by that server. Browser filesystem restrictions do not
determine which server paths are readable. An unavailable directory, denied OS
permission or invalid source is a server-side issue; it is not silently replaced
with a different dataset.

Legacy events, sessions, descriptors, models and YAML stay read-only. Database
and messaging connectors are not started.

## Start SOURCE1 and SOURCE2

From `C:\projects\open_timeline2.0`, with the existing Python environment and
JavaScript dependencies installed:

```powershell
npm run build
.venv/Scripts/python.exe scripts/serve-legacy.py --yaml yaml/multiple_sources_test.yml
```

Open `http://127.0.0.1:8769` once Uvicorn reports that it is running. The page
opens on real source data before background archive indexing completes. Use this exact address, not
`localhost`, a file URL, a LAN address or the development proxy. No token field
is needed. Choose another unused port if 8769 is occupied; use the same port in
the browser. Keep the process running while browsing server data.

This task did not leave that production instance running: the attempted
background launch was blocked by the execution environment. Existing unrelated
servers were left untouched. Automated browser tests used temporary isolated
server instances, not the production source directories.

The new project's `yaml/multiple_sources_test.yml` explicitly enables both production
directories. It does not change the original legacy YAML. `SOURCE1` maps to the
actual folder spelling `SOURCES1`; `SOURCE2` maps to `SOURCES2`.

If `OPENBEXI_CORS_ORIGINS` is set, remove it from this process before local mode;
cross-origin access is deliberately rejected. A bearer credential is still
required when `server.local_browser` is false (or when using the old CLI without `--local-browser`).

## Global YAML Profiles

One operator-owned file contains the server settings and the legacy `data_sources`
list. No generated source YAML or copied archive is needed. Available profiles:

| Profile | Read-only data | Client URL |
| --- | --- | --- |
| `yaml/multiple_sources_test.yml` | `C:/data/SOURCES1` and `C:/data/SOURCES2` | `http://127.0.0.1:8769/` |
| `yaml/earthquake_volcano_data.yml` | `C:/data/earthquake` and `C:/data/volcano` | `http://127.0.0.1:8770/` |
| `yaml/default_test.yml` | Legacy project's `tests/data/SOURCES1` and `SOURCES2` | `http://127.0.0.1:8771/` |

```powershell
.venv/Scripts/python.exe scripts/serve-legacy.py --yaml yaml/earthquake_volcano_data.yml
.venv/Scripts/python.exe scripts/serve-legacy.py --yaml yaml/default_test.yml
```

Launch one command for the desired profile. Startup prints the selected profile
and the client URL. Paths must exist and be readable by the Python process.
Both test namespaces are enabled explicitly, even though the original legacy
test YAML disables SOURCE2. Legacy files are never modified.

`version: 1` requires `server`, `legacy` and `data_sources` sections.
`server` contains `host`, `port`, `local_browser` and `state_root`, plus optional
`startup_mode` (`background`, the default, or `foreground`) and `data_loading`
(`lazy`, the default, or `eager`). The optional `loading` section controls buffers,
cache size, index refresh and the initial range. See [on-demand loading](on-demand-loading.md).
`legacy` requires `root` and `allow_roots`; optional settings are `path_maps`,
`model`, `timezone` (UTC), `dialect` (strict), and `namespace_grouping`.
Omitting grouping preserves the selected model's authored behavior.

Relative server/legacy root paths, allowed roots and path-map destinations are
resolved from the YAML directory, independent of the process working directory.
The model path and relative legacy `data_path`/`data_model` paths retain legacy
semantics: they resolve from `legacy.root`. Date suffixes remain literal
`yyyy`, `yyyy/mm` or `yyyy/mm/dd`; the source reader discovers the partitions.
The profile filename itself is relative to the working directory; absolute
filenames work as well. Use forward slashes in Windows YAML paths.

Unknown keys, duplicate keys, aliases, unsafe YAML tags, invalid types and
non-loopback token-free bindings are rejected. State directories must remain
disjoint from all legacy authority roots. Tokens stay in `OPENBEXI_API_TOKEN`
for authenticated deployments, never in checked-in YAML or the printed URL.

The old individual CLI options remain available as an alternative launch mode.
With `--yaml`, only `--host` and `--port` may override a profile, for example
`--yaml yaml/default_test.yml --port 8772`. Source settings must be edited in
the YAML, not mixed with legacy CLI options. Token-free mode still requires
`127.0.0.1` after overrides.

## Startup And Readiness

The launcher defaults to background metadata initialization and lazy data
loading. It binds the HTTP listener without waiting for the archive scan. The
HTTP client shows the configured source names immediately, never the bundled
demo. After source metadata and access services are ready, the first query reads
the visible interval plus a small buffer. Subsequent navigation loads on demand.

Cold-start indexing runs separately to discover sessions and zones stored in
earlier partitions. Until this completes, the UI explicitly marks coverage and
counts provisional and defers automatic density scaling. Completion offers
**Refresh verified view** without rearranging an active page or closing dialogs.
Opening `dist/index.html` directly still uses the complete embedded Local snapshot.

Startup polling uses a two-second request timeout, one-second interval and a
six-minute total limit. A visible retry control handles timeout or failure.
Configured-server failures never substitute demo data; an existing view is
retained as last-confirmed data. Failed initialization requires inspecting the
server log and fixing the cause before restarting.

`/health/live` reports process liveness. `/health/ready` and `/api/v1/health`
return HTTP 503 until metadata and access services are ready, then HTTP 200.
In lazy mode, ready means able to answer window requests, not that the archive
index is complete. Each query carries its own coverage state; authenticated
`/api/v1/workspaces/default/legacy/loading` reports index progress. Before
readiness, data APIs return 503 (`server_starting` or `startup_failed`).

Set `server.startup_mode: foreground` in a global YAML profile to retain the old
wait-before-listening behavior; also set `server.data_loading: eager` to wait for
a complete archive load. Direct `create_app()` callers retain foreground startup
and the eager legacy repository unless they explicitly enable these options.

Configuration validation avoids copying and canonicalizing the complete record
archive just to validate configuration references. Full record/schema, source,
group, model, snapshot integrity and relationship checks remain in place. Legacy
files remain read-only; no database or persistent archive copy is introduced.

Earlier eager-mode measurements on this Windows workspace on 2026-09-13:

| Measurement | Result |
| --- | --- |
| Isolated HTTP launch with archive loading deliberately held | Client HTML available in 0.98-1.07 seconds; readiness still 503 |
| Complete SOURCE1/SOURCE2 read-only repository load | 153 admitted files, 124,969 records, 51.30 seconds |
| Configuration validation microbenchmark, 10,000 records | Previous normalization path 1.76 seconds; validation-only path 0.25 seconds |

These are different measurements, not an end-to-end speedup ratio. The full
load includes reading, conversion, validation and repository indexing but not
browser query/render time. Disk caches and machine load affect timings. Large
archives still take time to index fully. Lazy-mode first views no longer wait
for that scan; newer measurements are in [on-demand loading](on-demand-loading.md).

Regression coverage includes blocked and failed startup, cancellation and cleanup,
503 metadata gating, read-only source preservation, direct real-source startup,
partial coverage, bounded prefetch and complete snapshot export. Browser checks cover desktop/mobile screenshots, nonblank
Three.js canvases and direct-file standalone operation. Run:

```powershell
.venv/Scripts/python.exe -m pytest tests/server/test_background_startup.py tests/server/test_launch_configuration.py tests/server/test_configuration_catalog.py
node --test tests/client/startup-discovery.test.mjs
npm run build
npx playwright test tests/e2e/startup.spec.mjs tests/e2e/local-paths.spec.mjs tests/e2e/standalone.spec.mjs
```

## Run From IntelliJ IDEA

The shared `.run/OpenBEXI Local Sources.run.xml` configuration launches
`scripts/serve-legacy.py --yaml yaml/multiple_sources_test.yml` from the project root with both approved source paths,
the regular legacy model, token-free local mode and port 8769. It leaves the
existing `main` configuration unchanged. Use **OpenBEXI Local Sources**, not a
direct run of `server/app/main.py`.

This machine's project SDK and shared run configuration now use the registered
Python 3.12.14 environment named `C:\projects\open_timeline2.0\.venv`.
For a new IDEA installation, register the existing Python 3.12 virtual environment
before the first run. In **File > Project Structure > SDKs**, add a Python SDK from disk and select
the existing interpreter `C:\projects\open_timeline2.0\.venv\Scripts\python.exe`.
Do not create a replacement environment or select the system Python 3.9 SDK.
Then open **Run > Edit Configurations > OpenBEXI Local Sources**, choose that
registered interpreter under **Use specified interpreter**, and apply. See the
[JetBrains Python SDK guide](https://www.jetbrains.com/help/idea/configuring-python-sdk.html)
if the interpreter picker differs in your IDEA version.

Select **OpenBEXI Local Sources** in the toolbar and choose Run or Debug. After
startup completes, open `http://127.0.0.1:8769`. Stop the server with IDEA's Stop
button. The launch reads the existing `dist/index.html`; run `npm run build`
after client changes. It does not start a second frontend server or rebuild the
client automatically. Select another profile by changing the single `--yaml`
argument in IDEA. If port 8769 is occupied, edit `server.port` in the YAML or
append `--port 8772`, then use the URL printed at startup.

### Wrong Interpreter Error

`validator_for() got an unexpected keyword argument 'offline'` can indicate
that IDEA is using a different environment from the project's `.venv`. In the
reported case, the system Python 3.9 environment had `jsonschema-rs 0.34.0`,
while the project environment has Python 3.12 and the pinned `jsonschema-rs
0.56.0`. Select the project interpreter in the actual Run/Debug configuration;
changing a terminal's environment does not change IDEA's interpreter. Do not
remove `offline=True` from schema validation to accommodate the older package.
The legacy launcher now rejects unsupported Python versions before importing
server dependencies and prints the interpreter path to select.

## Select Paths

1. Open Sources, or choose **Choose paths** in the toolbar path combo.
2. Check one or more approved directories and select **Use selected paths**.
3. Star frequently used paths. Each starred path appears in the toolbar combo;
   choosing it selects that path alone. The dialog supports multiple selections.
4. **All approved paths** selects every approved source. Selecting none means no source
   records or source-owned zones, not all records.

Favorites and selected IDs persist in this browser for this exact server origin.
Removed IDs are discarded. Storage denial leaves browsing functional but prevents
persistence. The ordinary source/type filters can further narrow the selected
set. Global zones without a source association remain global.

Add approved sources on the server by extending the new project's YAML and
allowlist, then restarting it. The client cannot submit arbitrary disk paths or
enumerate the server filesystem. The approved catalog is available only through
the opt-in same-origin `/api/v1/local-sources` endpoint.

## ALL and NAMESPACE

The toolbar **Sorting and filtering** combo controls grouping:

- **ALL** packs selected sources into one combined timeline.
- **NAMESPACE** groups by each record's actual `/data/namespace`, supporting
  more than two namespaces. Multiple paths with the same namespace share a group.
- A model with another grouping field is shown as **Custom grouping** until a
  different mode is explicitly chosen.

This changes the active presentation, not legacy JSON or the saved legacy model.
Readable collision packing and vertical row pages remain active. A namespace
can occupy several pages; this is not a promise that every namespace stays
visible simultaneously on a crowded page. Independent pagination for each
namespace band is not implemented.

Legacy supported band units, interval pixels, date formatting, colors and band
proportions are retained. Automatic scaling is enabled initially for local path
connections. Dense intervals use the existing complete-filter density mapping,
not the current vertical page. The scale guide marks unequal time distances.
The zoom controls and Auto scale checkbox remain available; unsuitable uniform
axis divisions fall back to readable calendar divisions.

Changing grouping or zoom may mark local view preferences as modified. It does
not make legacy records writable. These transient view changes are not currently
persisted with the favorite-path preferences.

## Navigation and Overview

Dragging, horizontal wheel input, Shift-wheel and arrow keys can cross the
current query/archive edges in either direction. Gesture geometry stays pinned
during dragging; queries refresh after settling. The overview follows near its
edges and recenters its analysis window rather than growing without bound.
Vertical pagination does not change that window or its scale.

The [calendar and momentum guide](calendar-navigation.md) covers the longer
inertial glide, click-to-stop, and the right-side month/day picker. Hour-scale
calendar selections default to 04:00 UTC. The existing date-range dialog remains
available. Both navigation methods preserve filters and keep legacy files read-only.

Navigation supports Gregorian years 0001-9999, not infinite numeric dates. Empty
time periods remain empty. A rescan is explicit: files created by an external
writer after the last scan are not automatically part of the pinned archive.
Use **Rescan JSON files** in Sources to incorporate them. See the
[partition and overlap rules](legacy-json-sources.md) for `yyyy/mm/dd` access,
including sessions stored before the viewed date that continue into it.

## Security and Offline Scope

Token-free mode is for a trusted single-user loopback instance. It checks the
client address, exact Host/Origin, same-origin Fetch Metadata and a custom request
header. Cross-origin/null origins, missing headers and non-loopback peers are
rejected. Do not expose this mode through a reverse proxy or public interface.
These checks do not defend against another process running as your local user.

The private `local-browser-key.json` is written only in the separate state root
and retained across restarts. It is never returned to the browser. Keep that
directory private and out of source control. If an existing identity store loses
its key, startup fails closed; restore the key or deliberately choose a new
state directory. No identity file or legacy data is deleted automatically.

Standalone HTML still works without Python, using its complete embedded or
imported snapshot. It cannot crawl `C:\data` or pretend to contain current server
records. Source selection is not an automatic full-archive offline download.
The complete archive here exceeds the current 25,000-record Local limit; export
an explicitly declared range when an offline snapshot is needed. Reconnection
is controlled through the path chooser; no local edits are uploaded.

## Screenshots

These are real renderer captures, not mockups. The fixture screenshots use three
small synthetic namespaces to make the controls and grouping clear. The later
screenshots use unshifted records from the actual production directories.

### Three Namespaces

![Three namespace groups and synchronized overview](ui/local-source-paths/fixtures/three-namespaces.png)

Three configured test paths, six records and three zones. Grouped rows retain
their source styles. These are test fixtures, not production March 18 records.

### Combined View

![Two selected test paths combined in ALL mode](ui/local-source-paths/fixtures/combined-sources.png)

ALL combines SOURCE1 and SOURCE2 from the fixture. The third path is deselected.

### Path Picker

![Mobile server path selection with favorite stars](ui/local-source-paths/fixtures/mobile-path-picker.png)

The temporary paths belong to the test server. Production displays the approved
`C:\data` paths from its own catalog.

### Actual SOURCE2

![Actual SOURCE2 records on March 18](ui/local-source-paths/production/source2-detail.png)

March 18, 2024, 19:00-22:00 UTC. The production SOURCE1 sample starts March 23,
so this interval cannot reproduce two simultaneously populated production lanes.

The separate legacy test directories
`C:\projects\openbexi_timeline\tests\data\SOURCES1` and `SOURCES2` both contain
March 18 event files. They are not included in the production configuration above.
The original `yaml/sources_default_test.yml` has SOURCE2 disabled; loading it
unchanged must not silently enable that source. A test comparison needs an
explicitly approved configuration for both test paths, separate from production.

### Actual SOURCE1

![Actual SOURCE1 records on March 24](ui/local-source-paths/production/source1-detail.png)

March 24, 2024, 19:00-22:00 UTC. Main-band row pagination preserves the wider
overview and the actual timestamps. The black lane comes from the legacy style.

The captured offline snapshot contains 1,153 records across the declared
March 17-25 range: 1,026 from SOURCE1 and 127 from SOURCE2. The separate full
server scan counted 124,969 records at capture time, across 153 JSON files.
These counts describe that scan, not a live guarantee; the data is externally
updated. No dates were shifted to make the screenshots match.

The screenshot PDF is `output/pdf/OpenBEXI_Local_Source_Paths.pdf`. Production
capture metadata is in `docs/ui/local-source-paths/production/verification.json`;
the range import report is `output/local-paths-production-import.json`.

The import report also records compatibility adaptations, including approved
icon substitutions and measured font replacement. Preserving readable behavior
does not mean reproducing every historical glyph or formatter defect.

## Verification

See [testing](testing.md) for the final scoped run results and known limits.
New checks cover token-free startup, restart identity, origin rejection,
read-only source preservation, multiple and empty selections, favorites,
namespace grouping, query-edge navigation, pixel rendering, nonoverlapping
labels and mobile layout. Existing server/Local parity checks include selected
source zones, density, mapping, search and row traversal.

This feature is not certification of pixel-identical legacy rendering, every
historical model or all full-release performance/accessibility/platform gates.
