# OpenBEXI Timeline: Listener and Interaction Audit

Documentation supplement to `OpenBEXI_Timeline_Rebuild_Prompt.md`.

Audit date: 12 September 2026. Repository: https://github.com/arcazj/openbexi_timeline. Pinned commit: `cf5d263853e550aab44d3d1959637c1e324b719e`.

## 01. Scope and Evidence Limits

The complete `OB_TIMELINE.prototype.ob_setListeners` function was inspected, together with directly relevant object constructors, coordinate conversion, band synchronization, rendering, descriptor, clock, loading, and disposal helpers. Its source begins at [line 4232][J4232] and ends at line 4520. Findings below distinguish source-derived behavior, consequences inferred from that code, and proposed rebuild requirements.

The legacy application was not built or run for this audit. No browser gesture, rendering result, frame rate, network request, dependency installation, or memory behavior is claimed as runtime-verified. Runtime compatibility checks belong to the later implementation phase. This file is documentation only and does not authorize application development.

The central finding is that this listener is a navigation and inspection controller. Its drag paths change mesh/band coordinates and the displayed time window. They do not mutate canonical record start/end values, resize durations, or commit event/session CRUD. Persistent record movement and resizing in the rebuild are additional workflows requiring explicit editing semantics.

## 02. Registration, Picking, and Target Classification

[Registration][J4232] creates a tracked Three.js `DragControls` object using the selected scene's interaction roots, camera, and renderer canvas. It registers three application callbacks: `dragstart`, `drag`, and `dragend`. The function does not register separate click, double-click, wheel, keyboard, or hover callbacks.

The roots include [bands][J2798], [shaded zones][J2565], and [grouping labels][J2628]. [Duration meshes][J3948] and [point/icon meshes][J4035] are children of bands. [Text sprites][J4138] are children of the objects they label. A multi-activity enclosure is a named mesh with a string `sortBy` flag set to `"true"` in [its property helper][J3870].

The declared dependency baseline is Three.js `^0.168.0`; there is no tracked dependency lockfile establishing the installed artifact. The [first-party r168 DragControls source][THREE168] recursively raycasts descendants, transforms pointer coordinates using the canvas rectangle and camera, and emits drag callbacks. Its defaults include left/middle-button pan, right-button rotation, one-touch pan, and drag completion on pointer up or pointer leave. It does not provide an application click/drag threshold. These are dependency-baseline observations, not evidence of the version actually loaded by a running legacy application. The rebuild must verify the selected library's concrete event contract.

Application dispatch depends on mesh names and string flags, in this order:

| Classification | Identification in the legacy callback | Meaning |
| --- | --- | --- |
| Locked visual | `sortBy` is the string `"true"` | Group label or multi-activity enclosure; position is restored and the callback returns. |
| Zone | Mesh name matches `zone_` | Shaded region attached to a band. |
| Band | Mesh name matches `_band_` | Band background; the supplied overview name also contains this substring. |
| Record mesh | Mesh name is empty | Duration bar, point, or icon; the callback uses its parent band. |
| Other | None of the preceding checks | Includes separately picked sprites and unsupported mesh shapes; position is restored. |

The rebuild should classify targets with explicit metadata such as view ID, band ID, record ID, annotation ID, and interaction role. Names, display titles, and grouping values must not determine behavior.

## 03. Complete Trigger and State Matrix

The following table describes the application callbacks as written. A stated visible outcome is the source's intended rendering effect, not a reproduced browser result; section 06 records branches whose implementation undermines that intention.

| Trigger and target | Target/state changes | Rendering, navigation, and follow-on behavior | Evidence |
| --- | --- | --- | --- |
| Register listeners | Creates one tracked control for the selected scene and stores it in `scene.dragControls`. | Camera and canvas are those supplied by that scene. | [Registration][J4232] |
| Any dragstart | Clears the timeline instance's clock and selected scene's movement interval before resolving the object. Stores the object's current X as its start coordinate. | An unknown target returns after timers have already been stopped. | [Start preamble][J4248] |
| Locked visual: dragstart | Restores stored XYZ and immediately returns. | No explicit render, band synchronization, or record inspection in this branch. | [Locked start][J4257] |
| Zone: dragstart | Stores the parent band's starting X and moves that band to its current position with synchronization enabled. | Updates the shared center marker through band synchronization, then renders. | [Zone start][J4260] |
| Band: dragstart | Restores stored Y/Z while retaining current X; synchronization is disabled for this initial call. | Makes marker and marker text visible, then renders. | [Band start][J4264] |
| Unnamed record: dragstart | Stores the parent band's starting X. | Renders; does not open the inspector or change dates. | [Record start][J4268] |
| Other target: dragstart | Restores stored XYZ. | Reaches the common render call. | [Fallback start][J4271] |
| Locked visual: drag | Restores stored XYZ and returns. | No intended navigation or edit. | [Locked drag][J4457] |
| Zone: drag | Computes the incremental child-local X delta, restores zone placement, and adds that displacement to the parent band. | Synchronizes bands, displays the marker, and renders. The zone interval is unchanged. | [Zone movement][J4476] |
| Band: drag | Applies current X with stored Y/Z to the selected band. | Synchronizes other bands in the scene, displays the marker, and renders. | [Band movement][J4493] |
| Unnamed record: drag | Computes an incremental local X delta, restores the record mesh, and transfers the displacement to its parent band. | Synchronizes the scene and renders. This is panning across the record, not rescheduling it. | [Record movement][J4506] |
| Other target: drag | Restores stored XYZ. | Reaches the common render call. | [Drag dispatch][J4457] |
| Locked visual: dragend | Restores stored XYZ and immediately returns. | Skips the descriptor, common render, date/calendar update, and motion setup. | [Locked release][J4278] |
| Zone: dragend | Synchronizes the parent band's current position. | Continues through the common release and motion paths. | [Zone release][J4285] |
| Overview band: dragend | Synchronizes that band's current position and exposes markers. | Continues through common release. This branch precedes the generic band branch. | [Overview-band release][J4287] |
| Other band: dragend | Synchronizes that band's current position and exposes markers. | Continues through common release. | [Band release][J4291] |
| Unnamed record in overview: dragend | Calls parent-band movement with negative child-local X, rather than the parent's final drag displacement. | Exposes markers and immediately returns. Skips inspector, explicit common render, date/calendar capture, and post-release motion setup. | [Overview-record release][J4295] |
| Unnamed record in detail: dragend | Synchronizes the parent band's current position. | Opens its descriptor even if the pointer moved; then continues through common release. No selection-versus-pan threshold is checked. | [Detail-record release][J4300] |
| Other target: dragend | Restores stored XYZ. | Still reaches common release and motion setup, despite not representing a supported pan target. | [Fallback release][J4303] |
| Common release | Renders, records marker time in scene date/calendar fields, and enables calendar display. Computes a displacement-based movement increment on the parent for zones/records or on the target for other objects. | A redraw can recreate the calendar from this state. The date string is built from a formatted Date value with a literal UTC suffix. | [Common release][J4307] |
| Post-release movement | Schedules 5 ms interval callbacks. Zones/unnamed records ultimately use `ob_move`; other targets use `ob_move2`. | Moves a band and calls scene update, which may reload the time window. The final selection overrides an earlier HTTP/local decision. | [Motion calculation][J4313], [final timer choice][J4448] |

[Descriptor opening][J1155] closes competing side panels, creates record details, and may request a descriptor by legacy identity/start/source when its description is empty. It does not establish a durable selection model or a record-editing workflow. The rebuild must preserve useful record inspection while applying the new selection, query-snapshot, and permission contracts.

## 04. Band Synchronization and Coordinate Meaning

Let `T0` be the timeline instance's synchronized time reference, `xA` the dragged band translation, and `sA` its milliseconds per model-coordinate unit:

`sA = gregorianUnitLengthsA / intervalPixelsA`

[Pixel-to-date conversion][J1969] uses `T0 + pixels * scale`. [Band synchronization][J3064] applies a negative translation for the center marker:

`centerTime = T0 - xA * sA`

An equivalent time displacement in another band B requires:

`xB = xA * sA / sB`

The legacy implementation obtains this through a date-to-offset conversion and the source/target scale ratio. It moves the other scene meshes and updates the marker/calendar. Moving content right therefore moves the center time earlier; moving content left moves it later.

The supplied [regular visual model][MODEL] uses 1,000 coordinate units per hour in its detail band and 1,000 per day in its overview. The scales are 3,600 and 86,400 milliseconds per unit. Moving the overview right by 10 units implies:

- Center time changes by -864,000 ms, or 14 minutes 24 seconds.
- Detail-band translation changes by +240 units.
- Both bands must indicate the same center instant.

These are model-coordinate units. The field name `intervalPixels` does not guarantee a one-to-one CSS-pixel mapping in perspective projection, under camera changes, or across device pixel ratios. The rebuild must convert screen input through its actual camera/layout transform before applying time movement, and use CSS pixels only for gesture thresholds.

Synchronization is restricted to the selected scene's band list. Only the matching band's model X is directly assigned; other bands' mesh translations are updated. The helper also writes a previous target-band X into the dragged band's `position.x_with_no_scale`, overwriting it as other bands are visited. [Scene update][J2908] reads that auxiliary value for overview movement. It is not a reliable canonical center-time representation for arbitrary numbers of bands.

The rebuild should make the visible center/range authoritative for navigation, derive each band's display from it, and retain record instants independently. Calendar ticks must follow real date/time rules, not the legacy fixed-month/year approximations. Verify synchronization with one band, detail plus overview, and at least three differently scaled bands.

## 05. Clock, Reload, Lifecycle, and View Isolation

The normal source redraw chain is [update all timelines][J2975], scene destruction/resource disposal, geometry reconstruction, clock setup, camera setup, and [listener registration from camera setup][J4575]. [ResourceTracker][J0039] calls `dispose` on tracked disposable objects. The control is tracked, so normal teardown is intended to dispose it. Directly calling `ob_setListeners` again has no guard that disposes or replaces an existing active controller first.

[Scene destruction][J2811] clears scene roots and the shared body container and disposes tracked resources. It does not itself explicitly cancel the motion interval, instance clock, pending load, or deferred scene update. Timer callbacks close over scene/mesh objects. Require a tested lifecycle that prevents stale callbacks after teardown or replacement; do not infer leak-free behavior from the tracker alone.

[Clock setup][J0986] runs only for current-time configurations when the marker is within 10,000 milliseconds of current time. It refreshes the marker each second and centers bands every tenth tick. The adjacent comment describes a different unit, but the condition compares milliseconds. Dragstart always stops this clock; dragend does not unconditionally restart it. Later redraws can call clock setup again. The rebuild must represent follow-now explicitly: navigation pauses it, and an intentional command resumes it. Unrecognized or locked visual targets must not silently change follow-now state merely because they were hit.

For a non-null band, [scene update][J2908] tests a positional condition, stops motion, resets the synchronized time to the marker, recomputes bounds, and invokes loading. The later `load_data` argument controls a different branch, so passing a false/null value does not prevent this band-path reload. Network response paths subsequently rebuild the display. The new controller must use explicit buffered-range exhaustion, bounded/coalesced queries, cancellation or stale-response rejection, and the shared snapshot rules from the main specification.

The legacy defines a maximum of three scenes and [allocates them together][J4522], but the normal entry point [initializes scene 0][J4987]. Controls and motion intervals are scene-specific. The time reference `ob_scene.sync_time`, marker/calendar objects, and clock are shared within a timeline instance. Original/current band arrays are shallow copies, so their nested model objects can be shared across scenes. Reinitializing scenes also visits all scene slots. This is not evidence of independently functioning multi-scene views.

The rebuild must isolate controllers, gestures, animation handles, drafts, and request generations by timeline/view identity. Synchronization between views must be explicit. Two independent timelines must not change each other's scales, marker, timer, camera, selection, or data scope. Shared Timeline/Table/Split modes still follow the main specification's common data, selection, and snapshot rules; they do not require copying the legacy three-scene allocation strategy.

## 06. Defects and Deliberate Corrections

The following are source-derived defects or interaction limitations. Their precise browser symptoms remain future runtime checks.

| Finding | Evidence and consequence | Rebuild treatment |
| --- | --- | --- |
| Point/icon reset fields are missing | [Duration construction][J3948] assigns stored XYZ; [point construction][J4035] does not. [Record movement][J4506] restores those fields for both. Undefined mesh coordinates are possible. | All targets carry validated interaction coordinates, or navigation never mutates the record mesh. Assert finite positions for points, bars, icons, and labels. |
| Overview record release mixes coordinate spaces | [Release][J4295] negates child-local X to position the parent and returns early. | Resolve navigation through the same center-time transform for all targets. Overview interaction must not introduce an unrelated jump. |
| Parent inertia checks child speed | [Speed assignment][J4313] stores speed on the parent, while [the parent movement branch][J4332] tests the child's speed and compares child/parent positions. | Maintain one gesture state with an explicit owning band, displacement, velocity, and clock. Never mix target and owner fields. |
| Timer selection is overwritten | [URL-based setup][J4323] is replaced synchronously by [target-based setup][J4448]. | One animation scheduler owns the final gesture outcome. Data transport must not select the physics algorithm. |
| Reload test is not a valid buffer boundary | [Condition at line 2926][J2926] uses an OR. With default stored X of zero and positive width, either X is greater than negative width or less than width, so the condition is always true. | Test actual loaded time coverage against visible range plus buffer. Do not reproduce repeated reloads as compatibility behavior. |
| Inertia is tied to timer ticks and total displacement | [Release and movement][J4313] divide displacement by 60, schedule 5 ms callbacks, and change speed by fixed increments. | If inertia is enabled, use measured elapsed time, bounded duration/speed, deterministic stopping, and reduced-motion support. Do not claim measured legacy smoothness. |
| Pan release also opens detail inspector | [Detail release][J4300] has no movement threshold. Overview release behaves differently. | Distinguish activation, navigation, and editing using the explicit gesture policy in section 07. |
| Unrecognized hits enter release side effects | [Fallback release][J4303] continues into date/motion logic. Separately picked adornments can take this route. | Resolve adornments to a stable owner or make them intentionally noninteractive. An ignored hit must not create invalid movement or unexpected UI changes. |
| Cleanup relies on surrounding call order | [Registration][J4232] does not guard repeated installation; [destruction][J2811] does not explicitly cancel all asynchronous activity. | Enforce one active controller per canvas and complete, idempotent cleanup. Test replacement during gestures and loads. |
| UTC label is assembled from presentation text | [Common release][J4307] truncates a Date string and appends UTC. | Keep the center as an instant plus an explicit display zone; format only at the presentation boundary. |

The dependency's default right-button behavior must be explicitly configured and tested. Resetting position in the OpenBEXI callback is not a demonstrated safeguard against rotation performed by the underlying control. The rebuild must not accidentally expose mesh rotation as a navigation or editing action.

## 07. Proposed Rebuild Gesture Contract

These are deliberate design defaults, not claims that the legacy implements them. They supplement the main specification's editing, accessibility, synchronization, and persistence requirements.

1. **Default Navigate mode.** Dragging a band background, record body, record icon/label, or shaded region pans the intended timeline. It changes navigation state only. No event/session create, update, delete, restore, version increment, or canonical JSON change may occur from a navigation gesture. A stationary detail-record activation selects the record and opens its inspector. An overview-record activation selects it and recenters linked detail bands on its start without forcing the inspector open; this is explicit navigation, even though triggered by a click/tap.
2. **Explicit Edit mode.** Authorized users intentionally enter Edit mode to move record bodies or use session resize handles. Background drag still pans. Points can move but cannot implicitly become sessions. Ongoing sessions close through an explicit action. Parent/child movement follows the main specification, including the separate command for shifting a subtree. Mutation previews and final writes use the common API command path.
3. **Activation thresholds.** Proposed initial thresholds are 4 CSS pixels for mouse/pen and 8 CSS pixels for touch, measured as maximum Euclidean displacement from pointer-down. Displacement greater than or equal to the threshold commits the gesture to dragging; it cannot later become a click by returning near the starting point. Below-threshold release is activation only. Values may be configurable within validated bounds, with these defaults documented and tested.
4. **Stable hit ownership.** Text, icons, tolerance graphics, session enclosures, and regions resolve to declared interaction roles. Group labels/enclosures do not drift. Dedicated expand/collapse controls take precedence over panning. Decorative pixels do not silently change target type because of scene naming.
5. **Pointer completion and cancellation.** Use pointer capture where supported and handle pointer up, pointer cancellation, lost capture, window focus loss, and controller disposal explicitly. Capture permits intentional continuation outside the canvas; a cancellation must not commit a record edit. Clear previews and motion ownership once, without duplicate release actions. Record activation must not occur after a completed pan.
6. **Optional inertial navigation.** Inertia, if enabled, changes only the time window. A new gesture, explicit navigation command, mode switch, teardown, or reduced-motion setting cancels or suppresses it as specified. Use elapsed-time animation, cap velocity/duration, and stop without oscillation. Never infer release velocity solely from total drag distance.
7. **Follow-now and view state.** Actual manual pan, zoom, or recentering pauses follow-now at the chosen viewport until a clear resume/current-time command re-enables it. Temporary suspension during recognition of an actionable gesture is allowed, but an ordinary non-navigating click or cancellation before any viewport change restores the prior follow-now state. Cancellation after navigation has changed the viewport keeps that position and remains paused. Locked/ignored targets never pause it. Keep center time, selected IDs, query scope, and drafts stable across redraws, camera changes, and data refreshes, subject to explicit user navigation and permission changes.
8. **Accessible equivalents.** Provide keyboard record activation, precise date forms, keyboard movement/resizing commands in Edit mode, and accessible pan/zoom/jump controls. Touch interaction must preserve deliberate scrolling and gesture cancellation. Right-button behavior must be intentional; no implicit object rotation is allowed.

The default-mode distinction must be visible in controls and reflected in accessible names. Navigation affordances must remain usable for viewers without granting edit authority. Selecting Edit mode does not bypass per-record permissions or optimistic concurrency checks.

## 08. Future Acceptance Checklist

These are required future scenarios for listener parity and its deliberate corrections. They have not been executed during this documentation task. Map them to the implementation's automated/browser/manual tests and record concrete results.

| ID | Scenario and acceptance condition |
| --- | --- |
| I01 | Navigate mode: drag background, zone, duration bar, point, icon, and label in detail and overview. Resolve the documented band/record owner; keep every coordinate finite; verify no record mutation request and unchanged stored dates/versions. |
| I02 | Group labels, activity enclosures, and decorative targets remain stable. Their activation/expand/pan policy is explicit; ignored hits do not stop follow-now or start an invalid animation. |
| I03 | Exercise stationary click/tap, jitter below threshold, exact-threshold movement, a return toward the origin after crossing threshold, and a long pan. Detail activation opens the inspector; overview activation recenters/selects without forcing it open; a pan does neither accidentally. |
| I04 | Pan one, two, and three differently scaled bands in both directions. The center instant agrees across bands. Verify the 10-overview-unit/240-detail-unit example independently of screen projection. |
| I05 | Repeat point/icon/text picking with orthographic and declared perspective modes, changed device pixel ratio, resized canvas, and nonzero page/container offset. No jump, undefined coordinate, or incorrect target results. |
| I06 | Release over an overview record. A below-threshold activation selects the record and recenters linked detail bands on its start without forcing the inspector open; a drag preserves the intended pan result without the legacy child-local-coordinate jump. |
| I07 | Exercise release outside the canvas, pointer cancellation, lost capture, focus loss, touch interruption, and right-button input. A canceled edit performs no write; all gesture and preview state clears once. |
| I08 | Enable inertia, then interrupt it with a new gesture, mode switch, navigation command, teardown, or reduced-motion change. Motion remains bounded; no oscillation, duplicate timer, late callback, or CRUD occurs. |
| I09 | Pan within the loaded buffer, then across its boundary under slow and out-of-order responses. Bound/coalesce requests, reject stale results, and preserve center, selection, snapshot rules, and unsaved drafts. |
| I10 | Pause/resume follow-now through pan/zoom/recenter and its explicit resume command. A non-navigating click or pre-navigation cancellation restores the prior state; cancellation after navigation stays paused at the chosen viewport. Locked/ignored targets never pause it. Verify clock/reference time with a controllable clock. |
| I11 | Mount two independent timelines/views with different bands, filters, and cameras. Gestures, motion, clocks, request generations, and selection do not leak; intentionally synchronized views share only declared state. |
| I12 | Repeat mount/unmount, scene replacement, camera switching, resize, and refresh, including during a gesture/load. Exactly one active controller exists per canvas, asynchronous work is canceled, and disposed objects are not reused. |
| I13 | Edit mode: move a point/session, resize a finite session, close an ongoing session, and handle stale/unauthorized writes. Confirm the common API path, durable JSON, correct versions, draft/conflict handling, and conditional undo. |
| I14 | Keyboard and touch users complete equivalent navigation, inspection, and authorized editing. Focus, accessible names, minimum hit areas, and reduced motion remain usable across Timeline/Table/Split modes. |

## 09. Pinned Source References

All `J` references above resolve to the same audited first-party file and commit. The model link is pinned to that commit. The Three.js link is a declared-version comparison and remains distinct from legacy runtime evidence.

[J0039]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L39
[J0986]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L986
[J1155]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L1155
[J1969]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L1969
[J2565]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L2565
[J2628]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L2628
[J2798]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L2798
[J2811]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L2811
[J2908]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L2908
[J2926]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L2926
[J2975]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L2975
[J3064]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L3064
[J3870]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L3870
[J3948]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L3948
[J4035]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L4035
[J4138]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L4138
[J4232]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L4232
[J4248]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L4248
[J4257]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L4257
[J4260]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L4260
[J4264]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L4264
[J4268]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L4268
[J4271]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L4271
[J4278]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L4278
[J4285]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L4285
[J4287]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L4287
[J4291]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L4291
[J4295]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L4295
[J4300]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L4300
[J4303]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L4303
[J4307]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L4307
[J4313]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L4313
[J4323]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L4323
[J4332]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L4332
[J4448]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L4448
[J4457]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L4457
[J4476]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L4476
[J4493]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L4493
[J4506]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L4506
[J4522]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L4522
[J4575]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L4575
[J4987]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L4987
[MODEL]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/models/regular_timeline.json#L16
[THREE168]: https://raw.githubusercontent.com/mrdoob/three.js/r168/examples/jsm/controls/DragControls.js
