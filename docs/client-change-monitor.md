# Client Committed Updates

The server-connected application opens in **Pinned** mode. Its compact update
strip has stable dimensions whether a notice is present or absent. Receiving a
committed revision does not replace the query, page, map, range, zones, overview,
selection or active filters. **Reload** explicitly prepares and adopts the next
coherent result. Pagination remains on the pinned query until that reload.

**Live** is an explicit, session-local choice. The controller coalesces notices
for 250 milliseconds and permits only one refresh promise at a time. It defers
refresh while a pointer gesture, precise time commit, record recovery lock,
dialog, model/configuration editor, table request, CSV export or timeline query is active.
After a successful read, the acknowledged revision comes from the query manifest,
not from an earlier metadata request. Notices arriving during the read are
retained and can schedule a subsequent refresh. Live reads retain the current
time range and filter/search expression; they never upload or replay a write.

The browser uses the authenticated provider's sequential change polling. The
renderer has no dependency on the feed and standalone mode does not poll.
An empty feed page that advances the committed high-water mark also marks the
view stale: source reassignment can remove a previously readable record without
exposing that mutation's record IDs to its former reader.

## Failure Boundaries

- Authorization loss or permission-scope changes immediately clear protected
  timeline, overview, descriptor and table data. They do not activate Local data.
- A workspace-generation change or replay gap stops Live refresh, cancels
  provisional gestures and requires explicit Reload. Existing drafts are not
  automatically rewritten for the new generation.
- Source replacement unsubscribes and cancels the old monitor. A delayed event
  or refresh completion from that source cannot update the replacement.
- An unavailable server invokes the existing complete Local snapshot fallback.
  Source labeling and provenance remain visible; no write is queued for replay.
- A failed refresh does not enter an automatic retry loop. The update strip
  remains marked as requiring an explicit refresh.

## Verification

`tests/client/change-monitor.test.mjs` exercises Pinned acknowledgement, empty
high-water advances, Live coalescing and single-flight behavior, deferred work,
source replacement, authorization/generation failures and failed-read handling.

`tests/e2e/change-monitor.spec.mjs` uses real Python APIs and two isolated browser
contexts for concurrent commits. It checks immutable pinned geometry and query
identities, coherent Live refresh after an open draft, zero-write gesture
cancellation, preservation of filters/range, and immediate protected-data
clearing after a real source-grant change. A controlled replay-gap response tests
the explicit refresh boundary. Desktop and narrow-screen screenshots are taken
after transient toasts disappear.

The server feed protocol and bounded connection rules are documented in
[Change Feed Contract](change-feed-contract.md). These tests cover this update
workflow; they do not certify the complete release matrix.
