# Calendar And Momentum Navigation

The navigation update follows the legacy `ob_setListeners` drag-start/drag-end
behavior and the right-side calendar in `ob_create_calendar`, while retaining
the current date-range dialog, JSON providers and two-band renderer.

## Momentum

- Drag the main timeline in either direction. A quick release continues the
  movement with gradual deceleration; a slow or paused release stops directly.
- Press the timeline to stop the glide at its displayed position. Continue
  dragging from that position, or release to load the stopped view. Stopping a
  glide on a record does not accidentally select it.
- Geometry and the adaptive map stay pinned during motion. Grid lines, labels,
  bars and zones move together. The overview range follows during long glides.
- A new date range is fetched when motion settles. Newly exposed, not-yet-loaded
  areas are marked Pending, not presented as a complete empty result. The
  overview marks pending context until its refreshed data arrives.
- Escape cancels a gesture. Source/filter changes invalidate old work. Reduced
  motion disables inertia and visual overshoot. Supported time bounds remain
  years 0001-9999; the loaded archive does not constrain navigation.

The 240-pixel coast limit has been removed. Release velocity controls an
exponential decay with a 700 ms time constant, at most four viewport widths of
additional travel and a four-second maximum duration. These are bounded motion
limits, not boundaries on the dates users can reach with repeated navigation.

The gesture's high-precision time map is compiled once. A 500-frame, 257-knot
mapping microbenchmark on this Windows workspace measured approximately
3.33 ms per projection with repeated parsing and 0.02 ms with the compiled
gesture. These are projection-only timings, not whole-frame or cross-device FPS.

## Calendar

The toolbar Calendar button opens a right-side month panel. On narrow screens
it overlays the timeline and can be closed with its X button or Escape. The
existing Date and time range button still opens the explicit start/end dialog;
the same command is also available inside the calendar.

Month arrows, the month selector and year input browse without moving the
timeline. Selecting a day centers the timeline on that day and the displayed
UTC time. Today selects the current UTC date. The time field and crosshair
command recenter the selected date without changing records or filters.

Time precision follows the visible divisions around the timeline center,
including fallback divisions after zooming and adaptive magnification:

| Scale | Time Selection |
| --- | --- |
| Hour | Defaults to 04:00 UTC; whole hours |
| Minute | Whole minutes |
| Second | Whole seconds |
| Millisecond | Millisecond precision |
| Day through millennium | Midnight UTC on the selected date |

The actual temporal center is shown below the time control. Adaptive queries
recenter using the newly prepared map, not the arithmetic midpoint of the
endpoints. Calendar navigation preserves active source/filter/search settings.
Rapid selections supersede older requests; a failed query retains the previous
view. At the supported year boundaries, the viewport is clamped to valid dates.
Automatic live refresh waits while the calendar is open. Configured legacy
servers open directly on real data; background interval-index completion does
not switch sources, replace the pinned view or close the calendar.

The month grid starts Monday and keeps six rows. Arrow keys move one day or week;
Home/End move within a week, Page Up/Down move a month, and Shift+Page Up/Down move
a year. Enter/Space choose the focused day. Date arithmetic uses the existing
Temporal library; UTC selection is independent of the browser's local timezone.

## Screenshots

These are captures of the implemented application using its generic bundled
records, not mockups or historical source data. The selected time was adjusted
to 10:00 UTC to show the populated timeline; hour mode initially offers 04:00 UTC.
Images are available in this repository document; the embedded Help reader
includes the text but omits images.

![Desktop calendar and timeline](ui/navigation/calendar-desktop.png)

![Mobile calendar](ui/navigation/calendar-mobile.png)

## Verification

```powershell
node --test --test-concurrency=1 tests/client/*.test.mjs
npm run build
npx playwright test tests/e2e/calendar-momentum.spec.mjs tests/e2e/smooth-navigation.spec.mjs tests/e2e/local-paths.spec.mjs tests/e2e/standalone.spec.mjs
```

Focused coverage includes pinned-map projection, long coasting in both
directions, click-to-stop, cancellation, reduced motion, out-of-range grid and
overview rendering, actual canvas pixels, desktop/mobile layouts, UTC/leap-year
boundaries, all eleven units, keyboard selection, superseded requests, and
calendar navigation against an isolated Python legacy-JSON server.
