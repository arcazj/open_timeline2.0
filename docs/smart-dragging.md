# Smart Dragging

Navigation behavior, cache boundaries and reproducible verification. An unavailable network or an arbitrarily fast gesture cannot guarantee that every future record is already loaded; incomplete intervals remain explicit instead of appearing empty.

## Stable Geometry During Motion

Dragging translates the current timeline rather than repeatedly repacking its visible records. Existing event markers, duration bars, labels, group headers and enclosure geometry remain fixed relative to one another. The time axis, zones and overview must follow the same temporal movement. Releasing the pointer may continue with bounded inertial motion; a click stops that movement. Reduced-motion preferences disable inertial/elastic effects.

Adjacent preview pages are disposable rendering data. They are not replacement query results, canonical vertical pages, or a new basis for density-aware scaling. Final settling adopts or requests a canonical layout for the final interval. A different canonical layout can assign different rows after motion ends; the preview must not silently claim otherwise.

The selected vertical page is retained when it exists in the new interval. If it does not, the application selects the last available page and reports that change. Automatic density scaling is deferred until settling. Long and ongoing sessions retain their true endpoints; canvas geometry and hit targets are clipped relative to the moving camera to avoid numerical overflow.

A new drag can supersede an unfinished range query while retaining the painted viewport. Outdated results cannot replace the latest navigation intent. A selected descriptor remains mounted during range-only navigation when its provider, generation, data revision, preference revision and query scope are unchanged. Filter, source and authorization changes still require a fresh scoped selection check. A retained offscreen selection is explicitly excluded from shared-view links.

Prepared labels outside the viewport stay out of the keyboard tab order until they enter view. Preview clipping prevents focus from scrolling the HTML layer independently of the canvas and time axis. Updating preview geometry retains the existing focused label node.

## Two Independent Buffers

### Server Record Warming

The [window loader](../client/src/data/window-loading.js) predicts a bounded interval from the visible span, travel direction, velocity and observed response latency. It coalesces overlapping requests, limits concurrent work, expires cached coverage, cancels obsolete intent and retains a bounded retry policy. The Python reader continues to use allowlisted JSON source paths and date partitions.

Successful prefetch means that the server has warmed relevant record files. It does **not** mean that all archive partitions were verified, every overlapping session was discovered, or browser rows are render-ready. Its status explicitly identifies the `server-record-cache` layer and `renderReady: false`. Filters and data-source context participate in its cache scope.

### Render-Ready Pages

The [navigation buffer](../client/src/timeline/navigation-buffer.js) predicts adjacent viewport tiles. It prioritizes exposed space, then the travel direction, with one to three lookahead tiles selected using speed and recent preparation latency. Defaults are six retained tile entries, an estimated 16 MiB serialized-data budget, one active preparation, an eight-second timeout and a two-second error retry delay.

Higher-priority pages are retained ahead of speculative distant pages. A tile that cannot fit the budget gets an explicit retryable error instead of triggering an eviction/refetch loop. The byte estimate is twice the JSON string length; it is a cache-admission approximation, not a JavaScript heap or process-RSS measurement.

Prepared pages are detached from temporary server query/layout handles; the caller is responsible for releasing those handles after preparation. The buffer rejects stale publication after context changes, cancellation or disposal. An abort-ignoring operation keeps its single admission slot until it settles; a timeout still becomes visible as an error and a late response cannot become ready.

An explicit authorization denial from current-context background preparation clears protected records and descriptors immediately. A changed server generation requires an explicit reload. Late errors from a superseded source cannot clear or replace the new source's view.

Offline allocation cancellation waits for the worker's allocation and cleanup acknowledgements before another query or layout can consume its slot. Ordinary reads remain independently cancellable. Broader-overview preparation temporarily suspends speculative allocation without discarding already prepared rows.

Within each browser instance, foreground timeline, table, CSV, filter preview, model preview and shared-view preparation share a bounded FIFO queue ahead of speculative work. Canceling a queued read removes only that waiter; active work retains its slot until completion. Canceled server allocations are drained through their release acknowledgement before competing foreground work begins. Server release acknowledgements wait for worker/accounting cleanup; a bounded timeout reports pending cleanup instead of falsely confirming success. Neighbor query boundaries round outward to integer milliseconds; the precise fractional viewport and its time mapping remain unchanged.

Other tabs can still consume the same principal's server preparation capacity. Table reads retry only an explicit pre-admission `429 preparation_capacity` response, with bounded, cancellable backoff and the original query, request and credentials. Transport failures, other errors and mutation requests are not retried by this policy. Canceling an in-flight table request still waits for its server completion before this browser starts competing preparation work.

## Interrupted Server Requests

An interrupted allocation may leave an unknown server handle. The provider blocks new preparation rather than assuming that the abandoned work was released. Retry stages a fresh connection to the already confirmed endpoint with a bounded metadata check; it does not switch to a sample dataset, replay writes, or purge queries belonging to another tab.

For an unchanged workspace, authorization scope and generation, reconnect preserves the active time range, scale settings, filters, grouping, model configuration and table preferences. It releases only known old handles, clears runtime selection/query handles, and requests fresh data. Pending cleanup is awaited separately from terminal unknown cleanup, which remains recorded on the retired provider. Failed or superseded staging leaves the current real data in place. Changed authorization clears protected content; changed server generations require the existing explicit source-reload flow. Unsaved work and unresolved write recovery block reconnect until resolved.

Automatic viewport resizing waits until reconnect finishes, then measures the current viewport once. An error notice or window resize cannot silently cancel Retry; newer user navigation, filters, imports and source choices still take precedence.

## Preview Coverage

Coverage distinguishes the frozen base tile, not-loaded space, active loading, ready detached pages and explicit errors. A loading tile belongs to its actual query context, never a previous source or filter selection. No-record results and not-yet-loaded intervals are different states.

The [preview row merger](../client/src/timeline/navigation-preview-rows.js) keeps all base render objects and canonical pagination fields unchanged. New records may occupy compatible free slots only after checking the full, unclipped bar, text, icon and baseline footprints, including graphics extending into an adjacent row. Records already present in the preview are not added twice. Uncertainty metadata remains supported.

Grouping uses existing typed group identities and visible group headers. It does not invent missing namespace groups or reuse collapsed/header rows. Flat additions can occupy unused visible capacity; canonical `totalRows`, `endRow`, cursors and page counts still describe the original page, and `previewOnly` identifies the temporary geometry.

Existing nested families and enclosures remain untouched. New hierarchical members that need a different family layout are omitted from the temporary preview; unrelated flat records may still use genuinely free rows. Missing group continuation context, changed row heights, snapshot mismatches, collisions and cache limits all produce explicit omission reasons. A fully prepared neighboring vertical page is not proof of complete row coverage when other pages remain.

The returned coverage includes `added`, `duplicates`, `omitted`, `partial`, `reasons` and `omittedByReason`. Neither successful file warming nor a partially merged row page may be presented as complete archive coverage.

## Rolling Overview

The overview uses full filtered overview responses, never just the records on the selected vertical page. Only matching provider, generation, data revision, preference revision, filters, search and source scope can be combined. Up to six staged windows supplement the base window, with caps of 4,096 primitives and 256 zones.

Overlapping time slices have one owner; record and zone identities are deduplicated. Bounds are projected through the overview's own time mapping. Missing intervals remain partial, clipped aggregate bins remain estimates, and overlapping counts are never summed into a false distinct total. An overview configured for different sources stays partial until a matching scoped response is available.

## Executed Core Tests

```sh
npm test
npm run test:parity
npx playwright test tests/e2e/smart-drag.spec.mjs tests/e2e/calendar-momentum.spec.mjs
npm run test:matrix
```

Focused tests cover direction/latency prediction, single-flight preparation, cache reuse and bounds, source/query resets, late responses, timeout/error states, stop/cancel motion, frozen geometry, measured multiline labels, icons, baselines, namespaces, pagination and conservative hierarchy handling. The actual presentation layout engine supplies the measured-geometry fixture; tests do not substitute arbitrary label dimensions for that case.

## Browser Qualification

Rebuild the exact candidate before browser tests. [Smart-drag tests](../tests/e2e/smart-drag.spec.mjs) cover prepared records entering the viewport, row stability, delayed server requests, reversal, vertical pages, desktop/mobile screenshots and actual marker pixels. [Calendar and momentum tests](../tests/e2e/calendar-momentum.spec.mjs) cover coasting, click-stop and the rolling overview. Existing layout, descriptor, source-race and offline suites cover the adjoining behavior.

1. Record base item IDs, rows and label coordinates before dragging; verify that movement only translates their horizontal positions until canonical settling.
2. Drag repeatedly toward both past and future, reverse direction, coast and click to stop. Verify that the overview stays synchronized and date labels continue beyond the initial interval.
3. Throttle detail/preparation responses separately from file-prefetch responses. Unknown or loading areas must not masquerade as empty data; warmed files alone must not become ready preview rows.
4. Change filters, model, source, page or viewport size during delayed work. Old geometry and descriptors must not reappear, and canceled allocations must not leak retained handles.
5. Exercise byte/entry limits, failed requests, offline mode and reduced motion. Verify bounded requests, readable labels, explicit partial coverage and recovery without an infinite retry loop.
6. Check desktop and mobile screenshots plus canvas pixels for nonblank rendering, aligned grids/zones and unobstructed controls.

## Performance Qualification

Use a fixed fixture hash, exact commit and bundle hash, pinned browser versions, known viewport/device-pixel ratio and a documented network profile. Separate cold startup, warm navigation, row preparation, frame time and settle latency. Record enough repeated runs for meaningful distributions; report sample counts, warmup treatment, medians, p95, memory estimates/RSS and failures separately.

`window.__timelineDebug.navigationBuffer` exposes bounded cache/request counters, tile status, estimated preparation latency and recent frame samples. The byte count is estimated serialized cache size, not heap usage. The frame p95 covers recent navigation callbacks, not a controlled benchmark. These diagnostics are not substitutes for end-to-end usability measurements; manual accessibility and production performance gates require their own recorded checks.
