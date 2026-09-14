# Presentation Extension v1

Implementation contract for the bounded presentation increment, 12 September 2026. Companion inventory: [legacy compatibility matrix](legacy-compatibility-matrix.md). This extends, not replaces, the nine required fields in the visual-definition schema. All existing definitions and their immutable published versions remain valid and retain the old default appearance/layout when no new presentation or record styling is supplied. This document specifies behavior; it is not a test report.

## 1. Exact Schema Shape

The optional visual-definition property is `presentation`. Every object below rejects unknown properties. Only `version` is required on presentation; optional objects/fields inherit the effective defaults below. JSON Schema files are `presentation.schema.json` and `record-render.schema.json`, referenced by the existing visual and record schemas.

```json
{
  "presentation": {
    "version": 1,
    "bands": {
      "primary": {
        "backgroundColor": "#ffffff", "textColor": "#20262c", "dateColor": "#59636b",
        "sessionColor": "#39788a", "eventColor": "#39788a",
        "barHeight": 8, "pointRadius": 4.5,
        "axisPosition": "bottom", "intervalUnit": "HOUR", "dateFormat": "DEFAULT"
      },
      "overview": {
        "backgroundColor": "#f0f2f4", "textColor": "#20262c", "dateColor": "#59636b",
        "sessionColor": "#39788a", "eventColor": "#39788a",
        "barHeight": 4, "pointRadius": 2,
        "axisPosition": "bottom", "intervalUnit": "DAY", "dateFormat": "DEFAULT"
      }
    },
    "grouping": { "field": "/data/status", "direction": "asc" },
    "sourceStyles": [ { "sourceId": "SOURCE1", "backgroundColor": "#000000", "textColor": "#ffffff", "dateColor": "#ffffff" } ],
    "labels": { "fields": ["/title"], "fontSize": 13, "fontWeight": 400, "fontStyle": "normal", "maxLines": 2, "backgroundColor": null },
    "inspector": { "fields": [ { "field": "/title", "label": "Title" }, { "field": "/data/status", "label": "Status" } ] },
    "nesting": { "enabled": true, "color": "#75909e", "opacity": 0.15 },
    "baseline": { "enabled": true, "color": "#78848d" }
  }
}
```

Bounds and enums:

- Colors are exact `#RRGGBB`, normalized only for comparison, not silently replaced. Label `backgroundColor` additionally permits null (explicitly no background).
- Band `barHeight`: finite number 2..20 CSS px; `pointRadius`: finite number 1..10. `axisPosition`: top/bottom. Units: existing eleven MILLISECOND through MILLENNIUM. `dateFormat`: DEFAULT plus the exact35 spellings LC-T01..LC-T35 in the matrix. No arbitrary formatter/eval.
- The hazard extension adds `minorDivisions` (integer 1..12). Values greater than one require an explicitly authored MILLISECOND, SECOND, MINUTE or HOUR unit. Main-band divisions use the same pinned mapping as records, omit duplicate major ticks, and suppress subdivisions closer than eight mapped pixels. Calendar units are not approximated. Overview and model-preview subdivision rendering remain unimplemented; this is not a claim of complete band parity.
- `sourceStyles`: array0..100, unique sourceId (nonblank1..100 codepoints). Allowed overrides: backgroundColor,textColor,dateColor,sessionColor,eventColor. Unknown sources can be stored for portable models but do not authorize/query that source; preview reports unused style, not an access grant.
- `grouping.field`: `/sourceId`, `/kind`, or `/data/` followed by1..8 nonempty JSON Pointer segments, maximum256 codepoints. RFC6901 `~0`/`~1` decoding only; reject invalid escapes and decoded `__proto__`, `prototype`, `constructor` segments. Own-property traversal only. Direction asc/desc, defaultasc. Presentation grouping overrides the old groupBy selector only while present; deleting it restores old groupBy.
- `labels.fields`: unique1..4 field pointers; `/id`, `/title`, `/kind`, `/sourceId`, `/start`, `/end`, `/originalStart`, `/originalEnd`, `/order`, or safe `/data/...`. Default `["/title"]`. `fontSize`: integer11..24, default top-level fontSize. Weight400/700; style normal/italic; maxLines integer1..4, default1. No arbitrary font family/assets. These four approved Noto Sans font profiles have matching embedded fonts/metrics.
- Inspector: fields1..24, same safe pointer set; label nonblank1..80 codepoints. Text-only display this increment. No HTML/link/image/code display instructions. Missing fields shown as unavailable, null as null; arrays/objects shown as bounded JSON text in inspector, not evaluated.
- Nesting enabled defaultfalse, color#75909e, opacity0..0.35 default0.15. Baseline enabled defaultfalse,color#78848d. New fields absent do not turn on these layers.

The optional canonical record `render` keys are: existing `color`, plus `textColor`, `backgroundColor` (color/null), `fontSize`11..24, `fontWeight`400/700, `fontStyle`normal/italic, `barHeight`2..20, `pointRadius`1..10, `icon`. Icon is one of `circle`, `check`, `alert-triangle`, `info`, `flag`, `radio`, `clock`, `file-text`, `star`; absence means no icon. Icon paints inside an approved fixed16x16 CSS-pixel box. Imported icon paths or arbitrary SVG/URLs are not accepted as this enum. Unknown render fields still reject.

The hazard extension also admits the eight logical icon IDs in
`shared/legacy-hazard-icons.json`. These select embedded, unmodified legacy PNGs,
not runtime URLs. For point events, a hazard image replaces the generic circle,
is centered at the timestamp (`iconX = xStart - 8`), and retains its own colors.
The right label begins at `xStart + 13`; a left label ends at `iconX - 4`.
Duration sessions retain their bars. The full icon bounds participate in layout.
Supplied copyright/license notices accompany the images; complete asset provenance
is still a release-review obligation.

## 2. Resolution and Provider Inputs

`createLayout(queryId, input)` adds optional `presentation`, validated identically to the model extension and frozen with the layout input. It is not a mutable lookup against whichever model is currently selected. Existing width, availableHeight, rowHeight, fontSize, groupBy, mapId and decimal view-bound inputs remain. The UI passes its effective model presentation to every normal, resized and preview layout; stale source/query guards remain in force.

Model apply copies presentation into settings, or **removes** a previous settings.presentation when the new published definition lacks it. Immutable model versions are not backfilled with new defaults. Export/import retains the exact optional object and record overrides. The canonical pin and explicit client view overrides continue to have their existing meanings.

Resolution order: legacy theme defaults/top-level fontSize -> selected primary/overview band -> matching sourceStyle -> allowed record.render overrides. Labels fontSize/weight/style/background and field list supply the base label profile; record values win. A band's textColor wins over theme, source textColor wins over band. Record color overrides kind-specific session/event color. Transient search/selection paint is separate, never written into render. Source background does not become record label background.

Default theme palettes preserve the current renderer (primary light#eef0f0/classic#a9d7ef/dark#171c21); existing overview colors remain when no override is authored. Source row backgrounds may be painted only for rows with a single source; mixed-source packed rows must not acquire an arbitrary first record's source background. For a mixed-source row, a source background instead paints behind that source's measured label box only when neither model labels.backgroundColor nor record render.backgroundColor was explicitly authored. Explicit null suppresses this fallback; explicit label color remains authoritative. This contrast fallback changes no footprint, geometry, stored definition or provider layout. Hover preserves resolved label backgrounds; transient search yellow remains separate. Group headers from `/sourceId` use their source palette.

Layout response adds `presentation` (resolved band/label/settings view), effective `rowHeight`, and `enclosures` metadata. Each item adds `style`, `labelLines`, `labelInkOffsets`, `labelLineHeight`, `labelOffsetY`, `geometryOffsetY`, `fullLabel`, `parentId`, `depth`, `ancestorIds`, optional `iconX`, `baselineStart`, `baselineEnd`, `baselineOffsetY`. Existing `record`, `row`, `xStart`, `xEnd`, `labelX`, `labelWidth`, `displayTitle`, `overflow`, footprints and match remain. The renderer consumes these resolved values, not a second differently ordered style merge. Each line's text origin is labelX minus its signed labelInkOffsets entry, so italic overhang remains within the measured box.

`style` keys: color,textColor,backgroundColor,fontSize,fontWeight,fontStyle,barHeight,pointRadius,icon (null if absent),sourceBackground (null if none). Labels font family is Noto Sans. Render instance count remains one per admitted record; enclosure fragments/group headers are decorations, not extra records. Table record counts remain independent of timeline rows.

## 3. Exact Label and Geometry Algorithm

Approved metrics files: existing `shared/fixtures/font-metrics.json` for400-normal; `font-metrics-700-normal.json`, `font-metrics-400-italic.json`, `font-metrics-700-italic.json` with identical glyph schema for other variants. Measure advance/ink union exactly as current implementation, after resolving weight/style. Missing glyph fails with `unsupported_glyph`; do not silently use fallback metrics. No claim of shaping/bidi support outside the approved profile.

Field text is joined with ` | `; missing and null fields contribute no label text. String, finite number, boolean values use their ordinary canonical text; labels reject object/array values with `invalid_label_value`. If every selected field is empty, use record.title. Replace CRLF/CR with LF and tabs with a single ASCII space. Other content remains intact.

Wrap each LF-delimited paragraph greedily by codepoint into the available measured width. Take the longest fitting prefix; if there is an ASCII-space break inside it, break at the last such space (trim boundary ASCII spaces), otherwise break the token at that prefix. Preserve explicit paragraph breaks. Stop at maxLines; if remaining content exists, fit `...` onto the final line by removing trailing codepoints until it fits. `overflow=true` and fullLabel retain the full text. This is bounded multiline/expanded-inspector behavior, not a claim that maxLines always exposes arbitrarily long labels in full. Measured comparisons use width+1e-9 tolerance; no zero-width reservation on error.

Point label side selection follows the existing right/left-space choice using the maximum unwrapped paragraph width; gap is pointRadius+5, increased to reserve a left icon where necessary. Session label starts at clamped xStart, within6px plot gutters. Label available width is the chosen side width for points and plotWidth-12 for sessions. The fixed16px icon starts at xStart-pointRadius-5-16 for points (5px clear of the marker) and xStart-20 for durations. A left-side point label ends at iconX-4 when an icon is present. Icon position is independent of label side. Include icon's clipped rectangle in footprint.

For new-style layouts labelLineHeight=ceil(fontSize*1.35), labelOffsetY=6. Duration geometryOffsetY=8+labelLines.length*labelLineHeight+barHeight/2. Point geometryOffsetY=6+max(16,labelLines.length*labelLineHeight)/2. Effective global rowHeight=max(requested rowHeight, every item's labelOffsetY+labelLines.length*labelLineHeight+6, each duration geometryOffsetY+max(barHeight/2,icon?8:0)+6, each point geometryOffsetY+max(pointRadius,8)+6). Round effective height up to integer; maximum192. Insufficient availableHeight for one effective row returns row_height_limit; never a successful zero-progress page. All pages of the same layout use the same effective height.

Footprint is the clipped union of marker/bar (point full radius plus2px padding; duration2px padding), label lines plus2px horizontal padding, icon box plus2px padding, and enabled originalStart/originalEnd baseline plus2px padding. Baseline appears only when at least one original date is nonnull. Original date missing uses corresponding current date; null originalEnd on an ongoing session uses overview-domain end. Baseline endpoints project with the same map/view and clip to domain/plot. For durations baselineOffsetY=geometryOffsetY+barHeight/2+3; for points baselineOffsetY=max(geometryOffsetY+pointRadius+3,labelOffsetY+labelLines.length*labelLineHeight+3), below the complete label stack. Its 1px line adds a row-height minimum of baselineOffsetY+0.5+6. No timestamp modification, no inferred tolerance unit. Unrelated packed footprints retain4px clearance.

Without new presentation/record styling, preserve previous layout geometry/packing exactly. New explicit presentation, including `{version:1}`, selects the resolved new-style algorithm. Existing render.color alone does not activate a new algorithm. Sort primitive/canonical values exactly as provider contract, not Intl collation.

## 4. Grouping and Nested Rows

Grouping resolves only authorized filtered query records. Supported grouping values are string/finite number/boolean/null/missing; object/array values return invalid_group_value. Group order is numbers ascending, strings NFC/codepoint ascending, booleans false before true, then null, then missing; direction desc reverses only present groups (types remain number,string,boolean), null/missing remain last. Keys encode type and value without collisions (`1` differs from `"1"`); labels are readable values, null `(null)`, missing `(missing)`. Strings compare NFC but preserve original record text.

Nesting OFF uses existing stable first-fit with the resolved full footprints. With nesting ON, groups containing an eligible connected parent/child relationship use one record per row, depth-first preorder, to provide consecutive collision-safe activity blocks. Groups without any connected relationship use the same first-fit packing as nesting OFF, allowing unrelated hazard points to reuse rows. This does not claim compact aggregate-block packing. Roots sort start/end/id as before; siblings sort order(default0),start,end/id. A parent relation connects only if that parent is also eligible for the current window and same effective group. Otherwise the child becomes a root for this layout; do not inject filtered-out/out-of-window ancestor records. Report `parentId` from canonical data but ancestorIds contains only connected eligible ancestors. Canonical relationships remain unchanged.

Each eligible parent with connected descendants produces one global enclosure `{parentId,title,startRow,endRow,xStart,xEnd,color,opacity,depth}`. endRow exclusive; X union of its own and descendants' footprints plus4px padding clipped to plot. Rows are not duplicated to draw enclosure. `getRows` returns intersecting enclosures with `continuedBefore`/`continuedAfter` and clipped visibleStartRow/visibleEndRow. Repeated enclosure context never increments loadedCount/detailTotal. Parent enclosure metadata derives only from the same authorized immutable query. A five-record parent/activity block with row capacity2 yields2/2/1 record pages, one global record placement each, correctly flagged fragments. The row payload cap remains enforced.

## 5. Rendering, Axes and Declared Limits

UI consumes returned effective rowHeight for normal/preview/table-independent timeline paging. Both band axis positions are explicit and reserve space outside data rows; bottom remains the default. Independent intervalUnit/dateFormat format their band's own time projection, never a shared rescaled label string. Formatting uses corrected calendar values: hh is24-hour, numeric fields padded, months1..12. The35 source format spellings are accepted as literal safe format IDs, not code. DEFAULT uses the existing unit formatter.

Source styles are applied to detail items/group headers and overview items consistently. Overview endpoint should accept optional validated presentation for style resolution, or UI resolves only the same pure style function over returned sourceId/kind/render fields; it must not fetch full records just to determine color. Any added overview fields come from the same pinned query. Aggregate bars use neutral aggregate color rather than falsely claiming a single source color for mixed members.

The later read-only legacy adapter supports authored band proportions and intervalPixels-based initial focus, plus the main HOUR/AUTO quarter-hour behavior described above. The embedded font profiles now include measured Latin Extended glyphs in all four variants, without changing stored labels or the earlier Latin glyph metrics. Arbitrary assets/materials, free font families, arbitrary callback descriptors, generic recurrence, exact legacy fixed screen placement, full overview/preview subdivision behavior and Perspective camera remain outside this bounded presentation implementation. The default remains orthographic. See the current [hazard comparison](hazard-rendering-parity.md) and [implementation status](implementation-status.md) rather than treating this contract as complete release evidence.

Required gates: shared schema vectors, Local/Python exact style/group/wrap/row/enclosure parity, font ink bounds, per-record overrides, baseline/icon clearance, publication/apply-removal/history/export/restart, source-switch/preview isolation, arbitrary-field text safety, desktop/mobile actual screenshots and no unhandled browser errors. Zero mandatory skipped tests may count as passed.
