# OpenBEXI Timeline: Track Allocation and Text Collision Audit

Revision 2.2 documentation supplement to `OpenBEXI_Timeline_Rebuild_Prompt.md`.

Audit date: 12 September 2026. Repository: https://github.com/arcazj/openbexi_timeline. Pinned commit: `cf5d263853e550aab44d3d1959637c1e324b719e`.

## 01. Purpose, Interpretation, and Evidence Limits

The requested overlap improvement is interpreted as preventing unintended visual overlap of event/session graphics and their full displayed text. Real intervals are allowed to overlap in time: the layout must separate their representations without changing timestamps, shortening sessions, moving records to different times, or inventing scheduling constraints. The requirements also cover point markers, icons, labels, baseline graphics, and parent/activity enclosures.

This audit inspects the complete [`get_first_free_tracks`][J3172] and [`get_room_for_session`][J3218] functions, their callers, text measurement, aggregate bounds, grouping, band-height adjustment, and rendering helpers. The legacy application was not built or run. The arithmetic counterexample below is a direct source walkthrough, not an executed browser test. Browser text metrics, final pixels, measured performance, and complete behavior remain future implementation checks.

The legacy attempts to reserve horizontal space for both graphics and titles, then allocate vertical tracks. That intent is worth preserving. The implementation does not prove or guarantee collision-free output, and at least one valid occupancy input causes its allocator to reuse an occupied track. This document specifies corrections, not a requirement to reproduce defective geometry.

## 02. Source Call Chain and Data Flow

| Stage | Source behavior | Evidence |
| --- | --- | --- |
| Prepare bands | Sets styling and track defaults, creates grouped bands, adjusts heights, and computes visible/date bounds. | [`set_bands`][J2514], [band properties][J2460] |
| Start layout | `set_sessions` iterates bands and their sessions, with at most two layout passes. | [`set_sessions`][J3575] |
| Normalize records | Reads the response's `events` collection; wraps a standalone record as one synthetic activity; keeps existing activities; separates zone records from sessions. | [`init_sessions`][J3538] |
| Partition by grouping | Uses selected `sortBy`/`data.sortByValue` to admit a session into a band matching its layout name. With NONE, it appends without that grouping filter. | [Band admission][J3556] |
| Measure activity | Converts start/end and original dates into coordinates, assigns width/height, measures title, adds approximate icon/tolerance allowances, and computes `total_width`. | [`init_activities`][J3427] |
| Measure aggregate | Computes session body width, aggregate total width, earliest current X, original X, and an activity-count-based height. | [Aggregate calculation][J3597], [extent helpers][J3285] |
| Find occupied tracks | Compares the new aggregate's horizontal interval with all previously placed sessions in that band; collects every overlapping aggregate's activity Y. | [`get_room_for_session`][J3218] |
| Allocate rows | Sorts occupied Y values descending and searches for a place for the new session's consecutive activity tracks. | [`get_first_free_tracks`][J3172] |
| Place activities | Sets the first child's Y to the returned track and subtracts `trackIncrement` for every later child. | [Placement loop][J3614] |
| Adjust height | May lower a band's minimum Y and mark the layout as updated; then recalculates band heights/positions. | [Height request][J3247], [`set_bands_height`][J2307] |
| Render | Applies per-record style overrides after layout, renders activities, and adds multi-activity enclosures. | [`create_sessions`][J3710] |

The normal update chain calls band preparation and session layout before creating geometry and sprites. The required rebuild architecture should retain a clear separation between canonical records and derived layout, while ensuring measurement and rendering consume the same resolved style and label content.

## 03. What the Two Allocators Actually Check

### 03.1. Horizontal Conflict Collection

`get_room_for_session` compares the candidate session with preceding sessions `0 .. j-1`, preserving their input order. It uses an interval starting at `original_x` and ending at `original_x + total_width`. Four inclusive comparisons cover containment and partial intersection. When intervals touch at an endpoint, the legacy treats them as conflicting. For every horizontally conflicting session, all of that session's activity Y coordinates become busy. The list is sorted descending, but not deduplicated.

This is a conservative aggregate-block strategy: if one child extends a group's horizontal span, that span can reserve every child track against unrelated sessions. It is not a per-glyph, per-rectangle, or per-child horizontal collision test. It does not measure vertical bounds, text ascent/descent, wrapped lines, focus outlines, or final projected geometry.

After asking `get_first_free_tracks` for a top row, the caller may extend `band.minY` below that row by the activity block height plus one track. This is intended to create more vertical space. The later two-pass height update is not a convergence test or a final collision assertion.

### 03.2. Track Search

`get_first_free_tracks` starts at:

`candidateY = band.maxY - band.fontSizeInt - band.trackIncrement`

It returns this immediately if there are no busy rows. Otherwise it examines busy Y values and estimates available row counts from coordinate differences divided by `trackIncrement`. Some branches subtract `activities.length * trackIncrement` from the candidate or a busy row. Missing next-row values, exceptions, and NaN computations have fallback returns below the last busy row.

The function never verifies the complete returned block against every occupied track before returning. It also assumes a constant vertical increment can safely contain each activity's graphics and text. Neither assumption is valid for all supported data/style inputs.

### 03.3. Concrete Source-Level Counterexample

Consider these valid allocator inputs:

| Input | Value |
| --- | --- |
| Initial candidate Y | 80 |
| Track increment | 20 |
| Incoming activity count | 2 |
| Busy track Y coordinates, descending | 60, -20 |

For example, the initial candidate follows from `maxY = 112`, `fontSizeInt = 12`, and increment 20. Walk the [function's branches][J3172]:

1. At busy row 60, candidate 80 is above it. The gap is one track, insufficient for two activities. The loop subtracts two increments, changing the candidate to 40.
2. At busy row -20, the gap from candidate 40 is three tracks. Because this is not the first iteration and three is greater than two, the function returns `40 - 2*20 = 0`.
3. The [caller][J3614] places the two activities at Y values 0 and -20.
4. The second activity occupies an already busy row, -20.

This shows why preserving this exact first-fit routine cannot satisfy the non-overlap requirement. The replacement must validate all rows and footprints in a proposed block before accepting it. Regression coverage must include this exact example and generated occupancy patterns, not only screenshots of uncomplicated data.

## 04. Graphics, Text, and Aggregate Bounds

### 04.1. Intended Reservation

In [`init_activities`][J3427], a finite activity's width is the integer-truncated end offset minus start offset. A point uses `sessionHeight` as its width and `defaultEventSize` as its size. The title is measured using the band's font size/family and a margin of 10. The code adds 32 units when a per-record image is specified and adds a numeric tolerance allowance under selected conditions. The resulting reservation is approximately:

`total_width = bodyWidth + measuredTitleWidth + imageAllowance + toleranceAllowance`

The text's position is derived from the body and measured text widths. [`getSessionTotalWidth`][J3318] then computes the span from the earliest activity X to the greatest `activity.x + activity.total_width`. [`getSessionWidth`][J3285] does the equivalent for body widths only. These are different extents, intentionally used for different purposes.

### 04.2. Measurement Does Not Match the Final Render

[`getTextWidth`][J3259] uses a canvas text context, caches by text and supplied font, and calculates `actualBoundingBoxRight - actualBoundingBoxLeft`. According to the [HTML Canvas text-metrics contract][TEXTMETRICS], left and right are signed distances on opposite sides of the alignment point; their sum gives the ink span. Subtraction can under-reserve left overhang, notably for italic/slanted glyphs. Advance width and ink bounds serve different purposes and may differ. This is a standards-based interpretation of the expression, not a measured legacy screenshot result.

Further mismatches are visible in source:

- The measuring font contains only the band size/family, while [rendering later accepts per-record font size, family, weight, and style overrides][J3740]. A larger record label can exceed its reserved width and height.
- [Band font-size normalization][J2484] can append `px` to an already unit-bearing instance font size when the band omits its own size. An invalid font string must not silently reuse unrelated measurement state.
- [Sprite creation][J4138] sets `fontStyle` to a literal property-name string instead of the supplied style value. Whatever the dependency does with that input is not evidence that measuring and drawing agree.
- Measurement only reserves horizontal title width. It does not determine glyph ascent/descent, line height, line breaks, wrapping, background/border padding, selection/focus decoration, or a label's final camera projection.
- A caught measurement error returns zero. Missing/non-finite metrics are not explicitly rejected. The cache has no explicit bound or invalidation on font loading, fallback changes, or other metrics-affecting state.

The replacement must resolve label fields and every allowed visual override before measurement. It must measure the same shaped text, font/style, padding, line breaking, and transform that it will render. Invalid/unknown measurements must trigger a bounded retry or safe layout fallback with diagnostics, never a zero-width reservation that permits collision.

### 04.3. Marker and Icon Extents

[`add_event`][J3992] renders a sphere using the configured size as a radius or an image plane with its own dimensions. A point's visible diameter is not generally the `sessionHeight` width used during reservation. This happens to align for some defaults but not arbitrary permitted event sizes.

[`add_session`][J3884] can add an icon to the left of a duration's start using a copied point record. The legacy allowance expands total width to the right from the activity X; it does not model that leftward footprint. A band-level default image can also be used at render time without the per-record-image condition that adds the measurement allowance.

The replacement must reserve the union of actual marker/bar, icon, label, baseline/tolerance decoration, and required clearance in a common coordinate space. A scalar width measured only from the start date is insufficient when content extends to both sides.

### 04.4. Baselines and Activity Enclosures

[`getSession_originalX`][J3406] selects the greatest original X for multiple activities, while the other span calculations use the earliest current X. `init_activities` may assign that aggregate original position back during its per-activity loop. The final conflict interval can therefore use an origin unrelated to the complete visible union. Tolerance also has no verified temporal unit; it must remain metadata until an explicit rendering/unit mapping exists.

A multi-activity enclosure is constructed using body width and an activity-count-based height, not the aggregate title footprint. Its intended overlap with its own children is a legitimate containment decoration, not a collision defect. It must not obscure those children or unrelated records. The rebuild must reserve a documented group block and render the parent/enclosure behind its own child content with appropriate padding and separate parent-label space when needed.

There is also a source deduplication mismatch: [`add_sessionsBox`][J3808] searches for a name containing `sessionBox`, while [`setBoxProperties`][J3870] assigns a different name. The overview path can request the same enclosure once per activity. This can create duplicate enclosure geometry and excessive opacity/work; it is not intentional density visualization.

## 05. Grouping, Band Heights, and Overview Density

Track allocation is local to each band. [`create_new_bands`][J2248] derives group names primarily from the first band's selected field and incoming record order. [`init_sessions`][J3538] then filters records into matching bands. Each band's sessions are processed in the resulting sequence; no stable temporal/ID sort is performed inside the two allocation functions. Different response order can therefore change row choices.

Groups and bands are separate visual regions whose heights/positions are recomputed by [`set_bands_height`][J2307]. Large fonts, large markers, or activity groups are not automatically made safe by a fixed 20-unit track increment. The current two passes can recalculate the underlying coordinate bounds, but do not prove that all final labels remain within their bands or clear of axis/group headers.

The overview suppresses ordinary activity labels during [rendering][J3757], reduces geometry sizes, and derives a different track increment from detail/overview heights and scales. This is already a distinct representation, not merely the same detailed layout shrunk uniformly.

However, [`init_activities`][J3427] also multiplies the complete `total_width` by an overview coefficient after the duration width has already been converted using the overview scale. It chooses a comparison band using an index-0/index-1 shortcut. Under the supplied HOUR/DAY model, the coefficient is 1/24; the reserved width is divided while the subsequently drawn session body retains its overview-scaled `width`. Reservations can consequently be narrower than visible bars. The shortcut also does not define arbitrary multi-band relationships.

The replacement should provide two explicit representations:

- **Detailed representation:** preserve readable complete configured labels and distinct visible records, using more lanes, wrapping, and vertical scrolling/virtualization as necessary. Do not declare success by hiding or truncating labels that the detailed mode promises to show.
- **Overview/density representation:** intentionally aggregate or omit per-record labels under a declared mode with counts and an accessible inspection/reveal path. Density marks can combine contributions by design. They must not masquerade as a collision-free detailed record layout or silently drop matching records.

Both use the same authorized record/query snapshot. Their exact display counts and aggregation semantics must distinguish matched records, visible primitives, and density bins. True time overlap remains visible through lane separation or honest aggregation, not by shifting canonical dates.

## 06. Proposed Collision Contract

### 06.1. What Counts as an Unintended Collision

For detailed layout, compute a final two-dimensional visual footprint for every visible record/activity, including its complete displayed label, icon, marker/bar, padding, borders, required interaction decoration, and permitted baseline graphics. Use common rendered coordinates. A footprint may be represented by conservative rectangles or a set of rectangles; it must bound the actual drawing.

Unrelated records' footprints must not overlap or obscure each other. Text must not cross into unrelated text, bars, markers, group labels, axes, toolbars, or inspectors. Proposed initial minimum clearance is 4 CSS pixels between unrelated visible footprints; use the main model's validated clearance settings if it establishes a stricter value. Measure clearance after camera projection and scaling, not by assuming model units equal CSS pixels.

Explicit exceptions must be identified by role and ownership: a label deliberately placed inside its own bar, a session enclosure behind its own children, a shaded background region, or an intentional overview aggregate is not an unintended collision. These exceptions still require legibility, contrast, correct hit ownership, and no obstruction of unrelated content. Transparent paint or a different Z value does not make overlapping unreadable text acceptable.

### 06.2. Full Text and Vertical Space

Resolve full configured label text before layout. Account for every displayed line and field, including Unicode shaping, combining marks, bidirectional text, deliberate line breaks, and long unbroken tokens. The detailed mode must offer full labels through controlled wrapping and sufficient row height; it must not shrink text below supported bounds or substitute a hover-only truncated label as its sole full-text experience.

If a configured label is too large for a practical inline region, use an explicit expanded-label/details state with a visible indication and keyboard access, governed by the model's documented overflow policy. Do not silently clip, elide, or suppress a label to pass a no-overlap check. An explicitly selected compact/density mode may shorten or omit labels, but must preserve an accessible full-text path and must not claim detailed full-label parity.

Rows may have measured heights. A track increment smaller than the maximum permitted rendered content plus clearance must cause an effective larger row/block, a validation error, or a declared compact representation. It must not force text or markers into neighboring rows. Allow vertical scrolling/virtualization instead of squeezing all tracks into a fixed-height band.

### 06.3. Robust Placement and Stable Results

Use a tested interval/rectangle indexing and track-allocation approach suited to the chosen renderer. Typical detailed lanes can use horizontal footprint interval partitioning. Parent activity groups require allocation of a complete consecutive block or an equivalent group layout that validates every constituent row and its height. A returned block is accepted only after all its footprints and clearances are checked against occupied space.

Apply deterministic candidate order using explicit group/parent ordering, temporal keys where appropriate, and stable IDs as tie-breakers. Identical records, styles, viewport, and ordering must produce identical layout regardless of server page order. Preserve unaffected lane assignments during incremental updates when doing so remains collision-safe. Correctness takes priority over avoiding every repositioning.

Changing layout must never mutate event/session dates, original dates, relationships, or versions. Track indexes, measured bounds, and projected positions are disposable view state, not canonical persisted record fields. Editing a time preview uses the common draft command and recomputes a collision-safe preview before its separately authorized write.

### 06.4. Bands, Parents, and Loaded Data

Lay out each band in its actual scale and reserved content region, and allocate enough height for its groups, headers, records, and configured labels. Then verify final band boundaries and projections. Linked bands share center time and query meaning; they need not share raw Y coordinates or density representation. Arbitrary additional bands must use explicit relationships, never index-0/index-1 assumptions.

A parent enclosure may contain its own child geometry, but cannot reserve only its body width while letting labels collide outside it. Respect parent/child ordering and the main specification's rule that child times can extend outside the parent's duration. Parent-context rows returned for filtering must be visually marked and excluded from matched counts; layout must not broaden queries or permissions.

Load and cull using visible visual extents as well as the declared time-window buffer. A long session beginning before the viewport must remain present when it overlaps. A label/icon that extends into the viewport from an offscreen anchor must not collide merely because its owner was omitted from the layout candidate set. Pagination and virtualization cannot treat each fetched page as a collision-independent timeline. Merge candidate geometry by stable identity at a coherent snapshot, or use a documented global/group layout service or density representation.

### 06.5. Measurement, Projection, and Lifecycle

Complete font loading before final measurement, or render a conservatively reserved pending state and invalidate it when the actual font arrives. Cache with a bounded key containing resolved content and all metric-affecting style, wrapping, font-resolution, and scale information. Re-measure after relevant font/style/model/camera/zoom/viewport changes. Never reuse a fallback-font width as the final loaded-font width silently.

For WebGL/perspective displays, verify projected text/marker bounds or use screen-space labels with a documented placement algorithm. A nonintersecting world-space arrangement can still overlap on the screen. If a camera cannot meet the detailed legibility contract, use an explicitly documented representation or reject that incompatible mode; do not silently weaken label guarantees.

Recompute and publish complete layout revisions so a frame does not combine old row positions with new label dimensions. Cancel stale measurement/layout jobs, preserve navigation and selection, and account for opening/closing an inspector or resizing Split mode. During layout transitions, avoid animations that pass readable labels through unrelated content; reduced motion and immediate safe placement are valid choices.

## 07. Verification Method and Acceptance Scenarios

Future verification must combine independent geometric checks with actual rendered screenshots and interaction tests. A solver reporting zero conflicts against its own underestimated bounds is not sufficient. Compare measured DOM/sprite projection extents or independent conservative render bounds, verify full expected text, and inspect representative pixels. Record the query revision, model/style version, font readiness, viewport/camera, zoom, fixture checksum, and declared intentional-overlap exceptions.

Check settled layouts and representative frames during pan, zoom, font load, edit preview, expansion, and incremental updates. Boundaries and the configured positive clearance must hold subject only to a documented subpixel measurement tolerance. Use deterministic fixtures and generated placement inputs. Tests are future requirements and have not been run against an application during this prompt-only task.

| ID | Scenario and required outcome |
| --- | --- |
| L01 | Reproduce the allocator occupancy input candidate 80, increment 20, two activities, busy 60/-20. The replacement never places a child on an occupied row. Test empty/full/duplicate/unsorted occupancy and blocks of varied sizes. |
| L02 | Use temporally overlapping sessions, containing intervals, touching endpoints, zero-duration sessions, and simultaneous points. Dates remain exact while detailed graphics/text are collision-free with declared clearance. |
| L03 | Use two records whose time bars do not overlap but whose long full labels do. Separate/wrap their label footprints; do not treat time-only non-overlap as sufficient. |
| L04 | Test larger per-record fonts, bold/italic, fallback and delayed fonts, combining marks, bidirectional text, wide glyphs, multiple lines, and long unbroken titles. Measure the final style and show complete promised text without hidden clipping. |
| L05 | Mix different marker radii, default/per-record icons, leftward icons, baseline dates, focus/selection outlines, and label padding. Reserve actual left/right/top/bottom extents rather than a scalar start-plus-width estimate. |
| L06 | Lay out parents with one/many activities, child labels longer than body spans, child dates outside the parent, mixed row heights, and repeated groups. Only declared parent/own-label containment overlaps are allowed; unrelated records stay clear. |
| L07 | Change record input order and pagination boundaries while preserving the same snapshot and explicit ordering. Layout is deterministic, pages do not collide, and unaffected rows remain stable when safely possible. |
| L08 | Pan/zoom with one band, detail/overview, and three or more different bands; test HOUR/DAY reservation separately. No reservation is reduced below its rendered body; headers and band boundaries remain clear. |
| L09 | Enable overview/density mode for dense and identical-time fixtures. Aggregates are explicitly labeled/countable, every matching record is accessible, and absent full labels are disclosed as the selected representation. |
| L10 | Resize the window/inspector/Split pane and switch declared camera modes/device scales. Final projected bounds and complete labels satisfy the same detailed contract; navigation, selection, and data do not change. |
| L11 | Edit label fields/styles and preview a time move/resize during live updates. Reject stale layout results; no transient mixed geometry, hidden label, unintended canonical write, or lost draft occurs. |
| L12 | Test top/bottom axis labels, long group headers, empty groups, many tracks, scrolling, and virtualized offscreen records whose footprints reach the viewport. Content remains within the correct region with no missing overlap candidate. |
| L13 | Repeatedly load/unload large datasets, fonts, models, and views. Measurement/layout caches and workers stay bounded, all visible footprints remain finite, and cleanup cancels stale work. |
| L14 | Capture real implementation screenshots for typical and adversarial full-label fixtures. Pair them with independent collision/clearance assertions, expected-text checks, accessible inspection tests, and the main performance benchmarks. Do not report screenshots alone as proof. |

## 08. Pinned Source and Standards References

Every `J` reference below uses the audited commit. The Canvas reference supports interpretation of text-metric signs; it is separate from evidence about the legacy implementation.

[J2248]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L2248
[J2307]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L2307
[J2460]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L2460
[J2484]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L2484
[J2514]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L2514
[J3172]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L3172
[J3218]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L3218
[J3247]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L3247
[J3259]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L3259
[J3285]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L3285
[J3318]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L3318
[J3406]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L3406
[J3427]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L3427
[J3538]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L3538
[J3556]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L3556
[J3575]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L3575
[J3597]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L3597
[J3614]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L3614
[J3710]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L3710
[J3740]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L3740
[J3757]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L3757
[J3808]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L3808
[J3870]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L3870
[J3884]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L3884
[J3992]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L3992
[J4138]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L4138
[TEXTMETRICS]: https://html.spec.whatwg.org/multipage/canvas.html#textmetrics
