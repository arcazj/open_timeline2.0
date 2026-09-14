# Read-Only Legacy JSON Preview

These are real browser captures of the implemented JavaScript/Three.js client,
not proposed mockups. The production and authored test examples use different
actual datasets; they are not silently substituted for one another. Source JSON,
descriptor files, models and YAML remain unchanged.

## Production Source and Namespace

The Python server reads `C:\data\SOURCES1` through
`C:\projects\openbexi_timeline\yaml\sources_startup.yml`. Its data template is
`/data/SOURCES1/yyyy/mm/dd`, explicitly mapped to `C:\data`.

The model comes from `tests/models/regular_timeline.json`, with explicit namespace
grouping. The black lane is the authored YAML source background, not an invented
dark theme. The source's actual archive begins on March 23, 2024, after the
model's fixed March 18 focus; the capture navigates to a populated March 23-24
interval. An empty initial March 18 view is therefore a truthful data result.

![Production namespace timeline and synchronized overview](ui/legacy/production-source1/legacy-namespace-desktop.png)

The captured interval contains 62 detailed records and a broader overview of 785
records. Only a vertical page is drawn in the main band. Folder dates do not
truncate session durations: the server index finds overlapping sessions stored
in earlier folders.

## Search

This standalone example uses the actual authored test source from
`yaml/sources_default_test.yml`, not the production archive. `SOURCE2` is disabled
in that YAML and stays disabled. The exported snapshot contains all 63 records
overlapping its declared March 18, 2024, 19:00-21:00 UTC interval, with required
ancestors; it does not claim to contain the full archive outside that interval.

![Yellow search findings and search-only overview](ui/legacy/authored-test-source1/legacy-search.png)

The search `5_1 0_3` produces three overview findings. This main-band row page
contains the yellow `Activity_0_3` and `Activity_5_1` labels. Search context and
density are independent of the currently displayed vertical page.

## Descriptor

![Selected production session and right-hand descriptor](ui/legacy/production-source1/legacy-descriptor.png)

Selecting a record opens the right-hand descriptor. The separate legacy sidecar
is available on demand through a namespace-and-ID-checked read. Authored text is
displayed as text, never executed as HTML. Editing commands are disabled in this
read-only source mode.

## Mobile

![Production timeline at a mobile viewport](ui/legacy/production-source1/legacy-namespace-mobile.png)

The same source retains its overview, timeline navigation and vertical-page
controls. Browser checks verify nonblank canvases, no horizontal page overflow,
and no overlapping visible record labels.

## Verification

- Final full Python regression: 827 passed, one Windows symlink-creation
  test skipped because the environment did not permit creating that test link.
  Report: `output/legacy-verification/server-final-tests.xml`.
- Final legacy-focused Python run: 170 passed, no skips. This includes safe YAML,
  path mapping, leap dates, year boundaries, source grants, stable IDs, read-only
  API behavior, pinned queries, descriptors and last-good file images.
- Client unit suite: 182 passed, no skips. Real HTTP/Local provider parity:
  37 passed, no skips. Reports are recorded in
  `output/legacy-verification/client-tests.xml` and `provider-tests.xml`.
- Final Windows/Edge browser suite: 120 passed, no failures, skips, flaky tests
  or retries. Report: `artifacts/browser/final-legacy-rerun-results.json`.
  It includes deterministic late-response selection and source-switch regressions.
- Browser capture receipts are stored beside each figure in `verification.json`.
  They include actual view state, canvas pixel diversity and label-overlap checks.
  Both capture reports and the full browser report identify the same standalone
  build: `a317c75aed6fd7b00b28140e77e57eba3a6161a27103d191f434b34dab2039eb`.
- `tests/e2e/smooth-navigation.spec.mjs` covers held drag, frozen mapping,
  synchronized axis/overview previews, cancellation and reduced motion.
- `tests/e2e/legacy-read-only.spec.mjs` covers read-only Local data and model UI.

The compatibility implementation supports bounded in-memory archives. It is not
an unlimited archive engine or a certification of every historical model and
pixel layout. The current two-band model adapter reports unsupported authored
properties. The earlier full-release checklist still applies.

See [source configuration and startup commands](legacy-json-sources.md) and the
companion PDF in `output/pdf/OpenBEXI_Legacy_JSON_Preview.pdf`.

## Reproduce the Captures

Build the client and start a configured read-only server as described in the
source guide. Keep its bearer token in `OPENBEXI_API_TOKEN`, not in capture files.

```powershell
node scripts/capture-legacy-ui.mjs --url http://127.0.0.1:8767 `
  --from 2024-03-23T23:05:00.000Z --to 2024-03-24T01:05:00.000Z `
  --overview-from 2024-03-23T12:00:00.000Z --overview-to 2024-03-24T12:00:00.000Z `
  --output docs/ui/legacy/production-source1

node scripts/capture-legacy-ui.mjs `
  --snapshot output/legacy-verification/source1-test-2024-03-18.json `
  --output docs/ui/legacy/authored-test-source1
```

The capture script requires populated actual data and fails verification instead
of manufacturing events. Run `scripts/build-legacy-preview.py` with ReportLab to
regenerate the PDF only after both capture reports pass.
