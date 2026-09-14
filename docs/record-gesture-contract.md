# Record Gesture Package

This bounded implementation package follows sections 07-08 of `legacy-interaction-audit.md` and the versioned transport in `record-command-contract.md`. It is not a full-release completion statement. Navigation remains the default; legacy dragging never implied canonical record editing.

## Modes and Eligibility

The visible, accessible Navigate/Edit segmented control defaults to Navigate on startup and source replacement. Navigate preserves band, record-body, label/icon and zone panning without record writes. Stationary record activation selects and inspects. Edit still permits background navigation, but eligible record bodies/labels/icons move that record and finite-session handles resize one endpoint. Points remain points; ongoing sessions close only through an explicit time command.

Before exposing Edit affordances, check the current actor's `records.edit` or `*` capability, authorized source membership, active source lifecycle and its published `enabled`/`writable` definition. The provider remains authoritative at commit. Viewers can navigate and inspect without editing authority. Authorization/source/generation changes cancel an uncommitted gesture and remove its controls.

## One Gesture, One Intent

Capture provider identity, generation, query/map identity, record ID/version, original timestamps, layout width, pointer ID and initial CSS coordinates. The frozen scale's inverse determines pointer instants. For movement, compute `deltaMs = round(pointerTimeNow - pointerTimeAtGrab)` and add that same integer UTC delta to both finite endpoints. This preserves duration even in a nonlinear time map; changing the pixel width of a bar is not the movement algorithm. An event updates start only. An ongoing session updates start while retaining null end.

Finite-session resize changes exactly one endpoint, uses millisecond precision, and never flips the interval or changes record kind. The other endpoint stays fixed. No extrapolation beyond the supported timestamp domain occurs. Long/clipped records retain their real canonical endpoints; a clipped edge is not a fabricated resize endpoint. Very short sessions whose handles cannot be separated use the precise time controls rather than overlapping hit targets.

Movement becomes a drag only after maximum Euclidean displacement reaches 4 CSS pixels for mouse/pen or 8 pixels for touch. Crossing the threshold and returning to the origin cannot become a click. A below-threshold release or zero-date-change drag sends no write. Pointer cancel, lost capture, Escape, focus loss, layout replacement, mode change and controller disposal clear the preview and send no write. Right-button input cannot rotate meshes or edit records.

The preview is visibly provisional, with original/proposed times and an explicit dirty state. It never changes the provider's canonical snapshot. Main and overview remain on the pinned navigation window/map throughout a record edit; no navigation CRUD occurs. A valid completed edit dispatches one command through `recordRecovery.execute`, with the captured generation, expected version and one UUID. There is no second write path in the renderer or controller.

## Conflict and Recovery

An optimistic-concurrency or permission rejection retains the proposed times in a source-bound draft and shows the problem. It never refreshes a version and silently resubmits. A transport-unknown outcome uses the existing reload-safe record identity and original GET outcome flow; no automatic retry, duplicate command or upload is permitted. A confirmed command on an old source must not replace the newly active source or selection.

Precise keyboard-accessible time controls perform movement, start/end resize and explicit ongoing closure through the identical command/recovery path. Mode controls and touch actions have usable hit targets, stable focus and named controls. Numeric offsets use explicit units; calendar-style unit snapping is not implicitly substituted for UTC elapsed-time movement.

## Parent and Activity Semantics

This package edits one canonical record only. Moving a parent does not shift children. Resizing a parent does not clamp children. A point/session outside its parent's time extent receives an inspectable warning, not hidden coercion. The independent atomic batch/subtree command must enumerate affected IDs and versions; its later UI is not simulated by a sequence of individual writes.

## Verification and Remaining Work

Browser tests must exercise Navigate zero-writes across mark/label/background/zone targets; exact/below thresholds; move and both finite edges in Uniform/Adaptive; duration preservation; no-op/cancel/focus/source changes; keyboard precision; ongoing closure; rejected stale/unauthorized commands; original-key recovery; touch/DPR2 framing; parent warnings without child writes. A mutation request count and canonical versions are the oracles, not only screenshot motion.

Canonical group collapse, arbitrary additional bands and scene instances, perspective cameras, follow-now/inertia, batch/subtree UI, conditional undo and complete multi-band listener acceptance remain mandatory open release work unless separately implemented and verified. Completing this package cannot be reported as satisfying those features.
