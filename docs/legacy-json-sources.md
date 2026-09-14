# Read-Only Legacy JSON Sources

The legacy project is `C:\projects\openbexi_timeline`. The new project is
`C:\projects\open_timeline2.0`. Legacy JSON remains the authority: this mode reads
it in place and does not rewrite records, descriptors, models, or source YAML.
Python replaces the Java/Tomcat reader; database and messaging connectors are not
started. Server identity/control files live separately from every legacy root.

## Source Path Rules

The loader reads the actual legacy `data_sources` YAML structure. For example:

```yaml
data_sources:
  - namespace: earthquake
    type: json_file
    enable: true
    permission: ''
    converter2events_class: build_in
    data_path: /data/
    data_model: /data/earthquake/yyyy/mm/dd
    filter:
      include: ''
      exclude: ''
    render:
      color: '#BBEDF0'
      textColor: '#080808'
      dateColor: '#080808'
```

`data_model` is the complete directory template, not a path appended to
`data_path`. An operator mapping `/data=C:/data` makes the example read ordinary
JSON files below `C:\data\earthquake\2024\02\29`, and every other valid date.
Relative templates such as `tests/data/SOURCES1/yyyy/mm/dd` resolve against the
legacy project root, not its `yaml` directory. Path maps use the longest matching
complete path prefix; `/data` does not match `/database`.

Supported trailing templates are `yyyy/mm/dd`, `yyyy/mm`, and `yyyy`. Date
components must be zero-padded, valid Gregorian dates. Calendar arithmetic handles
leap days and year/month transitions; it never approximates a month as 30 days.
UTC is the default, matching the inspected legacy `json_files_manager.getFiles`
behavior. An explicit `--timezone` selects another IANA zone for partition/date
interpretation. No machine-local timezone is inferred.

Supported Gregorian years are 0001 through 9999. Intervals use exclusive end
times. A point or session starting at `9999-12-31T23:59:59.999Z` cannot have a
representable later exclusive boundary, so it returns `legacy_range_limit`
instead of overflowing or being silently dropped. Sessions may end at that
instant; earlier points, including the first millisecond of year 0001, work.

Ordinary nested JSON files under a valid date leaf are supported. Descriptor,
noise, and hidden directories are not event authorities. Missing date directories
are empty gaps and are never created. Paths containing traversal, substitutions,
URLs, symlinks, or Windows reparse points are rejected; sources must remain inside
the operator's explicit `--allow-root` boundaries.

Only `enable: true` and `type: json_file` sources are admitted. Disabled entries
are reported without opening their paths. Unsupported source types are reported
without loading their drivers. Connector values are never executed. Nonempty
legacy permissions, source filters, or executable converter classes cannot be
safely translated by this loader, so those sources receive error diagnostics;
the server refuses an enabled configuration containing such errors rather than
publishing a partial source set. The `buildin` marker authored in
`sources_default.yml` is accepted as an explicit, reported alias of `build_in`;
neither runs external code. YAML aliases, duplicate keys,
unsafe object tags, and excessive size/depth are rejected.

Source IDs are stable hashes of the declared namespace/template with a readable
prefix. Reordering YAML or adding another source with the same namespace does not
change existing IDs. The record's actual namespace is separate from its source
ID and remains available for namespace grouping. YAML source `render.color`
supplies lane background styling, not the individual event marker color.

## Build and Run

For same-machine use without entering a bearer token, follow [Local Server Paths](local-source-paths.md). The `--local-browser` switch is opt-in, read-only, loopback-only and requires the browser's exact server origin. The bearer-token commands below remain available for explicit authenticated connections.

Run these commands from `C:\projects\open_timeline2.0` in PowerShell. Python 3.12
or 3.13, Node.js 22+, and `uv` are required for development/building.

```powershell
uv sync --locked
npm ci
npm run build
$env:OPENBEXI_API_TOKEN = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
```

Keep the token private and use its value in the application's Sources connection
dialog. The examples bind only to loopback. Use another unused port when needed.

### Earthquake and Volcano

```powershell
.venv\Scripts\python.exe scripts\serve-legacy.py `
  --source-yaml C:\projects\openbexi_timeline\yaml\sources_earthquake.yml `
  --legacy-root C:\projects\openbexi_timeline `
  --allow-root C:\data `
  --path-map /data=C:/data `
  --model models/regular_timeline_earthquake.json `
  --timezone UTC `
  --dialect legacy-json `
  --state-root var/legacy-earthquake `
  --port 8765
```

Open `http://127.0.0.1:8765`, then connect to that server through Sources. This
configuration reads the enabled `earthquake` and `volcano` sources. The model is
the one referenced by legacy `openbexi_timeline_earthquake.html`.

`--dialect strict` is the default. The explicitly selected `legacy-json` dialect
accepts the compatibility parser's documented trailing-comma/duplicate-member
cases and reports them; it does not repair or write the original files. Malformed
records outside that dialect still fail admission.

### Namespace Timeline

The actual `yaml/sources_startup.yml` enables only `SOURCE1` and reads
`/data/SOURCES1/yyyy/mm/dd`:

```powershell
.venv\Scripts\python.exe scripts\serve-legacy.py `
  --source-yaml C:\projects\openbexi_timeline\yaml\sources_startup.yml `
  --legacy-root C:\projects\openbexi_timeline `
  --allow-root C:\data `
  --path-map /data=C:/data `
  --model tests/models/regular_timeline.json `
  --namespace-grouping `
  --timezone UTC `
  --dialect legacy-json `
  --state-root var/legacy-namespaces `
  --port 8766
```

Open `http://127.0.0.1:8766`. The model is the one referenced by legacy
`openbexi_test_timeline.html`.

The separate legacy `yaml/sources_default_test.yml` uses relative
`tests/data/SOURCES1` and `tests/data/SOURCES2` paths, and explicitly disables
`SOURCE2`. Do not silently enable it or reinterpret those paths as `C:\data`.
To use that file as authored, allow
`C:\projects\openbexi_timeline\tests\data`. To display both production folders
under `C:\data`, create a separate operator-owned YAML outside the legacy tree
containing two enabled `json_file` entries with namespaces `SOURCE1`/`SOURCE2`
and templates `/data/SOURCES1/yyyy/mm/dd` and `/data/SOURCES2/yyyy/mm/dd`.
Point `--source-yaml` to that new file; keep the same explicit path map and data
allowlist. The application does not edit the legacy YAML on the operator's behalf.

The default `--state-root var/legacy-server` is relative to the current working
directory. State must be disjoint from the legacy project and every allowed data
root; use a different state directory for separately configured server instances.

## Navigation, Changes, and Completeness

At startup the server scans all admitted calendar folders and creates an
in-memory start/end interval index. Dates describe where a file is stored, not
the full time span of its records. Queries use the index to include every session
overlapping the requested domain, even when it began months earlier in another
folder. Simply loading the currently visible day's directory would miss such
sessions and is not the implementation's completeness rule.
The first scan of a large archive can take several minutes before the server is
ready; the server's current scan deadline is 300 seconds.

Requests capture immutable, domain-overlapping records for the shared query
engine. Query totals describe that domain; archive totals remain distinct.
Density, overview, and layout use the captured filtered data, not just the current
vertical page. Moving between vertical pages keeps the time interval and map
fixed. Older queries remain pinned while a new scan is admitted.

After upstream JSON changes, use **Sources > Rescan JSON files**. A successful
scan advances the read-only revision when accepted file images change; reload
the view to use it. A failed/incomplete scan must not replace the last good
snapshot. Where a previously accepted file has a cached last-good image, a
temporary malformed replacement can retain that image with explicit stale
status; it is not reported as current data. This is explicit refresh, not an
unbounded live filesystem watcher. Changing source enable flags, path maps, YAML
render settings, or model files requires restarting the server with the intended
configuration.

Current safety limits include 250,000 scanned archive records, 100,000 selected
query records, 128 MiB query images, and 256 MiB retained query resources. The
reader also applies file-count, byte, directory, and elapsed-time limits. These
are bounded in-memory limits, not a claim of unlimited archival scale. Limit
violations are errors, never silent record truncation.

The standalone HTML cannot directly crawl arbitrary disk folders. It uses a
complete embedded/imported snapshot, without Python or network access, and makes
the source/snapshot timestamp explicit. Its current local admission limits are
25,000 records and 64 MiB; larger snapshots are refused, not partially loaded.
A range-limited export is complete only for its declared range, not the entire
archive. It must not be labeled as the full server dataset.

## Standalone Export

Convert a complete, explicitly bounded legacy time interval into a **new** local
snapshot. This reads every enabled source partition to include crossing sessions,
then retains only the requested interval and required session ancestors. It never
writes the legacy JSON, model, or YAML. This example uses the authored test YAML
with its enabled SOURCE1 dataset, which contains records on March 18, 2024:

```powershell
.venv\Scripts\python.exe scripts\import-legacy.py `
  --legacy-yaml C:\projects\openbexi_timeline\yaml\sources_default_test.yml `
  --legacy-root C:\projects\openbexi_timeline `
  --allow-root C:\projects\openbexi_timeline\tests\data `
  --model tests/models/regular_timeline.json `
  --namespace-grouping `
  --timezone UTC `
  --dialect legacy-json `
  --from 2024-03-18T19:00:00.000Z `
  --to 2024-03-18T21:00:00.000Z `
  --max-seconds 600 `
  --output output/legacy-verification/source1-test-2024-03-18.json `
  --report output/legacy-verification/source1-test-2024-03-18-report.json
```

Open the generated `dist/index.html` directly, then use Sources > Open JSON to
select the new snapshot. The model's two-band proportions, time-scale hints,
namespace grouping, and source colors accompany the data. The declared universe
remains exactly the exported time interval; model focus/scale never expands its
data completeness claim. Remove both `--from` and `--to` only when a full archive
fits the standalone admission limits. All events within the selected snapshot
remain browseable through local querying and vertical pagination.

Output and report paths must be new and outside the allowlisted legacy folders;
choose different names for a later export. An incomplete scan writes diagnostics
when `--report` is supplied but does not export a misleading complete snapshot.
The source timestamp and archive count are included separately from the selected
snapshot's record count. Current standalone import reads canonical snapshots;
raw legacy JSON/YAML uses this explicit Python conversion step, not a hidden
browser filesystem crawler.

The verified example exports 63 records from the 123-record test SOURCE1 archive.
It does not enable SOURCE2. The production `C:\data\SOURCES1` scan observed on
September 13, 2026 begins on March 23, 2024, so exporting its March 18 interval
correctly produces an empty snapshot. Choose an interval from each source's
reported domain rather than assuming the test and production archives coincide.

## Verification

```powershell
.venv\Scripts\python.exe -m pytest tests/server/test_legacy_sources.py tests/server/test_serve_legacy_cli.py
```

The source tests cover configuration safety, enabled/disabled sources, stable
IDs, prefix remapping, calendar boundaries, missing folders, timezones, and
symlink/reparse rejection. Reader, server integration, rendering, and browser
tests are additional release checks; passing source-path tests alone does not
qualify the full application release.
