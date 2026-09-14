# Local test datasets

## Open a Dataset

Open `dist/index.html`, then **Help and sharing > Test local data**. Select a dataset and choose **Open dataset**. All six complete datasets are embedded in the one-file build. No HTTP, CDN, Python process or filesystem fetch is needed. Only the selected dataset is initialized in the local provider. The UI identifies the selected snapshot and its timestamp; it never represents these fixtures as current server data.

Switching clears the previous source's range, search and filters and applies the selected preset. Unsaved local changes require confirmation. **Reset reference view** restores the preset without editing records. Search, filters, the descriptor, table view, navigation, local scaling and vertical pagination remain available. Every record can be reached, including those outside the reference's initial time window.

## Complete Sources

| Dataset | Records | Initial view | Python profile / port | Supplied reference |
| --- | ---: | --- | --- | --- |
| default-dataset | 48 | Existing operations sample | `yaml/test-data/default-dataset.yml` / 8781 | None |
| ephemeris | 127 | 21 April 2020, hourly main band and overview | `yaml/test-data/ephemeris.yml` / 8782 | None |
| jfk | 130 | 22 November 1963, 12:00-14:00 America/Chicago | `yaml/test-data/jfk.yml` / 8783 | `data/jfk.png` |
| monet | 27 | 1824-1916, decade divisions and age axis | `yaml/test-data/monet.yml` / 8784 | `data/monet.png` |
| religions | 730 | 365 BC-AD 36, four source-specific bands | `yaml/test-data/religions.yml` / 8785 | `data/religions.png` |
| space_exploration | 1,287 | 1957-1977, year divisions and overview | `yaml/test-data/space_exploration.yml` / 8786 | None |

Example read-only server launch:

```powershell
npm run build
.venv/Scripts/python.exe scripts/serve-legacy.py --yaml yaml/test-data/religions.yml
```

Open `http://127.0.0.1:8785/`, or the client URL printed by the launcher. No bearer token is requested by the loopback browser interface. Server state is kept in `var/test-data/<id>`; source JSON is never changed. These profiles use `snapshot.file`, exclusive of date-partitioned `legacy`/`data_sources` configuration. Paths resolve relative to the YAML file. Existing earthquake/volcano and SOURCE1/SOURCE2 launch profiles are unchanged.

These small complete fixtures are validated and indexed as one JSON snapshot. They do not exercise partitioned archive lazy loading. Large `<path>/yyyy/mm/dd` archives should continue to use the [on-demand source profiles](on-demand-loading.md).

The historical fixtures are read-only in both modes. The default standalone operations sample retains its existing in-memory editing behavior; even its YAML-served copy is read-only. Source switching does not silently synchronize edits or replace server data.

## Normalization and Integrity

`data/original/` preserves exact input bytes. The repeatable converter produces `data/<id>.json` and `data/reports/<id>.json`, with input SHA-256, counts, source assignments and diagnostics. There are 2,349 input and output records with none dropped. Three files were HTML-like event markup despite their `.json` extension; they are converted offline. Runtime parsing remains JSON-only.

```powershell
.venv/Scripts/python.exe scripts/normalize-test-data.py
.venv/Scripts/python.exe scripts/normalize-test-data.py --check
npm run build
```

Date rules are explicit and identical in Python and JavaScript:

- Domain timestamps use proleptic Gregorian astronomical years -9999 through 9999. `0000` means 1 BC; `-000199` means 200 BC. Axis labels display BC rather than ambiguous negative numbers.
- Year-only inputs use January 1 UTC. EST and EDT preserve their stated fixed offsets. A trailing `?` retains a nominal year and an uncertainty annotation, not an invented exact date.
- An end date alone does not convert a point into a duration. The legacy `isDuration` flag controls that distinction. `lateststart` and `earliestend` are retained; duration uncertainty uses a translucent interval with its definite portion emphasized.
- One unnamed Religions item receives a stable fallback title. One Space exploration entry literally says year `201`; it remains AD 201 and is flagged for review rather than silently changed. Use date navigation to include AD 201 in the analysis window, then inspect it in the timeline or table. For read-only sources, All filtered records refers to the current query window, not the whole archive.
- Original fields are retained in `extensions.sourceRecord` and shown in the descriptor. Descriptions are plain text, with active markup removed. Remote images are not downloaded; missing original assets are listed in the reports.

Snapshot generation time is a conversion timestamp, not a claim about the historical source's publication date. User-provided data and screenshots have unverified redistribution rights. Missing artwork is not replaced with unrelated images.

## Reference Layouts

The reference configuration is data-driven through versioned presentation models, not hard-coded record coordinates. Existing models remain available; the preset can be reset after experimentation.

- `compact` keeps readable label/marker spacing while allowing more rows. A reserved lower strip prevents zone captions and auxiliary page controls from covering records.
- `bandLayout` supports one primary band, an optional overview, one synchronized detail band, and additional context bands up to six total. Detail inherits the primary range and map. Context bands have their own initial ranges and follow temporal navigation. Each band can restrict source IDs and configure its background and height share.
- `fixedScale` describes deliberate magnified intervals. Overlaps use the highest ratio, never compounded ratios. Each band's bars, markers, zones, axis and selection projection use the same monotonic mapping. Main-band magnification has a scale guide; the overview identifies magnification. Automatic scaling remains separately selectable.
- `relativeAxis` adds a calendar-year age axis without altering absolute dates. `durationLabels: inside-when-fitting` places fitting labels in bars, with contrast-aware text; short bars retain external labels and measured collision footprints.
- Source-restricted overview queries filter before aggregation. Density remains based on the complete filtered query, independent of vertical pages. Band requests use one data revision and discard stale completions.

The three supplied PNGs guide band count, proportions, colors, time windows, magnification, zones and age-axis behavior. Current screenshots below are real application captures, not mockups. They are **not pixel-identical**: font metrics, collision-safe row ordering, responsive controls, accessible contrast, ticks and overview aggregation differ. There is no supplied PNG for Default, Ephemeris or Space exploration; those captures are explicitly unapproved baselines, not invented legacy matches.

## Screenshot Gallery

### JFK

Supplied reference:

![Supplied JFK timeline](../data/jfk.png)

Current timeline, including the colored zone and magnified overview:

![Current JFK timeline](ui/test-data/jfk-timeline.png)

### Monet

Supplied reference:

![Supplied Monet timeline](../data/monet.png)

Current single-band timeline with relative age axis:

![Current Monet timeline](ui/test-data/monet-timeline.png)

### Religions

Supplied reference:

![Supplied Religions timeline](../data/religions.png)

Current source-specific context/detail/main/overview bands:

![Current Religions timeline](ui/test-data/religions-timeline.png)

### Additional Baselines

No supplied PNG exists for these three views.

![Default dataset baseline](ui/test-data/default-dataset-timeline.png)

![Ephemeris baseline](ui/test-data/ephemeris-timeline.png)

![Space exploration baseline](ui/test-data/space_exploration-timeline.png)

### Mobile

![Monet on a 390-pixel viewport](ui/test-data/monet-mobile.png)

![Religions on a 390-pixel viewport](ui/test-data/religions-mobile.png)

## Verification

Automated coverage includes exact input/output counts, preserved input hashes, malformed markup rejection, historical date round trips, fixed-map boundaries, query/page stability, server read-only enforcement, unchanged-file revision stability, Python/JavaScript layout parity, complete offline browsing, source switching, reference reset, and desktop/mobile canvas rendering. Browser tests block HTTP in file mode and fail on console errors.

```powershell
node --test tests/client/*.test.mjs
.venv/Scripts/python.exe -m pytest tests/server -q
node --test tests/integration/*.test.mjs
$env:OPENBEXI_UPDATE_SCREENSHOTS = '1'
npx playwright test tests/e2e/test-data.spec.mjs
Remove-Item Env:OPENBEXI_UPDATE_SCREENSHOTS
```

Per-dataset capture manifests under `docs/ui/test-data/` identify the exact HTML build, dataset counts and viewport. Functional parity and screenshot inspection do not certify pixel equivalence, historical factual accuracy, container execution or full release readiness.

Ordinary browser tests now write captures to ignored `artifacts/browser/test-data/`. Only the explicit `OPENBEXI_UPDATE_SCREENSHOTS=1` documentation run above updates `docs/ui/test-data/`, preserving reviewed screenshots during CI and regression tests.

The companion PDF is generated from these same reference images and verified captures. After rebuilding and explicitly updating the documentation captures, run `python scripts/build-test-data-preview.py` in a documentation environment with ReportLab installed. The script rejects capture manifests from an older HTML build and writes `output/pdf/local-test-data.pdf`.
