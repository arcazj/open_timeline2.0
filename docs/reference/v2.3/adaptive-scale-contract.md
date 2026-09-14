# Adaptive Time Scale Contract

## 01. Status and Evidence

This is a proposed implementation contract for the prompt-only OpenBEXI Timeline 2.0 specification. No application was built or executed to establish these behaviors. The formulas and fixtures below are design requirements, not runtime results. Server authority, bounded query sessions and vertical paging are specified in [Adaptive Query Contract](adaptive-query-contract.md); collision safety remains governed by [Legacy Layout Audit](legacy-layout-audit.md).

SIMILE documents local magnification of dense time spans and a synchronized linear overview whose viewport highlight changes width through magnified regions. That interaction is the reference, not a requirement to reproduce its historical dependencies or approximate calendar arithmetic. Its two-band examples also separate detailed labels from compact overview marks. [SIMILE HotZoneEther](https://simile.mit.edu/timeline/docs/hot-zone-ether.html), [Creating Timelines](https://simile.mit.edu/timeline/docs/create-timelines.html).

Use an established numeric scale library, such as a reviewed version of D3 scaleLinear with multiple ascending domain/range knots and numeric inversion. Validate the constraints below independently; a library does not validate the application contract automatically. [D3 Linear Scales](https://d3js.org/d3-scale/linear).

## 02. Distinct Concepts and Ownership

- **Annotation zone:** a named, colored time interval stored in a versioned visual model. It does not alter time, density, record counts or permissions.
- **Adaptive magnification:** a continuous, nonuniform time-to-position mapping derived from authorized density statistics. It never changes timestamps or durations.
- **Display time zone:** UTC or an IANA formatting/calendar rule, unrelated to either concept above.

Let `C` be the complete authorized filtered record projection at one committed snapshot, not one fetched page. Ordinary contextual search retains C in detail and uses matching projection `M` in the overview; merely changing search highlights must not recompute the C-based map. An explicitly chosen matches-only detail projection uses M and creates a new query/layout contract.

Authored time predicates in C remain fixed within the query session. Moving detail window W, including a Current range display projection, does not redefine C. Use `C_O`/`M_O` for records overlapping analysis domain O and `C_W`/`M_W` for the exact detail window. Map density uses C_O in contextual mode, search overview uses M_O, and detail counts describe C_W/M_W rather than loaded rows. An intentional time-filter change creates a new query/map.

The server owns density statistics, validated map manifests and global row allocation. A client consumes immutable knots; it must not derive replacement density from loaded records. Manifests bind workspace generation, snapshot, scope/projection, finite analysis domain, algorithm/parameters, density ID and map ID. Row-page changes preserve map ID, layout ID, visible interval and all horizontal positions. These are disposable view/query artifacts, not another database.

## 03. Domain and Continuous Mapping

Use one finite analysis domain `O=[T0,Tn]`, normally the overview domain, with integer UTC-millisecond endpoints and `T0<Tn`. Record membership remains half-open. O does not change when detail rows are paged or when the visible detail window moves within it. An explicit fit/domain extension creates a new manifest; never extrapolate indefinitely outside authorized O.

For strictly ascending knots `T0...Tn` and `0=u0<...<un=1`, define, within segment i:

```text
m(t) = ui + (ui+1-ui) * (t-Ti)/(Ti+1-Ti)
m^-1(u) = Ti + (Ti+1-Ti) * (u-ui)/(ui+1-ui)
```

Shared knot values make the function continuous. Positive finite segment slopes make it strictly increasing and invertible. Validate every knot and denominator; reject NaN, infinities, duplicate times/positions, reversals and unsupported dates. Preserve adequate numeric precision and subtract a local time origin before interpolation. Never round knot positions to integer pixels.

For plot left `L`, positive CSS width `P`, and mapped viewport `0<=a<b<=1`:

```text
x(t) = L + P * (m(t)-a)/(b-a)
t(x) = m^-1(a + (x-L)*(b-a)/P)
visibleBounds = [m^-1(a), m^-1(b)]
```

Keep inverse results continuous during interaction. Canonical records still use integer milliseconds. The server may load a conservative integer `fetchWindow=[floor(left),ceil(right))`; this is distinct from exact visible bounds and must not inflate visible counts or include a right-edge point in the wrong scope. Typed integer date ranges set `a=m(from)`, `b=m(to)` exactly. Sub-millisecond view coordinates are not permission to persist fractional-millisecond dates.

## 04. Initial Density Algorithm

The initial algorithm is `density-log-v1`. Default requested bin count is 128; permit 16-256. For an interval shorter than that many milliseconds, use `N=min(requestedN, durationMs)`, at least one. Set `Ti=T0+floor(i*durationMs/N)`. This yields at most 256 positive-length segments, anchored to O rather than detail W. Integer boundaries may differ by one millisecond.

Compute from every record in the selected complete projection overlapping O, once per canonical ID, independently of server page order:

1. `Pi` counts points and zero-duration sessions whose instant is in `[Ti,Ti+1)`.
2. `Ai` sums each positive-duration session's overlap length with the bin divided by bin duration. It is average active occupancy, not just starts.
3. `Ei` counts true starts and finite ends of positive-duration sessions inside the bin. Do not invent endpoints where a session was clipped at O.
4. `di=Pi+Ai+0.5*Ei`.

Ongoing sessions occupy `[start,O.to)` for this calculation, not `[start,clockNow)`. A session spanning all of O contributes one unit of occupancy to every bin; identical simultaneous records retain multiplicity. Matched child activities are independent records. Context-only ancestors, repeated rendering copies, enclosures, annotation zones, labels and original-time graphics do not add record density. Density cannot establish permission to load hidden children.

Let `D=max(di)` and maximum slope ratio `R=8` by default, configurable from 1 to 8:

```text
wi = 1                                  when D=0
wi = 1 + (R-1)*log1p(di)/log1p(D)        otherwise
massi = wi * (Ti+1-Ti)
ui = sum(massj, j<i) / sum(all masses)
```

Set the endpoint exactly to one. Empty data and R=1 produce a uniform map. Positive base weights prevent collapsed quiet intervals; the steepest-to-shallowest slope ratio cannot exceed R. Do not impose an incompatible fixed pixel floor on every bin. Dense regions gain space, but simultaneous points can never be separated horizontally by any increasing time map. They require additional rows or an explicitly counted overview aggregate, not fabricated times.

Use bounded interval-sweep/index processing, deterministic reductions and validated manifests. Expensive full-range calculations may run as authorized bounded jobs; never silently sample one page while claiming exact density. Approximate density, if separately introduced later, must be explicitly identified and cannot supply exact counts.

## 05. Projection, Axes and Zones

Project every session's start and end separately. Width is `x(end)-x(start)`, never elapsed duration times a single global scale. Clip long and ongoing intervals at the visible edges with continuation treatment, preserving their true endpoints in details. Project parent boundaries, original-time overlays and annotation-zone endpoints through the same band mapping. A minimum invisible hit area must not falsify a bar's duration.

The compact light model has a main detail band above a smaller overview, with each horizontal axis at the bottom of its own band. Reserve those axis rows: data and zone labels cannot cover them. Generate real calendar ticks in the selected display zone, project their instants, then select a noncolliding labeled subset. Unequal tick spacing is expected under Adaptive. Always expose the active scale mode; do not imply that equal screen distances represent equal elapsed time. Keep a uniform-mode option.

Zones span the scoped band's data height, not its axis, gutter, toolbar or descriptor. The overview projects the same zone dates through its own linear scale. Use validated low-opacity fills, optional patterns and boundary lines; overlapping annotations have a deterministic z-order. Paint fills behind grid and record content, with readable record text above. Place zone labels in reserved noncolliding space. Color is not their only identity. They remain annotations excluded from record/page totals and record CRUD. Navigate dragging pans; zone mutation requires an explicit authorized model-edit command.

## 06. Overview and Nonuniform Navigation

The overview stays linear over O:

```text
xo(t) = Lo + Po * (t-T0)/(Tn-T0)
highlight = [xo(m^-1(a)), xo(m^-1(b))]
```

Never reuse detail x coordinates or a fixed detail/overview pixel ratio. The overview represents the complete overview projection, not the current vertical page. While contextual search is active, its marks/aggregates contain M only; the viewport highlight is navigation chrome, not a nonmatching record.

Freeze the current map geometry from pointer-down until completion/cancellation. For a rightward content drag of `dx` CSS pixels, set `a'=a-dx*(b-a)/P` and `b'=b-dx*(b-a)/P`. Clamp the pair to `[0,1]` while preserving mapped span. This moves the grabbed instant by dx until a domain boundary is reached; UTC duration may change through magnified regions.

For zoom factor `z>0` at fractional plot coordinate p, obtain `q=a+p*(b-a)`, choose validated span `h'=(b-a)/z`, then `a'=q-p*h'`, `b'=a'+h'`. Initially limit the resulting UTC window to at least 1 ms and at most O, with representably distinct mapped endpoints. Clamp explicitly at domain/zoom limits; test and disclose boundary-limited anchors. Overview recenter converts its pointer to a timestamp, then centers that timestamp in mapped coordinates, retaining mapped span. Typed date-range commands instead retain their requested UTC endpoints.

For an overview selected-range **body drag**, convert pointer x through the linear overview inverse. At pointer-down retain `h=b-a`, grabbed time `tg`, and `p=(m(tg)-a)/h`. At each new pointer time t:

```text
q = m(clamp(t,T0,Tn))
a' = clamp(q-p*h, 0, 1-h)
b' = a'+h
```

This retains the grabbed mapped fraction and mapped span, not a constant UTC duration or overview pixel width. Recompute both highlight edges through the inverse after every update; boundary clamping can limit the grab anchor.

For the **left resize handle**, keep b fixed and set `a'=m(clamp(t,T0,m^-1(b)-1ms))`. For the **right handle**, keep a fixed and set `b'=m(clamp(t,m^-1(a)+1ms,Tn))`. Validate representably distinct endpoints and the 1 ms minimum; handles cannot cross, exchange roles or flip time. Distinguish body, handles and background recenter targets even for narrow highlights.

Provide separately named, focusable body/handle controls and an exact range editor. Arrow keys apply the same equations with a signed time step, initially 10% of visible UTC span with a 1 ms minimum; Shift uses ten steps. Announce updated start/end and boundary limits. Escape/pointer cancellation follows the existing navigation policy; these controls never edit records.

Default Navigate, gesture thresholds, cancellation and Follow now rules remain unchanged. No pan, zoom, page, map or zone-navigation operation writes records. Do not apply the legacy fixed-duration scalar band-sync formula in Adaptive mode.

## 07. Stability and Refresh

Pin maps throughout a paginated browsing session. A vertical page response cannot update density, clocks, reference time, zoom or overview. Filter/domain/scale-parameter changes create a new coherent result. Resize preserves time endpoints but requires fresh width-dependent row layout.

For live mode, compute a deterministic candidate from each accepted new snapshot. Proposed initial hysteresis allows retention of previous knots only for identical domain, scope and algorithm parameters when the maximum normalized knot-position change is at most 0.002. Evaluate at common time knots; do not compare unrelated array indexes. Limit retention to 30 seconds and scale replacements to at most once per two seconds, after 500 ms without navigation/edit input. Explicit Recompute bypasses these delays. Continuous interaction may defer replacement until release without delaying permission enforcement.

Retained geometry needs a fresh map ID and manifest binding current snapshot/density, `baseMapId`, `retainedGeometryFrom`, geometry/candidate hashes, decision and retention deadline. Never reuse an old snapshot-bound map ID with new rows. It is explicitly retained geometry, not a claim that old density is current. New rows, totals and overview still share the new snapshot.

The delays govern geometry replacement, not live record/count delivery. During an active gesture, an explicit `interactionHold` may retain identical knots even above the normal hysteresis threshold; the gesture freezes geometry, not the manifest identity. Fresh records can use those knots with fresh provenance within the adaptive-query performance budget. Global layout preparation still has a cost; retained knots are not proof of one-second full refresh. Continuous input therefore delays redistribution rather than imposing an additional data-delivery block. Permission or scope changes cancel affected gestures and invalidate old geometry immediately; rebuild authorized output or show an unavailable state.

Map replacement and Uniform/Adaptive switching preserve the visible UTC endpoints, selection and record dates. Recompute a/b through the replacement map; screen positions may redistribute. It is generally impossible also to preserve every interior pointer/reference position. Exact gesture anchoring is guaranteed against the frozen map, not across unrelated maps. Never animate readable labels through other content.

## 08. Cameras and Collision Safety

Use common screen-space time projection and full projected label/mark bounds. A compatible perspective camera must preserve a shared time-to-screen-x mapping across rows, for example through screen-space time geometry. Otherwise disable Adaptive for that camera with a clear compatible-mode choice; do not make row-dependent inverse mappings. The original Uniform camera contracts and exact Classic fixture remain available.

Allocate the complete filtered layout after mapping, including text, icons, same-record label clearance and parent blocks. Page that fixed global layout vertically; never pack each page independently. Magnification is not an alternative to full-footprint collision detection. Text lengths, dense simultaneous intervals and narrow screens can still require more rows.

## 09. Worked Mapping Fixture: AS-MAP-01

Use four bins only in this small arithmetic fixture. O is 00:00-04:00 UTC on one date, densities are `[0,3,3,0]`, and R=4. Weights are `[1,4,4,1]`; hourly knots are `[0,0.1,0.5,0.9,1]`. A 1,000 px full-domain plot beginning at zero maps 00:30 to 50, 01:30 to 300, 02:30 to 700 and 03:30 to 950.

A session 00:30-02:30 spans `[50,700]`. A zone 01:15-02:15 spans `[200,600]`. These widths are not linear-duration estimates.

Start a 1,000 px detail viewport at `[a,b]=[0.1,0.5]`, representing 01:00-02:00. A 100 px rightward content drag yields `[0.06,0.46]`, representing 00:36-01:54; 01:30 moves from x=500 to x=600. A 1,000 px linear overview highlight changes from `[250,500]` to `[150,475]`. Separately, a 2x center zoom from the original viewport gives `[0.2,0.4]`, or 01:15-01:45.

## 10. Illustrative UI Fixture: AS-UI-01

This separately hand-specified accepted map is a design illustration, not claimed automatic-algorithm output. O is 00:00-24:00; slope multiplier is four from 12:00-13:00 and one elsewhere. Knots are `(00:00,0)`, `(12:00,12/27)`, `(13:00,16/27)`, `(24:00,1)`.

W is 08:00-17:00, giving `[a,b]=[8/27,20/27]`. Relative detail positions are 12:00 at 1/3, 13:00 at 2/3 and reference 12:30 at 1/2. Orange zone 12:10-12:45 spans `[7/18,7/12]`; cyan zone 12:30-13:20 spans `[1/2,25/36]`. The linear overview highlight is `[8/24,17/24]`. Page one and page two must share all of these horizontal values.

## 11. Mathematical Acceptance Checklist

- Prove endpoints, continuity, positive slopes, ratio bound and order preservation for empty, sparse, simultaneous, long, ongoing and randomized records; shuffle input/page order without changing the manifest result.
- Check integer-millisecond `inverse(forward(t))` within 1 ms, and unrounded `forward(inverse(x))` within 0.25 CSS px. Use full precision for the latter, including millisecond zoom and supported extreme dates.
- Verify both named fixtures independently, including session/zone endpoints, overview highlight and pan/zoom values. Rendered positions must agree within 1 CSS px, apart from separately declared camera/antialiasing tolerances.
- Exercise overview body drag across knots and both resize handles; assert fixed mapped body span or fixed opposite endpoint, valid minimum span, no reversal, keyboard equivalence and zero CRUD. Do not substitute background-click recenter tests.
- Traverse vertical pages and assert unchanged map/layout IDs, a/b, O, exact visible bounds, overview, reference time and horizontal coordinates; counts are never loaded-page counts.
- Test all true endpoints at bin/O boundaries, zero-length sessions, empty and one-millisecond domains, DST transitions, label overflow, zone intersections and offscreen-spanning intervals.
- Test Uniform disable/restore, explicit range, domain extension, cancellation, camera changes, hysteresis expiry, live refresh and immediate permission invalidation. No case may change canonical records or conceal a collision.

These checks are mandatory future verification. This document does not report them as executed application tests.
