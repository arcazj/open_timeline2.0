# Earthquake and Volcano Rendering

This comparison uses the corrected legacy root `C:\projects\openbexi_timeline`.
The new application reads the existing JSON without modifying it. The legacy
HTML, model, YAML and source files remain authoritative, read-only inputs.

## Reference and Changes

The reference is `openbexi_timeline_earthquake.html`, with
`models/regular_timeline_earthquake.json` and `yaml/sources_earthquake.yml`.
The enabled sources resolve through `/data=C:\data` to
`C:\data\earthquake\yyyy\mm\dd` and `C:\data\volcano\yyyy\mm\dd`.

![Original renderer with its overview initially hidden](../output/hazard-parity/legacy/legacy-hazard-initial.png)

The original renderer was exercised with unchanged HTML/JavaScript/assets and a
read-only request fixture containing actual JSON from September 11-12, 2026.
No legacy Java service, connector, filter writer or data writer was run.
The original overview-toggle capture did not settle into a usable two-band
layout in this harness, so it is not presented as verified reference evidence.

The implementation now preserves eight explicitly registered flag/volcano PNGs
instead of replacing their different meanings with one generic icon. Images are
embedded at 16 x 16 CSS pixels, retain their colors and do not load arbitrary URLs.
The main HOUR model with `subIntervalPixels: AUTO` retains quarter-hour divisions
when there is sufficient pixel spacing. The same time map positions these lines
and all records. Unrelated points reuse collision-free rows even when nested
session enclosures are enabled. Actual parent/child groups retain their enclosure
and continuation behavior.

The embedded, measured Noto Sans Latin Extended subset includes the macron used
in the original place names. Original labels are not transliterated. Both Python
and JavaScript use the same extended measurement tables for regular, bold and
italic variants. Run `scripts/prepare-font-variants.py` after regenerating base
fixtures, then rebuild the standalone HTML.

## Current Rendering

![Current Python-backed hazard timeline](ui/hazards/current-server/legacy-namespace-desktop.png)

The main range is **September 12, 2026, 12:00-16:00 UTC**: 42 actual records on
nine collision-free rows at a 2,000-pixel plot width. The synchronized overview
covers **September 11, 14:00 through September 13, 14:00 UTC**, with 383 records.
This view has no authored zones; zone behavior is covered separately by the
existing zone and integration tests.

Differences from the original are intentional and visible: the current client
keeps its overview visible, reserves measured label footprints, allows labels
to appear left of markers near the right edge, and uses responsive geometry.
The font, row positions, menu spacing and overview marks are not pixel-identical.
The overview uses compact points, not full-size flag images.
The overview row arrangement currently follows provider item order; time positions
and membership match, but the compact rows can differ between providers. Minor
grid subdivisions are implemented in the main band, not the overview or model
preview. These are remaining presentation-parity tasks, not certified behavior.

## Search, Selection and Mobile

![Standalone search highlights and matching overview](ui/hazards/current-local/legacy-search.png)

`Kilauea` has one finding in the chosen overview. Its label is yellow; the main
timeline retains contextual records, while the overview shows only the finding.

![Current server descriptor](ui/hazards/current-server/legacy-descriptor.png)

![Standalone mobile view](ui/hazards/current-local/legacy-namespace-mobile.png)

Mobile uses vertical row pages instead of reducing type size. The standalone
snapshot contains all 383 records in the declared two-day range. It is **not**
the entire 140,924-record server archive and makes no claim about newer records.
The bundled/imported snapshot is a separate source, never a cached server page.

## Evidence and Limits

Capture receipts beside the images record the bundle hash, main/overview ranges,
loaded records, icon loads, canvas pixels, label overlaps and horizontal overflow.
Actual-data drag checks in both modes keep the query/map pinned, move labels and
the time axis together by 96 pixels while held, update the overview selection,
and settle at the same new range without making the source dirty.
`scripts/verify-hazard-parity.mjs` independently compares raw legacy identities
against both providers, including complete row-page traversal and pinned maps.
Its report is `output/hazard-parity/data-verification.json`.

The full archive scan found 9,687 record JSON files, 140,924 records, zero rejected
or duplicate records and no incomplete scan. The range export read about 210 MB
in 100.3 seconds in one observed run; this is not a cold/warm percentile benchmark.
The source fixture's 43 file hashes are checked again after comparison. Archive
startup still performs a full bounded scan and is not instantaneous.

The earlier [SOURCE1/SOURCE2 evidence](legacy-json-preview.md) belongs to its
explicitly recorded earlier build; it is not relabeled as a current capture.
This hazard comparison does not certify every historical model, source, browser,
dataset size or interaction. Unsupported glyphs outside the registered subsets
still produce an explicit diagnostic. Original PNG copyright/provenance needs
release review; the supplied repository license is preserved with the assets.

The [implementation limits](implementation-status.md) and full release gates
remain open. The companion PDF is `output/pdf/OpenBEXI_Hazard_Comparison.pdf`.

## Verification: September 13, 2026

These results exercise standalone bundle SHA-256
`738d811266304f8444978ed7d0a121f8031b93fecb03f608efcfc1cbb422e42a`.
All build-manifest input hashes and both current capture receipts match this build.

| Check | Result | Evidence |
| --- | --- | --- |
| JavaScript client | 186 passed | `output/hazard-parity/client-tests-final.xml` |
| Python server | 830 passed, 1 skipped; 329.06 seconds | `output/hazard-parity/server-tests-final.xml` |
| Real HTTP provider integration | 37 passed | `output/hazard-parity/provider-tests-final.xml` |
| Full Playwright suite | 122 passed, 0 skipped/flaky/retries; 550.5 seconds | `artifacts/browser/hazard-final-results.json` |
| Actual hazard data | 42 identities across 3 row pages; 383 overview records; matching provider maps/layouts | `output/hazard-parity/data-verification.json` |
| Static checks | Ruff clean across server, server tests and scripts; OpenAPI matches registered handlers/schemas | Local command verification |
| Comparison PDF | Five pages rendered and visually inspected | Companion PDF and `tmp/pdfs/hazard-comparison/` |

The four automated suites total **1,175 passed and one skipped**. Windows denied
test symlink creation (`WinError 1314`) in
`test_record_symlink_and_recovery_parent_symlink_are_rejected`; this security case
remains unverified on this host. Python also emitted two upstream deprecation
warnings. This run does not certify other browser engines or platforms.

The first full browser attempt had 121 passes and one mobile drag failure: its
baseline was sampled before the initial ResizeObserver layout settled. The helper
now waits for matching plot/canvas geometry before measuring. Held-drag geometry
assertions remain strict. Ten consecutive focused repetitions and the subsequent
full suite passed. The initial failure is preserved in
`artifacts/browser/hazard-first-full-results.json`; focused repetitions are not
added to the suite total. Final browser screenshots are under
`artifacts/browser/hazard-final/`.

The PDF SHA-256 is
`573f593e56090e6c2a9cb3897825d67623fb6fb5179fb8ab9f77dc81953f8815`.
No release tag, full-matrix approval or all-model certification is implied.

## Reproduce

Start the read-only server with `sources_earthquake.yml`, the hazard model and
the explicit `/data=C:\data` mapping, following [source setup](legacy-json-sources.md).
Use `scripts/import-legacy.py` with the same source/model options and the declared
overview `--from`/`--to` to create a new range snapshot outside the source roots.
The checked snapshot is `output/hazard-parity/hazard-range-snapshot.json`.

```powershell
node scripts/capture-hazard-legacy.mjs
node scripts/verify-hazard-parity.mjs --url http://127.0.0.1:8768
node scripts/capture-legacy-ui.mjs --url http://127.0.0.1:8768 `
  --from 2026-09-12T12:00:00.000Z --to 2026-09-12T16:00:00.000Z `
  --overview-from 2026-09-11T14:00:00.000Z --overview-to 2026-09-13T14:00:00.000Z `
  --width 2040 --height 1200 --hazards --search Kilauea `
  --output docs/ui/hazards/current-server
```

Set `OPENBEXI_API_TOKEN` for these commands. For offline capture replace `--url`
with `--snapshot output/hazard-parity/hazard-range-snapshot.json` and use a separate
output directory. `scripts/build-hazard-preview.py` refuses failed or outdated
capture/parity reports before generating the PDF.
