# Legacy visual contract

Normative companion for OpenBEXI Timeline 2.0, recovered from the complete [17-page illustrated legacy brief](../OpenBEXI_Timeline_Rebuild_Prompt_legacy.pdf), especially pages 12-17. Prepared 12 September 2026 for Revision 2.2. This document specifies future implementation and current design mockups; it does not authorize application development during prompt refinement.

The [main specification](../OpenBEXI_Timeline_Rebuild_Prompt.md) controls canonical data, JSON-only storage, permissions, API writes, model lifecycle, synchronization and safe listener behavior. The [coverage audit](legacy-brief-coverage.md) records page-by-page omissions from archived Revision 2.1. Revision 2.4 uses the generic light two-band timeline as the default, with local nonlinear mapping and provider-owned row pages in Server and Local modes. This contract controls the optional Classic blue appearance and its deterministic Uniform-scale fixture; it does not override the newer default, provider, pagination or mapping rules. Do not silently replace either timeline model with a generic dashboard or one-task-per-row Gantt.

## Evidence and precedence

The legacy PDF's page 8, Figures 1/2, reproduces repository screenshots of the blue grouped timeline and neutral event timeline. Pages 9/10, Figures 3/4, are proposed successor mockups; page 11, Figure 5, enlarges them. Page 17, Figure 6, is the authoritative synthetic fixture. These are not captured proof of a rebuilt application.

As directed on page 12, exact dimensions, timestamps, record counts and behavioral rules take precedence over inaccurate illustrative pixels for the Classic compatibility fixture. Render every bar and overview mark from canonical data. The blue grouped appearance was revision 2.2's default and remains a selectable compatibility target in revision 2.4. Retain all supported neutral, black-background and other model configurations; a different style is not a reason to retire a model. Exact scalar coordinates below assume Uniform scale, and old band-growth language cannot override provider-owned pagination in the new default.

User-supplied screenshots remain separately labeled evidence, with no invented capture provenance. Their datasets must not be mixed into the 14-record primary fixture.

## Recognizable shell

Preserve a compact silver-to-blue-gray toolbar, icon-driven commands, horizontal time canvas, broad alternating blue bands, darker type gutter, staggered thin duration bars, small point/glyph marks, central reference marker, optional white right calendar, and bottom overview. Improve text clarity, spacing, hit areas and accessibility without changing this composition into a tall branded header and permanent sidebar.

Toolbar order is connection, calendar, refresh, filter and search on the left; report/reference time in the center; compact Gantt/Table/Split selection, camera controls, settings and help on the right. Model and source management remain accessible from compact commands/menu navigation. Preserve orthographic and perspective support under the main compatibility contract.

Navigate is the initial interaction mode. Record, band or region drag pans time without changing record dates. Make Edit visibly explicit and permission-aware; do not sacrifice that behavior to imitate an ambiguous old icon. Additional required commands must fit the compact shell or an accessible overflow menu.

## Desktop geometry

The reference viewport is 1600 x 900 CSS pixels at 100% browser zoom. Coordinates below are measured from the application's top-left. They are fixture targets, not hardcoded limits for every screen or dataset. Source: legacy PDF p13.

| Region | Position and size |
| --- | --- |
| Main toolbar | x=0, y=0, width=1600, height=56; gradient from `#D3D8DF` to `#6C8A9C`; 40 x 40 hit regions and approximately 24-28 px icons. |
| Filter strip | x=0, y=56, width=1600, height=56; source, type, visible range, zoom, Fit, Now and connection state. |
| Timeline canvas | x=0, y=112, width=1304, height=620. |
| Calendar/selected-record pane | x=1304, y=112, width=296, height=740. |
| Time ruler | y=112 through 152. |
| Fixed type gutter | x=0 through 88; plot uses x=100 through 1292 after padding. |
| type0 band | y=152 through 400. |
| type4 band | y=400 through 604. |
| type1 band | y=604 through 732. |
| Overview | x=0, y=732, width=1304, height=120. |
| Application footer | x=0, y=852, width=1600, height=48. |

Default band fills alternate `#A6D7F8` and `#99BFD3`; gutter fill is `#82A9BF`. Use actual grouped tracks, not a permanent timeline row for each record. Bands may grow with content; overflow scrolls rather than dropping records.

## Time mapping and marks

Show 18 May 2021, 13:00-17:00 UTC. Major hour ticks are at x=100, 398, 696, 994 and 1292. Minor ticks are 15 minutes apart. A black pin/thin reference line marks 15:00 at x=696. This is a reference/playhead time, not an automatic synonym for the live current time. If Now is shown, label it separately and use the declared test clock. Source: legacy PDF p13, section 16.

`x(t) = 100 + 1192 * ((t - 2021-05-18T13:00:00.000Z) / 240 minutes)`.

- Draw duration bars from x(start) to x(end), clipped to the plot; visual height 10-12 px; corners square or 1 px radius; 32 px track pitch.
- Draw point records as 12-16 px glyphs, not invented short duration bars. Use at least 24 px interaction targets without inflating the visible marks.
- Use 14 px body/event text, 13 px tick labels and 22 px type labels by default. Place a label 8 px after its bar when space permits.
- Resolve collisions with tracks or alternate label placement before ellipsis; expose full labels on keyboard focus and in details. Clip the plot's drawing layer so labels never cover the calendar.
- Selection retains the record's original fill and glyph. Add a 2 px `#168BFF` outline with a 2 px gap. Keep hover, keyboard focus, selection and persisted indicator metadata distinct.
- Initial EVT-004 geometry is x=720.83 through 919.50. The fixture edit to end 16:00 moves its endpoint to x=994 without moving its 15:05 start.

The overview must contain exactly the 14 fixture records, with true times and colors, not the decorative extra marks visible in the legacy proposed image. Its declared full-day context is 00:00-24:00 UTC for this fixture, with the 13:00-17:00 detail window visibly indicated. Reuse the model's explicit overview transform; do not apply detail-axis pixel coordinates to the overview.

## Full Table mode

Keep the toolbar, filter strip, calendar boundary at x=1304 and footer unchanged when switching from Gantt to full Table. Hide the Gantt overview in full Table mode. Use one row per canonical record. Source: legacy PDF p14, Exact tabular layout and section 17.

| Element | Geometry or treatment |
| --- | --- |
| Table controls | x=0, y=112, width=1304, height=52; total records, Group: Type, Columns, Density, Export CSV, Scope: Current range. |
| Column header | y=164 through 208, height=44 px. |
| Group headers | 32 px high, pale blue `#C8E8FA`, bold 14 px text, chevron, name and exact record count. |
| Comfortable rows | 34 px high. The 14 rows and 3 group headers occupy y=208 through 780. |
| Compact rows | 28 px high; its shorter body is intentional and does not use the comfortable body's end coordinate. |
| Pagination | Comfortable fixture occupies y=780 through 852; retain count/range/navigation at the bottom of the table region for other densities. |
| Row fills/grid | Alternating `#FFFFFF` and `#F0F8FD`; 1 px `#C8DDEA` grid. |
| Selected row | `#DCF1FF` fill, 3 px `#168BFF` left rule and checked selection box. |
| Hover | `#E8F5FF`; must remain distinct from selected state. |
| Focus | Visible 2 px ring around the focused cell, separately from selection. |
| Text | 14 px rows, medium-weight headers, 10 px cell padding, tabular numerals for dates/durations. |

Default widths at 1600 px are authoritative and sum to 1304 px:

| Column | Width in CSS pixels |
| --- | --- |
| Checkbox |44|
| ID |112|
| Type |92|
| Event |440|
| Start UTC |148|
| End UTC |148|
| Duration |132|
| Indicator |188|

Keep Checkbox and ID sticky during horizontal scrolling. Support resize, reorder, hide and restore-default actions. Prefix titles with their actual color/glyph; show textual Indicator meaning beside its icon. None of these cells becomes Selected merely because the record is selected.

Initial group order is type0 (6), type4 (4), type1 (4); sort by start ascending within each group, then canonical ID as a stable tie-breaker. Collapsing a group preserves its count and selected IDs. Provide an explicit ungrouped mode. Group context and matching-record totals must follow the canonical query rules.

For this single-day fixture use `HH:mm:ss` and a visible `18 May 2021 - all times UTC` caption. Multi-date data uses `YYYY-MM-DD HH:mm:ss` with wider columns or deliberate horizontal scrolling. Points show End as a dash and Duration `00:00:00`; an unknown duration shows a dash, never fabricated zero. Keep selected EVT-004 consistent in the timeline, table, calendar summary and details.

## Calendar and details

The default 296 px white right pane has a silver Calendar heading, month navigation and a Monday-first day grid. Show May 2021 and select the 18th with a cyan `#27B8F5` circle. Today uses a separate outline and semantic label. Keyboard and screen-reader users must distinguish selected day, today, month navigation and unavailable dates. Source: legacy PDF p15, section 18.

Below the calendar show Selected event, fixture alias/full stable identity, complete title, type, start, end, duration and Open details. Calendar-day selection navigates time while retaining the current window span; it must not change the selected record implicitly. Indicate when the selected record lies outside the new window.

Open details uses a 360 px right drawer or accessible dialog with a close command, full metadata and edit actions only when the source and principal permit writes. Escape closes and returns focus to the opener. Preserve form input on validation/concurrency/save failure, place the explanation at the field/action, and keep both views on confirmed canonical state until a write succeeds.

## Scope and shared state

The legacy fixture starts with explicit Scope: Current range. Apply the same canonical interval predicate in Gantt and Table, including the special point and zero-duration rules. All matching retains search/source/group filters but omits the visible-range predicate and labels the different total. This named model default does not add a hidden viewport filter to unrelated API requests or models.

Selection, search, filters, timezone, record values and confirmed edits stay synchronized across view changes and Split arrangements. Selecting a row may identify its timeline mark without unexpectedly moving the viewport; explicit Reveal navigates to it. Sorting the Table does not reorder timeline bands or change the time range.

Sources explicitly declare their supported write policy. A read-only source remains inspectable/exportable according to permission, while every mutation channel rejects unsupported writes consistently. A privileged ingestion/migration path is separate from ordinary editing.

## Responsive behavior

Source: legacy PDF p15, section 19. Keep required controls reachable rather than shrinking the 1600 px composition until unreadable.

| Width/state | Required behavior |
| --- | --- |
| 1200-1599 px | Flexible main layout; toolbar commands may move to an accessible overflow menu. |
| Below 1200 px | Collapse calendar into a drawer. |
| Below 768 px | Compact toolbar, Filters popover, full-width Gantt/Table tabs, 44 px touch targets and deliberate horizontal Table scrolling. |
| Split at 1440 px or wider | Hide calendar by default; use 60% Gantt/40% Table separated by a 6 px resizable divider. Apply proportions to available content width after reserving the divider. |
| Split at 768-1439 px | Stack Gantt above Table; keep shared selection, data, filters, timezone and edits. |
| Below 768 px Split | Use the single-view tabs while retaining both views' state. |

For desktop and narrow screens, keyboard focus and selected records must remain reachable across scrolling, virtualization, drawers and layout transitions. Expose full labels without covering adjacent controls.

## Operational states

- Loading retains the shell and shows labeled progress.
- Empty retains the ruler or headers and shows No events in this range with Reset filters.
- A disconnected Server source retains last confirmed data, marks it Stale, shows last-successful time and offers Retry. An intentionally active Local source is not disconnected: label its snapshot scope and Ready or Modified in memory state; JSON export remains explicit.
- Saving, validation, permission and concurrency errors remain visible and keyboard-accessible. Server mode must not imply a successful write before the API commit; Local mode must distinguish a validated in-memory mutation from an explicit JSON export and must never imply server persistence or automatic synchronization.
- Expanded details have meaningful read-only and writable states. Focus restoration, Escape, cancel and failed-save recovery are tested separately from their appearance.

## Authoritative fixture

Source: legacy PDF p17, Figure 6. These 14 records are synthetic acceptance data, not an assertion about existing application datasets. Date 18 May 2021; timezone UTC; visible range 13:00-17:00; reference time 15:00; initial selection EVT-004. The fixed test clock must be declared; reference and Now may be tested separately.

| Fixture alias | Type | Event | Start UTC | End UTC | Duration | Indicator | Event color |
| --- | --- | --- | --- | --- | --- | --- | --- |
|EVT-001|type0|Antenna allocation|13:10:00|14:15:00|01:05:00|Planned|`#253C78`|
|EVT-002|type0|Orbit propagation|13:35:00|15:10:00|01:35:00|Running|`#4C7900`|
|EVT-003|type0|Command preparation|14:00:00|14:50:00|00:50:00|Complete|`#601654`|
|EVT-004|type0|Telemetry downlink|15:05:00|15:45:00|00:40:00|Nominal|`#008A80`|
|EVT-005|type0|Station handover|15:30:00|16:20:00|00:50:00|Linked|`#986015`|
|EVT-006|type0|Archive transfer|16:00:00|16:50:00|00:50:00|Warning|`#486A85`|
|EVT-007|type4|Data validation|13:15:00|13:55:00|00:40:00|Complete|`#674E8F`|
|EVT-008|type4|Packet decode|14:10:00|15:20:00|01:10:00|Running|`#006969`|
|EVT-009|type4|Quality review|15:25:00|16:10:00|00:45:00|Planned|`#16833F`|
|EVT-010|type4|Report build|16:15:00|16:45:00|00:30:00|Planned|`#8A511C`|
|EVT-011|type1|AOS|13:10:00|-|00:00:00|AOS|`#008535`|
|EVT-012|type1|Sync|14:15:00|-|00:00:00|Sync|`#2056BC`|
|EVT-013|type1|Warning|15:20:00|-|00:00:00|Warning|`#E79915`|
|EVT-014|type1|LOS|16:50:00|-|00:00:00|LOS|`#C82620`|

The first 10 records map to canonical finite sessions; the last 4 to canonical point events with null end. Duration is derived. Keep a stable mapping between each displayed fixture alias and one canonical UUID; do not store a duplicate record under the alias. A fixture adapter maps Type into declared type/group fields, Indicator into a declared metadata field such as `data.status`, and color into an approved render override. Record the mapping and keep glyph definitions explicit and approved. Selection, focus and hover never write Indicator, color or glyph metadata.

Exactly these 14 records appear in the fixture overview. All 3 groups, count totals, IDs, times, colors and indicator values must agree across views even when only a subset of marks/rows is physically visible. Additional black/neutral/model-stress datasets are named separate fixtures.

## Acceptance and handoff

Before application handlers are implemented, encode this contract in model/schema/fixture definitions and a requirements-to-component/test map. Current mockups must be labeled proposed static designs. Actual implementation screenshots must later come from the application.

1. Load the 14-record fixture and verify group counts 6/4/4 and exact set equality between same-scope Gantt/Table/overview queries.
2. At 1600 x 900 and 100% zoom, check toolbar order, band structure, type gutter, calendar, reference marker, bar endpoints, glyph sizes, table widths and clipping. Allow at most 2 CSS px difference from specified static geometry; allow font antialiasing differences. Verify actual timestamps independently.
3. Select EVT-004 in Gantt, switch to Table, and confirm the same UUID/alias, title, type, times, duration, teal fill and Nominal indicator. Preserve selection through sorting, filtering, collapsing, virtualization and view changes.
4. In Server mode, through the real JSON-backed API in a disposable writable fixture workspace, change EVT-004 end to 16:00. Verify duration 00:55:00 and endpoint x=994, reload to prove server persistence, then restore the original fixture through supported commands. In Local mode, perform the same permitted edit in browser memory, verify identical duration and geometry plus the Modified in memory/export-pending state, explicitly export JSON and re-import that export to prove portable persistence. An unexported reload must not be presented as durable, and no Local action may silently upload or switch providers.
5. Test grouped/ungrouped Table, both densities, start/ID sorting, sticky checkbox/ID, column resize/hide/reorder/reset and selected-row/focus/hover distinctions.
6. Test calendar day navigation without record reselection, calendar open/closed, 360 px details, Escape/focus return, read-only sources, valid saves and retained input on failed saves.
7. Repeat responsive checks at 1280, 1024 and 390 px widths, plus breakpoint-boundary cases around 1440, 1200 and 768. Verify wide 60/40 Split, stacked Split, tabs, 44 px touch targets and reachable overflow controls.
8. Capture populated, loading, empty, stale/disconnected, validation, read-only and conflict states. Confirm screenshot comparison does not replace keyboard, screen-reader, contrast, touch or data assertions.
9. Keep `docs/ui-spec.md` with actual tokens, component dimensions, breakpoints and justified departures. Deliver baseline and updated screenshots, the deterministic fixture/loader adapter, visual-test commands/results, manual accessibility findings and per-requirement verification evidence. Do not claim a baseline runtime comparison when the original cannot run.

No application implementation or application verification is claimed by this document. JSON-only persistence, all-model support, secure migration, listener semantics and the current prompt-only scope remain mandatory.
