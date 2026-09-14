# Actual Implementation Preview

These are screenshots of the implemented application, captured by Playwright. They are not design mockups or a promise that the full modernization specification is complete.

Browser run: `2026-09-13T02:06:34.684Z`. Passed browser cases: 72.

Standalone bundle SHA-256: `b378ab6b146151764638fd2f5c2335417dda0e054558b5a7afeddf2887290793`.

The browser run used Windows and Microsoft Edge, a 1600 x 900 desktop viewport and a 390 x 844 narrow viewport. See [implementation status](implementation-status.md) and [testing](testing.md) for remaining features and certification gaps.

[PDF preview](../output/pdf/OpenBEXI_Timeline_Implementation_Preview.pdf)

## Standalone timeline

The complete embedded sample, two synchronized bands, measured rows and aligned zones.

![Standalone timeline](ui/implementation-preview/standalone-desktop.png)

## Contextual search

Matching labels are highlighted; the overview shows all findings, not just the current row page.

![Contextual search](ui/implementation-preview/search-findings.png)

## Adaptive time scale

Local magnification expands dense intervals while pagination handles excess simultaneous rows.

![Adaptive time scale](ui/implementation-preview/adaptive-navigation.png)

## Selection and Split view

The selected record has a right-side descriptor; timeline rows and table records have independent pagination.

![Selection and Split view](ui/implementation-preview/split-selection.png)

## Python-connected mode

The same application reads and writes a JSON-only Python service through the common provider interface.

![Python-connected mode](ui/implementation-preview/server-connected.png)

## Versioned model library

Draft editing, immutable publication and explicit version selection keep the active workspace stable.

![Versioned model library](ui/implementation-preview/model-library.png)

## Model definition editor

Structured fields and strict JSON share validation; portable definitions are separate from complete history exports.

![Model definition editor](ui/implementation-preview/model-editor.png)

## Independent model preview

The candidate model renders a separate read-only query without changing the active timeline or its temporal focus.

![Independent model preview](ui/implementation-preview/model-preview.png)

## Complete-query table

Stable sorting and page traversal cover the complete chosen scope, independent of timeline row capacity.

![Complete-query table](ui/implementation-preview/table-local.png)

## Structured filters

Typed nested conditions and explicit search modes use matching Local and Python query semantics.

![Structured filters](ui/implementation-preview/filters-local.png)

## Model-driven presentation

Measured multiline styles, icons, original-time baselines, nested sessions and configured descriptor fields.

![Model-driven presentation](ui/implementation-preview/presentation-desktop.png)

## Presentation preview

Band colors, date formats and label geometry render before explicit publication and application.

![Presentation preview](ui/implementation-preview/presentation-preview.png)

## Narrow viewport

The main and overview bands remain visible at 390 x 844 CSS pixels, with bounded row pagination.

![Narrow viewport](ui/implementation-preview/standalone-mobile.png)

## Model library on a narrow screen

The same model catalog and editor remain available in the standalone application at a narrow viewport.

![Model library on a narrow screen](ui/implementation-preview/model-mobile.png)

## Styled timeline on a narrow screen

The same measured presentation and synchronized overview remain available directly from the standalone file.

![Styled timeline on a narrow screen](ui/implementation-preview/presentation-mobile.png)
