# Local Time Scaling

The toolbar exposes **Auto scale**, **Optimize rows / Manual scale**, and a
**Local scale** slider from 1x to 32x. These controls work with the Python
provider and the complete standalone dataset.

With Auto scale enabled, Optimize rows compares complete layouts at 4x, 8x,
16x and the selected maximum (only candidates within the limit; below 4x,
the selected limit is used directly).
It chooses the smallest total row count; ties use the lower ratio. Legacy
path-picker connections initially allow up to 32x. Authored settings and
user-selected limits are otherwise respected.

The comparison includes labels, duration bars, namespace grouping and the
model's layout rules. It uses provider-side full-layout counts, not the rows
loaded on the current page. Only the winning layout's visible page is fetched.
Candidates from a different committed generation/revision are not compared;
the comparison stops with one coherent fresh layout if data changes.
Unused and canceled query handles are released. Only one optimization query
coexists with the currently displayed query, respecting Local's two-query
limit. The winning ratio is prepared once more if it was not the final probe.

Choose **Manual scale** to apply the slider ratio directly to density-based
local magnification. This affects the density map across the query domain,
not one independently selected segment. Turn off **Auto scale** for uniform
time distances. The existing +/- buttons zoom the visible time range.

The scale strip shows positive relative factors, for example `4.0x` (the old
`~4.0x` meant approximately 4x, not negative 4x). The strip, markers, bars,
zones and axis use the same pinned map. The slider is a relative slope limit,
not a promise that every interval becomes that many screen pixels wider.

Optimization runs when preparing a query, changing the explicit zoom/range,
or resizing the plot width. Pagination and dragging within an already-pinned
analysis domain keep the map fixed, avoiding jumps under the pointer. A new
overview domain triggers a fresh comparison. Use Refresh to optimize again
after panning within the existing domain. The strategy selector is a temporary
UI preference; the ratio is included in normal personal settings/export.

This is a bounded candidate search, not a mathematical global optimum over
all possible nonlinear mappings. Simultaneous events, overlapping sessions,
long labels, and models that put nested records on separate rows can impose
an irreducible row count. Their rows are not hidden, collapsed or made
unreadable to claim an improvement. Raising the ratio may have no benefit;
Optimize rows then retains the less distorted candidate.

## Verified UI

Actual standalone rendering of the complete bundled generic dataset, captured
with Playwright at 1600x900 and 390x844. These are not design mockups or captures
of the user's production sources. Both Three.js canvases are checked for
nonblank pixels; the controls are checked for overlap and viewport overflow.

![Desktop local scaling controls and distinct time segments](ui/local-scaling/scaling-1600.png)

![Mobile local scaling controls with synchronized overview](ui/local-scaling/scaling-390.png)
