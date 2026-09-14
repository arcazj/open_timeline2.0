# Legacy Compatibility Matrix

Prepared 12 September 2026. This is a source-backed implementation inventory, not a release certificate. It supplements [model compatibility](legacy-model-compatibility.md), [interaction audit](legacy-interaction-audit.md), [layout audit](legacy-layout-audit.md), [menu/search audit](legacy-menu-search-audit.md), and the governing [rebuild specification](../OpenBEXI_Timeline_Rebuild_Prompt.md).

## 1. Baseline and Evidence Rules

Legacy repository: [arcazj/openbexi_timeline](https://github.com/arcazj/openbexi_timeline), exact commit **`cf5d263853e550aab44d3d1959637c1e324b719e`**. The cached checkout was clean when inspected. All legacy paths and line numbers below refer to this commit, not a moving branch. `J:123` means line 123 in [src/openbexi_timeline.js at the pinned commit](https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js). Other evidence names give the full repository-relative path; append `#L<number>` to the corresponding pinned GitHub blob URL to inspect the line.

The complete `ob_setListeners`, `get_first_free_tracks`, `get_room_for_session`, both standalone visual templates, both HTML entrypoints, all four saved view/filter files and all four source-definition YAML files were read. Consumers and rendering helpers were traced rather than inferred from comments. The nine data/example JSON files were inventoried and syntax-checked; a successful syntax check is not canonical-record/schema validation. Deployment YAML, package metadata and Swagger are not additional visual models or authoritative record schemas.

Support observations in the inventory rows are the historical baseline immediately after increment 2 and before the subsequent compatibility extension; they are not the current release-status report. Relevant current code: [visual schema](../shared/schemas/visual-definition.schema.json), [catalog](../client/src/data/model-catalog.js), [dry-run adapter](../client/src/data/legacy-visual-adapter.js), [layout](../client/src/timeline/layout.js), [renderer](../client/src/timeline/renderer.js), [app](../client/src/app.js). The schema now has nine required visual settings plus optional versioned presentation. Current implemented boundaries are in the [catalog contract](model-catalog-contract.md), [presentation contract](presentation-contract.md), [standalone execution notes](standalone-mode.md) and [implementation status](implementation-status.md). The extension includes measured styling/grouping/nesting and the provider runs in an embedded worker where available; full legacy compatibility still cannot be inferred from those additions.

Status vocabulary:

- **Implemented**: corresponding bounded code exists; this table alone does not certify its tests.
- **Partial**: some intended semantics exist, but the acceptance case still has an identified gap.
- **Gap**: no corresponding end-to-end implementation in the inspected increment.
- **Correct**: preserve intent while replacing a demonstrated legacy defect or unsafe mechanism.
- **Excluded**: no demonstrated behavior, or outside the JSON-only/declarative security boundary; report rather than silently import.

Every acceptance case below is **required/not run by this inventory**. In particular, the legacy application was not launched, no screenshot was reproduced from a serialized legacy model, and no full-release compatibility result is claimed. Existing bounded tests remain useful evidence only for their actual assertions.

## 2. Complete Artifact Inventory

### Visual Templates and Saved Views

| ID | Artifact and exact evidence | Values distinguishing this artifact | Current support and acceptance case |
| --- | --- | --- | --- |
| LC-A01 | `models/regular_timeline.json:3`; production entrypoint `openbexi_timeline.html:34` | `params` plus two `bands`; name `ob_timeline_2`; title `Timeline report`; `current_time`; width 2000; height 1000; UTC. | Partial: dry-run report, not full conversion. Import as a distinct model; retain all mapped values and pointer diagnostics; never auto-apply. |
| LC-A02 | `tests/models/regular_timeline.json:3`; test entrypoint `openbexi_test_timeline.html:34` | Same authored name/basename; fixed `Mon Mar 18 2024 20:00:00 UTC`; width 1350; height 1000; ports 8442/8441; white primary. | Partial. Both templates coexist with distinct generated IDs; round-trip does not overwrite LC-A01. |
| LC-A03 | `filters/default_filter_setting.json:7`, consumer `J:2873` | `ob_timeline_2`; title `1OpenBEXITimeline`; string width `"2000"`, height `"1000"`, top/left `"0"`; `Orthographic`; background `#f3ffff`; ALL selected, STATUS and SYSTEM inactive. | Gap: no complete saved-view/filter importer. Preserve selected filter and separate source/view/model relationships. |
| LC-A04 | `filters/guest_ob_timeline_2_filter_setting.json:7`, `:14`, `:38` | Width `"2200"`; title literal `"null"`, not JSON null; source URL null; same three filter choices. | Gap. Preserve literal-string/null distinction; never infer authentication from imported guest identity. |
| LC-A05 | `filters/test_ob_timeline_0_filter_setting.json:6` | `ob_timeline_0`; width `"1350"`, height `"600"`; background `#a1d9ff`; My_filter2 selected; grouping `system`. | Gap. Preserve expression exactly for reviewed translation; reject unsupported grammar, never replace with ALL. |
| LC-A06 | `filters/test_ob_timeline_2_filter_setting.json:7`, `:18`, `:43` | Width `"2000"`, height `"1000"`; background `#a1d9ff`; By_STATUS selected/status; BY_NAMESPACE inactive/namespace; ALL inactive/NONE. | Gap. Applying a migrated active filter changes grouping deterministically without changing independent table sort. |
| LC-A07 | `openbexi_timeline.html:34`; `openbexi_test_timeline.html:34` | Each loads its corresponding template; neither declares a third inline visual model. | Implemented inventory boundary. Filename/name collisions cannot reduce the required template count to one. |
| LC-A08 | `J:4939 loadModel`, especially `:4958` | Truthiness checks only; supplied title/data are overwritten by the loader. | Correct. Strict validation and explicit approved source binding; authored title survives migration. |

LC-A05's literal filter is `system:system1;system:system2;system:system3|system:system3+type:type0`. Its syntax must be translated from verified operator semantics, not guessed from punctuation.

Raw-file SHA-256 inventory, useful for repeatable migration reports:

| Artifact | SHA-256 |
| --- | --- |
| Production visual template | `78d6615b85ac69adee0ee27b5e79bc34f085d0b2476d37b384379ec40a389862` |
| Test visual template | `8abd39f44bc38ba9a14cfd9914d87eb7e764a2c5d35a964e6a1c1f2c54377322` |
| Default saved view | `5eccf9ef0ff6d325f734d51f38fe85fe7f42324b7bca0f04889cb1492f686938` |
| Guest saved view | `e7e895b9b3e5b8b0d40293db792c191d4b8a87f5b246341b1261b3e7d2b08c54` |
| Test timeline 0 saved view | `59e82952c25a7aeaefd4bab5dda8bd56a74c5652c293d79ed9a89db2410f680b` |
| Test timeline 2 saved view | `e1daf2a0d52c02be5469bc22cff1be3131a0e639f775ff0e5344617d6224a701` |

### Exact Shipped Visual Values

These are source values, including their types. An absent property is not an authored default. Parameter line numbers are production/test respectively; band lines shift by two in the test file.

| Pointer/setting | Production | Test | Evidence |
| --- | --- | --- | --- |
| `/params/0/name` | `"ob_timeline_2"` | same | 4/4 |
| `/params/0/title` | `"Timeline report"` | same | 5/5 |
| `/params/0/date` | `"current_time"` | `"Mon Mar 18 2024 20:00:00 UTC"` | 6/6 |
| `/params/0/timeZone` | `"UTC"` | same | 7/7 |
| `/params/0/top`, `/left` | numeric 0, 0 | same | 8-9/8-9 |
| `/params/0/height`, `/fontSize`, `/width` | numeric 1000, 12, 2000 | numeric 1000, 12, 1350 | 10-12/10-12 |
| `/params/0/data` | empty string | empty string | 13/15 |
| `/params/0/data_default_port`, `/data_sse_port` | absent | numeric 8442, 8441 | test 13-14 |
| `/bands/0/name`, `/height`, `/color` | `"ob_band_1"`, `"75%"`, `"#f3ffff"` | same name/height, `"#ffffff"` | 18-20/20-22 |
| `/bands/0/intervalPixels` | **string `"1000"`** | same | 21/23 |
| `/bands/0/subIntervalPixels`, `/intervalUnitPos`, `/intervalUnit` | `"AUTO"`, `"TOP"`, `"HOUR"` | same | 22-24/24-26 |
| `/bands/0/dateFormat`, `/dateColor`, `/textColor` | `"MM/dd-hh:mm"`, `"#000001"`, `"#040404"` | same | 25-27/27-29 |
| `/bands/0/SessionColor`, `/eventColor`, `/defaultEventSize` | `"#f8feff"`, `"#0f91f9"`, numeric 5 | same | 28-30/30-32 |
| `/bands/0/model/0/sortBy`, `/alternateColor` | `"NONE"`, `"#9ac1db"` | same | 33-34/35-36 |
| `/bands/1/name`, `/height`, `/color` | `"ob_overview_band_2"`, `"25%"`, `"#d9dbde"` | same | 39-41/41-43 |
| `/bands/1/intervalPixels`, `/intervalUnit`, `/dateFormat` | **number 1000**, `"DAY"`, `"yyyy mmm dd"` | same | 42-44/44-46 |
| `/bands/1/SessionColor`, `/eventColor`, `/dateColor` | `"#a110ff"`, `"#238448"`, `"#f31733"` | same | 45-47/47-49 |

Neither standalone template authors a camera. All four saved-view files explicitly author the string **`"Orthographic"`**. Perspective is nevertheless a source-backed menu/consumer capability, not a shipped numeric camera preset. Do not invent numerical camera fields supposedly present in these files.

## 3. Every Listener Branch

`ob_setListeners` occupies `J:4232-4520`. It registers DragControls only. The table accounts for each branch in its three callbacks and their nested movement functions. Mesh/name checks are legacy implementation details; v2 uses explicit interaction roles/owners. Navigation must make zero record CRUD calls and leave dates, IDs, versions and source membership unchanged.

| ID | Exact branch/evidence | Current support/disposition | Concrete acceptance case |
| --- | --- | --- | --- |
| LC-I01 | `:4236`, `:4244-4246`: scene DragControls plus dragstart/dragend/drag | Partial: pointer navigation replaces dependency. | Every selectable visual has an owner; toolbar/inspector gestures do not pan the timeline. |
| LC-I02 | `onDragStart :4249-4255`: clear clock/movement; missing instance returns; save starting X | Partial; no follow-clock/inertia yet. | Start a gesture during motion, then destroy instance: no later movement/callback. Missing instance is inert. |
| LC-I03 | `:4257`: string `sortBy === "true"` restores XYZ and returns | Partial: enclosures not implemented. | Locked enclosure cannot move independently; replace overloaded string flag with explicit interaction role. |
| LC-I04 | `:4260`: zone saves parent start and moves/synchronizes parent | Partial: zone background pans through plot. | Drag zone 100 CSS px; parent time window changes once, annotation dates do not. |
| LC-I05 | `:4264`: named band retains X, fixes Y/Z, initially unsynchronized, markers visible | Partial. | Drag detail/overview in either direction; no vertical drift; both represent the same UTC range. |
| LC-I06 | `:4268`: unnamed record saves parent start | Implemented basic navigation. | Starting on record captures navigation owner without changing record. |
| LC-I07 | `:4271`: all other objects restored; `:4275` render | Partial explicit hit roles. | Axis, group header, scale cue and decoration cannot be displaced. |
| LC-I08 | `onDrag :4458-4459`: missing instance return | Partial lifecycle guarding. | Late move after unmount does nothing and does not throw. |
| LC-I09 | `:4460`: locked object restored and early return | Partial. | Locked-parent test also covers intermediate moves, not only release. |
| LC-I10 | `:4463`, `moveZone :4476-4489`: incremental child delta, restore child, translate parent, synchronize markers | Partial. | Successive deltas 10/20/30 yield total 30, not 60; fixed annotation remains correctly projected. |
| LC-I11 | `:4465`, `moveBand :4493-4503`: translate self X only, synchronize, markers | Implemented basic range navigation. | Detail and overview use their own transforms; adaptive map never assumes a constant scale ratio. |
| LC-I12 | `:4467`, `moveSession :4506-4518`: incremental child delta; restore XYZ; translate parent | Implemented basic navigation. | Drag any event/session label or body; no persisted movement and no second selection action after a pan. |
| LC-I13 | `:4469`, `:4472`: other objects restored, common render | Partial. | Decoration hit cannot mutate geometry or consume a record edit. |
| LC-I14 | `onDragEnd :4279-4280`: missing instance return | Partial. | Release arriving after source replacement cannot act on old query/provider. |
| LC-I15 | `:4282`: locked restore/early return | Partial. | No descriptor, timer or save on locked-parent release. |
| LC-I16 | `:4285`: zone moves parent and synchronizes | Partial. | Zone navigation release preserves exact annotation start/end. |
| LC-I17 | `:4287`: overview band moves self and exposes markers | Implemented basic overview navigation. | Body/edge interaction preserves declared mapped-span or fixed-edge semantics. |
| LC-I18 | `:4291`: ordinary band moves self and exposes markers | Implemented basic detail navigation. | Pointer release produces one coherent map/layout replacement, not different windows per vertical page. |
| LC-I19 | `:4295-4299`: unnamed overview child moves parent using negative child-local X and returns early | Correct; selectable overview records are a gap. | No coordinate-space jump. A click reveals the correct record; a pan neither selects nor skips final cleanup. |
| LC-I20 | `:4300-4302`: unnamed detail child moves parent then opens descriptor even after drag | Correct: current click threshold separates selection. | Below threshold selects; above threshold pans only. Test mouse 4px/touch 8px boundary and cancellation. |
| LC-I21 | `:4303`: other object restored | Partial. | Release outside canvas or on unknown visual cannot move a record. |
| LC-I22 | `:4307-4311`: render; local Date string sliced and suffixed UTC; calendar marker updated | Correct. | Preserve canonical UTC milliseconds; display zone does not relabel a local wall time as UTC. |
| LC-I23 | `:4313-4320`: choose parent vs object movement owner; speed `(start-source)/60` | Gap: no inertia; owner bug must not be copied. | Optional inertia stores start, velocity and cancellation on the same owner for both zone and record paths. |
| LC-I24 | `:4323-4329`: URL-regex transport chooses data head/5ms `ob_move` vs `ob_move2` | Correct. | Navigation scheduling is independent of model URL strings; approved provider handles data refresh. |
| LC-I25 | `ob_move :4332-4333`: undefined interval guard | Correct. | Cancellation clears ownership/state, not only browser interval; stale callback cannot reschedule itself. |
| LC-I26 | `:4335-4341`: zone/record parent branch; near-start thresholds clear timer | Gap optional inertia. | Release at zero/near-zero distance terminates immediately without timestamp drift. |
| LC-I27 | `:4342-4351`: parent velocity damping; erroneously checks child velocity; duplicate directional branches | Correct. | Positive/negative/zero velocity decelerate symmetrically; no child-property NaN or premature/infinite motion. |
| LC-I28 | `:4359-4368`: parent `update_scene(...,true)` during motion | Partial provider refresh, no inertia. | Refresh is bounded/coalesced; no full rebuild for every animation tick. |
| LC-I29 | `:4371-4387`: self branch near-start, sign damping, rounded-zero stop, duplicate position branches | Gap optional inertia. | Same bounded stopping/ownership tests as parent path; animation time based, not CPU-speed dependent. |
| LC-I30 | `:4395-4406`: self update with reload true | Correct. | Query boundaries, not arbitrary frame count, decide fetching; keep coherent pinned/live semantics. |
| LC-I31 | `ob_move2 :4410-4427`: undefined/near-start checks, sign damping, rounded stop | Gap optional inertia. | One active animation per instance; reduced-motion setting can disable it. |
| LC-I32 | `:4428`: alternate mover zone/record branch moves parent current position | Correct. | No use of child-local position as parent-global position. |
| LC-I33 | `:4430-4443`: alternate mover object branch moves and updates without reload | Partial. | Local/Server navigation have equivalent time results without forcing identical transport work. |
| LC-I34 | `:4448-4454`: final zone/record vs other timer choice overrides earlier transport choice | Correct. | Single explicit motion strategy; no abandoned/double timers or transport-specific divergence. |
| LC-I35 | `J:1969`, `:3064 move_band`: uniform pixel/time conversion and band synchronization | Implemented uniform and decimal adaptive mapping. | HOUR 1000px vs DAY 1000px: overview +10px corresponds to detail +240px and center -864000ms in uniform mode. |
| LC-I36 | `J:986 clock`, `:166/:176 reset_synced_time` | Partial: one-shot Now, no follow-now clock. | Explicit follow-now follows each second, pauses on gesture and resumes only by policy; no obsolete date-string heuristic. |
| LC-I37 | `J:2811 destroy`, `:2975 update_all_timelines`, `:4522` scene arrays | Partial: renderer disposal, not complete multi-instance suite. | Mount/destroy/recreate repeatedly; resource/timer/listener counts stabilize and instances never share mutable band objects. |
| LC-I38 | Absence of wheel/keyboard/cancel handlers in `ob_setListeners`; new contract adds them | Partial: wheel/arrows/pointercancel exist; Escape/lost capture/blur need verification. | Keyboard and pointer operations agree; Escape/lostcapture/blur cancel without save; focus returns predictably. |

The legacy `update_scene` reload predicate at `J:2926` uses an OR that is true across its ordinary range. This is a correction target, not a required always-reload behavior. The final timer choice in LC-I34 must be included when interpreting LC-I24; reading the earlier URL branch alone gives an incorrect account of the active code.

## 4. Track Allocation and Collision Coverage

| ID | Source behavior/evidence | Current support/disposition | Concrete acceptance case |
| --- | --- | --- | --- |
| LC-L01 | `get_room_for_session J:3218-3237`: preceding sessions only, four inclusive aggregate X-overlap cases | Correct: current stable per-record first-fit, not aggregate blocks. | Containment, partial overlap, touching endpoints and disjoint footprints all have explicit 4px-clearance behavior. Input permutation leaves final rows unchanged. |
| LC-L02 | `:3238-3245`: collect every overlapping parent's activity Y, sort descending without deduplication | Gap nested blocks. | Duplicate busy rows do not change allocation; every child of a parent stays in its reserved block. |
| LC-L03 | `get_first_free_tracks J:3172`: candidate `maxY-fontSizeInt-trackIncrement`; empty busy set returns it | Partial individual rows. | Empty occupancy allocates first legal row after headers, not on an axis. |
| LC-L04 | `:3183-3190`: candidate above busy; NaN return; first-gap vs later-gap return | Correct. | Non-finite/invalid geometry rejects explicitly; every returned block is rechecked against all occupied rows. |
| LC-L05 | `:3192-3203`: candidate at/below busy; next-row gap, NaN fallback, sufficient-gap return | Correct. | Final occupied row, equal row, missing next row and exact-fit gaps never reuse occupied space. |
| LC-L06 | `:3205-3215`: advance candidate by activity count; catch/final return below last busy row | Correct. | Exhausted space extends/paginates rows deterministically, without exception-driven placement. |
| LC-L07 | `:3247-3254`: extend minimum Y and mark bands updated | Partial fixed-height global row paging. | Height/profile changes create new layout/cursors; groups crossing pages repeat context without duplicate record counts. |
| LC-L08 | `set_sessions J:3575`, `:3614`: two passes; consecutive child rows | Gap nested block layout. | Five overlapping children reserve five rows; 2-row pages yield 2/2/1 with stable parent identity and exact continuation. |
| LC-L09 | `getTextWidth J:3259`; overrides applied later `:3740`; sprite style `:4138` | Partial single measured font/size profile; full style/shaping gap. | Resolve font, weight, italic, text, padding before measuring; actual glyph bounds fit reservation with no zero-width error fallback. |
| LC-L10 | `init_activities J:3427`, `add_event :3992`, `add_session :3884` | Partial basic circle/bar/label. | Large point diameter, left-start icon and label all contribute to footprint; a band-default icon is measured too. |
| LC-L11 | `getSessionWidth :3285`, `getSessionTotalWidth :3318`, `getSession_originalX :3406` | Gap baseline/aggregate union. | Union uses earliest left and greatest right of all displayed current/original decorations; no max-original-X origin error. |
| LC-L12 | `:3427` tolerance and original timestamps | Gap baseline/tolerance rendering. | Render baseline only with defined temporal units; otherwise retain tolerance as metadata and report unsupported visual interpretation. |
| LC-L13 | `add_sessionsBox :3808`, `setBoxProperties :3870` naming mismatch | Correct; current parent enclosure absent. | Exactly one enclosure per visible parent fragment, behind children; intentional containment does not obscure unrelated records. |
| LC-L14 | `init_activities :3427` overview coefficient after time projection | Correct: current overview distinct from detail. | HOUR/DAY bar reservation never applies 1/24 twice; overview aggregation reports counts instead of pretending to be detailed layout. |
| LC-L15 | `create_new_bands :2248`, `set_bands_height :2307` | Partial source/kind headers; no arbitrary data grouping/multi-band heights. | Shuffled source records produce identical group order/rows; group headers, axes, labels never collide. |
| LC-L16 | Detail label contract versus legacy scalar width | Partial compact ellipsis with inspector, not full-label parity. | Full-label mode wraps/expands long Unicode labels and adjusts measured row height; compact mode is explicit, not a hidden substitute. |
| LC-L17 | No final collision assertion in either allocator | Correct; mandatory property/pixel gate outstanding for all styles. | For each accepted profile, final projected footprints of unrelated records have no intersection and at least configured clearance. |

Required arithmetic regression: candidate 80, increment 20, two incoming activities, busy rows `[60,-20]`. The legacy walkthrough returns 0 and places children at `[0,-20]`, reusing occupied -20. A replacement must reject that block and choose a genuinely free block. This is a source walkthrough, not a claim of an executed legacy test. Include randomized occupancy and nested-parent fixtures in both Local and Server layout suites.

## 5. All Authored Parameter Keys

All 19 keys read from `params[0]` at `J:238`, geometry defaults at `:332`, time selection at `:147/:229`. Additional `params` entries have no demonstrated multi-instance semantics and require explicit diagnostics.

| ID | Key; actual legacy handling/default | Current support/disposition and acceptance |
| --- | --- | --- |
| LC-P01 | `name`: authored identity, no initializer default | Partial catalog metadata. Stable target ID independent of source name/basename. |
| LC-P02 | `date`: current_time/Date.now now; four-character year branch; other Date parsing | Partial range/Now. Import deterministic fixed instant or explicit initial-time/follow preference; no eval. |
| LC-P03 | `timeZone`: only UTC or browser-local path verified | Implemented stronger IANA profile. Preserve original and explicit local-zone resolution; test UTC and DST. |
| LC-P04 | `title`: empty fallback; loader overwrites | Correct. Preserve authored title and show migration difference. |
| LC-P05 | `data`: URL substitution and later replacement | Excluded arbitrary access; logical source binding gap. Import cannot fetch network or arbitrary file paths. |
| LC-P06 | `data_default_port`: URL transport substitution | Excluded model-owned transport. Administrator maps approved Server endpoint separately. |
| LC-P07 | `data_sse_port`: stream transport substitution | Excluded model-owned transport. Report source dependency without exposing credentials. |
| LC-P08 | `camera`: undefined Orthographic; any other nonmatching value takes Perspective path | Gap Perspective; default Orthographic implemented. Recognized values only, no silent fallback for typos. |
| LC-P09 | `descriptor`: built-in if absent, transformed/evaluated custom string if present (`:1187/:1234`) | Correct; safe custom inspector gap. No eval/Function/HTML injection; declarative field list or blocked diagnostic. |
| LC-P10 | `top`: integer parse/default 0 | Partial responsive view. Preserve placement preference/provenance without off-screen application. |
| LC-P11 | `left`: integer parse/default 0 | Partial responsive view. Same acceptance as top, including mobile viewport. |
| LC-P12 | `width`: integer; ordinary fallback 1350, exception fallback 800 | Partial responsive width. Numeric strings translate with recorded rule; no contradictory fallback. |
| LC-P13 | `height`: integer/default 800 | Partial responsive height/paging. Keep desired height separate from actual usable row area. |
| LC-P14 | `backgroundColor`: preferred, falls back to color | Gap arbitrary colors. Exact color import and explicit precedence, not nearest-theme guessing. |
| LC-P15 | `color`: fallback alias; first band may later supply background | Gap alias translation. Conflicting aliases receive diagnostics. |
| LC-P16 | `fontSize`: default12; numeric/numeric-string intended, `12px` falls through guard | Partial bounded size. Convert only documented representations; reject units/values outside profile with explanation. |
| LC-P17 | `fontFamily`: Arial default | Gap font selection. Approved embedded font with measured metrics; missing Arial is explicit fallback, not false exact-font parity. |
| LC-P18 | `fontStyle`: Normal default | Gap italic style. Resolve typed normal/italic before layout; test overhang. |
| LC-P19 | `fontWeight`: Normal default | Gap weight. Approved measured weights, no unmeasured browser synthetic substitution. |

### Camera and Geometry Contract

| ID | Exact source evidence | Required disposition and acceptance |
| --- | --- | --- |
| LC-C01 | `J:4575` Orthographic frustum `[-width/2,width/2,height,0,-width,far]`, camera `(0,0,height)` | Default remains orthographic 2D. CSS-pixel/time mapping, aspect changes and hit tests must agree. |
| LC-C02 | `J:310-326`, `:4590` Perspective: fov70, near1, far50000; x=-1500 if height>2000, -1000 if >1000, otherwise -100; y/z height/2; lookAt(0,height/2,0) | Gap explicit compatibility camera. These are derived source defaults, not authored JSON numeric parameters. Preserve meaningful perspective mode only with projected collision/hit testing; never silently label an orthographic translation Perspective. |
| LC-C03 | `J:312` derives camera coordinates before `ob_height` initialized at `:346` | Correct. Compute from validated final dimensions, not initialization-order accidents. |
| LC-C04 | `J:296` multiples22/increment20; `:2720` fixed wide geometry and authored XYZ overrides | Correct. Responsive bounds and paginated rows replace oversized geometry; retain source values in migration report. |
| LC-C05 | `J:415`, `:421`, `:1474`, `:838-839` camera menu/settings | Gap camera control. Model preview and active view both show supported mode; unsupported profile blocks apply explicitly. |

## 6. All Authored Band Keys

Defaults/consumers: `set_band_properties J:2460`, heights `:2307`, geometry `:2720`, axis labels `:3140`, record styling `:3714`. This table covers all 33 authored-looking keys read or assigned by those paths. Defaults below do not override the exact shipped values in section 2.

| ID | Key; legacy handling | Current support/disposition and acceptance |
| --- | --- | --- |
| LC-B01 | `name`: identity and overview role inferred from inconsistent name substrings | Partial two roles. Explicit role/id; renaming does not change behavior. |
| LC-B02 | `height`: percentage/pixel; primary recomputed | Gap per-band sizing. 75/25 proportion is retained as preference, bounded by responsive minimums. |
| LC-B03 | `color`: source/group override, default black | Gap exact palette/source bands. Primary and overview retain independent colors. |
| LC-B04 | `textColor`: source/group override, default black | Gap exact style. SOURCE1 white and SOURCE2 black text remain legible. |
| LC-B05 | `dateColor`: source/group override, default black | Gap independent axes. Red overview date color does not recolor record labels. |
| LC-B06 | `SessionColor`: exact capital S; default black | Gap style fallback. Finite/ongoing bars inherit duration color unless record override. |
| LC-B07 | `eventColor`: default black | Gap style fallback. Points inherit point color independently of sessions. |
| LC-B08 | `sessionHeight`: default10, falsy replaced | Gap configurable geometry. Measured duration-bar height equals render/hit height. |
| LC-B09 | `defaultEventSize`: default5, radius at renderer | Gap configurable geometry. Migration records radius-vs-diameter conversion; footprint includes full diameter. |
| LC-B10 | `fontSize`: integer/timeline inheritance | Partial global size. Per-band resolved size used by both layout and renderer. |
| LC-B11 | `fontSizeInt`: overwritten/derived | Excluded authored state. Recompute and report removal, not independent size control. |
| LC-B12 | `fontFamily`: inherited | Gap per-band measured font. Asset and font-profile references must resolve offline. |
| LC-B13 | `fontStyle`: inherited | Gap. Italic display and measured ink agree. |
| LC-B14 | `fontWeight`: inherited | Gap. Selected weight and layout metrics agree. |
| LC-B15 | `intervalPixels`: default string `200`, parsed number | Gap per-band scale spacing. Numeric1000 and string1000 normalize identically with provenance. |
| LC-B16 | `intervalUnit`: MINUTE default, trimmed case-sensitive | Partial all11 global units. Distinct HOUR detail/DAY overview supported independently. |
| LC-B17 | `dateFormat`: DEFAULT or finite custom formatter | Gap custom format migration. All35 strings have explicit safe mapping or blocking diagnostic. |
| LC-B18 | `intervalUnitPos`: TOP exact, everything else bottom | Gap per-band axis location. Imported TOP compatibility and default bottom both rendered without consuming row space incorrectly. |
| LC-B19 | `subIntervalPixels`: absent/NONE off; HOUR>=60 forces /4; otherwise integer parsing | Correct; explicit subdivision gap. AUTO1000/HOUR translates documented 250px legacy intent, not universal AUTO semantics. |
| LC-B20 | `texture`: presence activates hardcoded cubemap, not provided asset path | Correct; approved material gap. Never fetch arbitrary path or claim legacy input path was honored. |
| LC-B21 | `defaultSessionTexture`: assigned, no consumer found | Excluded no demonstrated effect. Retain pointer/value as inactive provenance. |
| LC-B22 | `image`: preloaded icon fallback | Gap assets. Approved embedded icon ID or unavailable-asset diagnostic. |
| LC-B23 | `textBackgroundColor`: label background, sometimes reset by record render | Correct; override gap. Explicit absent/inherit/none semantics. |
| LC-B24 | `luminance`: read but not forwarded | Excluded no demonstrated effect. Do not advertise original luminance working. |
| LC-B25 | `opacity`: read but not forwarded | Excluded no demonstrated effect. New opacity control needs its own schema and test. |
| LC-B26 | `x`: default-10000 then re-centered | Derived. Never persist transient pan X as canonical record date. |
| LC-B27 | `y`: recomputed | Derived. Row/height changes recompute, no stale imported placement. |
| LC-B28 | `z`: integer/default0, depth order | Gap bounded layer/camera compatibility. Ordered layers cannot hide labels or alter hit ownership. |
| LC-B29 | `depth`: default0, geometry helpers own fallback | Gap bounded depth/material. Orthographic default remains inspectable; perspective profile explicitly tested. |
| LC-B30 | `width`: overwritten100000 then viewport-derived | Derived. Report ignored authored width, never allocate unbounded DOM/geometry. |
| LC-B31 | `multiples`: overwritten from scene22 or saved setting | Correct. Provider prefetch policy separate from authored date scale; no full-list fetch for rows. |
| LC-B32 | `trackIncrement`: scene20, overview-specific recalculation | Partial rowHeight. Explicit spacing and measured row-height constraints replace overwritten increment. |
| LC-B33 | `model`: array, only first entry consumed | Gap arbitrary grouping. Translate supported first-entry meaning; extra entries receive diagnostics, not invented legacy hierarchy. |

Runtime-only band fields also need pointer dispositions when encountered: `gregorianUnitLengths`, `heightMax`, `heightMin`, `iniMinDate`, `iniMaxDate`, `lastGreaterY`, `layout_name`, `layouts`, `layouts.max_name_length`, `maxDate`, `maxY`, `minDate`, `minViewOffset`, `minWidth`, `minY`, `pos_x`, `pos_y`, `pos_z`, `position`, `sessions`, `track`, `viewOffset`, `zones`; array properties `original_length` and `updated`. **LC-B34**: derive them afresh from the authorized snapshot (`J:1752`, `:1982`, `:2164`, `:2307`, `:3538`); an imported runtime dump must not inject scene state.

## 7. Grouping, Styles and Formats

| ID | Capability and source evidence | Current support/disposition and acceptance |
| --- | --- | --- |
| LC-G01 | `band.model[0].sortBy`, `J:2248/:3556`: arbitrary data field via eval, not only source/kind | Gap data-path grouping. Typed JSON-pointer field resolver with no eval; status/system/namespace and missing values form deterministic lanes. |
| LC-G02 | `model[0].alternateColor` declared in both templates; actual luminance alternation `J:2224` | Excluded original field effect, new explicit alternating palette gap. Preserve `#9ac1db` as declared-but-unused provenance; do not pretend observed application. |
| LC-G03 | Saved grouping then active-filter grouping override `J:2888/:2902` | Gap saved relationships. Active-filter precedence explicit; selected field survives import/export. |
| LC-G04 | `build_model J:4171`, picker `:473`: discovered Map with excluded keys/comma strings, <15 heuristics | Correct; schema field catalog gap. Sparse/later fields and exact typed values discoverable; no substring collisions or arbitrary name-length exclusion. |
| LC-G05 | Source render accessors `J:2140-2155`; observed callers first three colors | Gap source-style overrides. Source background/text/date styles work; alternateColor accessor alone is not proof of use. |
| LC-R01 | `render.color`, `J:3714/:3808/:2692` | Implemented basic record color; partial scopes. Preserve separate record/enclosure/zone ownership. |
| LC-R02 | `render.textColor` | Gap. Resolved label color respects band/source inheritance. |
| LC-R03 | `render.fontSize` | Gap per-record metrics. Larger labels reserve larger width/height before packing. |
| LC-R04 | `render.fontWeight` | Gap. Weight-specific metrics and rendering agree. |
| LC-R05 | `render.fontFamily` | Gap. Approved font, missing-asset diagnostics, no network dependence. |
| LC-R06 | `render.fontStyle` | Gap. Typed style, actual ink overhang included. |
| LC-R07 | `render.backgroundColor`; missing key incorrectly disables inherited background | Correct; style override gap. Absent inherits; explicit none disables; search is transient. |
| LC-R08 | `render.image`, `J:3992/:3884` | Gap icons. Point and session-start icon widths, fallback and accessible labels tested. |
| LC-R09 | `render.texture` | Correct; safe material gap. No arbitrary URL or executable asset; original presence behavior reported. |
| LC-R10 | `render.luminance` read but not forwarded | Excluded no demonstrated effect. Preserve inactive provenance. |
| LC-R11 | `render.opacity` read but not forwarded; enclosure independently defaults0.35 | Excluded original effect; safe opacity extension optional. No fabricated legacy behavior. |
| LC-R12 | `render.textBackgroundColor` only overview searched-parent condition at `J:3786` | Correct. Do not merge silently with backgroundColor; explicit match identity replaces color-driven search. |
| LC-R13 | Preloaded image Map `J:76-117` and subsequent icon entries | Gap approved asset catalog. Preserve supported error/warning/info/check/start/stop/flag/square/etc. mappings by ID; absent paths produce honest fallback, not hidden HTTP fetch. |

### Complete Finite Formatter Manifest

`J:1834` is a finite case-sensitive implementation, not an arbitrary date-format library. The following 35 custom spellings are the required migration fixture inputs, with stable IDs. Each test uses at least `2024-03-18T20:07:09.123Z`, a January date, and a non-UTC display zone; corrected output must have documented padding/separators and valid calendar values. Current custom-format support is **Gap** for every entry. Accepted legacy spellings must map explicitly; unknown spellings cannot silently fall back to local hour.

| ID | Legacy format | ID | Legacy format |
| --- | --- | --- | --- |
| LC-T01 | `MM/dd/yyyy/hh:mm` | LC-T19 | `mmm/dd-hh:mm` |
| LC-T02 | `MM/dd/yyyy-hh:mm` | LC-T20 | `dd/MM/hh:mm` |
| LC-T03 | `MM-dd-yyyy hh:mm` | LC-T21 | `dd/MM-hh:mm` |
| LC-T04 | `dd/MM/yyyy/hh:mm` | LC-T22 | `mmm` |
| LC-T05 | `dd/MM/yyyy-hh:mm` | LC-T23 | `MM` |
| LC-T06 | `dd/MM/yyyy hh:mm` | LC-T24 | `yyyy MM` |
| LC-T07 | `MM/dd/hh:mm` | LC-T25 | `yyyy/MM` |
| LC-T08 | `MM/dd-hh:mm` | LC-T26 | `yyyy-MM` |
| LC-T09 | `MM/dd` | LC-T27 | `yyyy mmm dd` |
| LC-T10 | `mmm dd` | LC-T28 | `yyyy/mmm/dd` |
| LC-T11 | `mmm/dd` | LC-T29 | `yyyy-mmm-dd` |
| LC-T12 | `dd hh:mm` | LC-T30 | `yyyy mmm` |
| LC-T13 | `dd/hh:mm` | LC-T31 | `yyyy/mmm` |
| LC-T14 | `dd-hh:mm` | LC-T32 | `yyyy-mmm` |
| LC-T15 | `ddd dd hh:mm` | LC-T33 | `yyyy` |
| LC-T16 | `ddd dd/hh:mm` | LC-T34 | `UTC` |
| LC-T17 | `ddd dd-hh:mm` | LC-T35 | `ISO` |
| LC-T18 | `mmm/dd/hh:mm` | LC-T36 | `DEFAULT` (separate mode, `J:1932`) |

**LC-T37, Correct**: source `hh` means 24-hour hour; numeric month/day padding is inconsistent; `yyyy MM`, `yyyy/MM`, `yyyy-MM` use zero-based month; global separator detection is not a parser. Preserve intended format, not these defects. DEFAULT century/decade multiplying the actual year by100/10 (`J:1949`) must also be corrected.

| ID | Unit from `J:1752` | Exact legacy value | Current support and acceptance |
| --- | --- | --- | --- |
| LC-U01 | MILLISECOND | 1ms | Implemented bounded scale. Exact 1ms view inside millennium domain; decimal projection round trip. |
| LC-U02 | SECOND | 1000ms | Implemented; subsecond records remain distinct. |
| LC-U03 | MINUTE | 60000ms | Implemented; boundaries correct in display zone. |
| LC-U04 | HOUR | 3600000ms | Implemented; repeated/skipped DST hour identified correctly. |
| LC-U05 | DAY | 86400000ms | Correct calendar ticks; no assumption every local day24h. |
| LC-U06 | WEEK | 604800000ms | Implemented explicit week policy; year-crossing week fixture. |
| LC-U07 | MONTH | fixed31days | Correct to actual calendar; Jan/Feb/leap-Feb boundaries. |
| LC-U08 | YEAR | fixed365days | Correct calendar; leap day retained. |
| LC-U09 | DECADE | fixed3650days | Correct calendar; no multiplied year labels. |
| LC-U10 | CENTURY | fixed36500days | Correct calendar; boundary/date-range tests. |
| LC-U11 | MILLENNIUM | fixed365000days | Correct calendar; supported year0001-9999 only. |
| LC-U12 | EPOCH | -1 sentinel | Excluded usable scale not demonstrated; explicit unsupported unit. |
| LC-U13 | ERA | -2 sentinel | Excluded usable scale not demonstrated; explicit unsupported unit. |

## 8. All Source and Data Variants

### Source Definitions

| ID | Artifact/evidence | Actual variants and disposition | Acceptance |
| --- | --- | --- | --- |
| LC-S01 | `yaml/sources_startup.yml:2-17` | SOURCE1, enabled json_file, build_in converter, date-partition paths; black/white/white source colors and alternate `#e6e6e6`. Gap source import/style. | Approved logical source retains colors and mapping; source path is not a database schema. |
| LC-S02 | `yaml/sources_default_test.yml:2-33` | SOURCE1 enabled, background `#404040`; SOURCE2 disabled, background `#D3D3D3`; SOURCE1 text/date white, SOURCE2 black; alternate `#e6e6e6`. | Disabled source never queried; changing enabled state is explicit authorized command, not model side effect. |
| LC-S03 | `tests/yaml/sources_default_test.yml:2-33` | Same two sources but SOURCE1 background black instead of #404040. | Distinct artifact preserved; production/test path cannot collapse by basename. |
| LC-S04 | `yaml/sources_default.yml:2-29` | Two json_file entries share TEST_SOURCE1 namespace; enabled/disabled; converter spelling `buildin` vs placeholders; malformed key spelling `alternateColor\"`. | Block duplicate source IDs; report unknown key/converter rather than silently fixing or enabling. |
| LC-S05 | `yaml/sources_default.yml:31-227` | Disabled declarations: mongoDb, kafka, mqtt, elasticsearch, postgresql, cassandra, hdfs, rest_api, apache_pulsar, snowflake, aws_iot_core, azure_event_hubs, neo4j, solr. | Excluded all14 non-JSON types from runtime; sanitized import report lists unsupported types without secrets. Declarations are not proof drivers work. |
| LC-S06 | `src/com/openbexi/timeline/data_browser/data_configuration.java:96-138`; `data_sources.java:122-131`, `:216-246`, `:392` | type, data_model, data_model_list, data_include/exclude, connector, namespace, enable, permission, converter, render. | Gap complete source admin. Parse into typed JSON-file source definitions; enforce allowlisted directories/readOnly/writable policy, never arbitrary browser filesystem access. |
| LC-S07 | Saved filter source objects, e.g. default `:20-39`; `J:2873` | JSON settings embed same source/render/connector metadata; guest source URL is null. | Complete import resolves or explicitly remaps dependencies; imported names/email/permission text never establish identity/authorization. |
| LC-S08 | `yaml/deployment.yaml`, `service.yaml`, `tomcat.yml`; Swagger YAML | Deployment/API artifacts, not extra visual models or canonical schemas. | Excluded from visual count; no inference that declaring an endpoint implements it. |

Source checksums: startup `20770eee6f2b4b2af2cca180c75391c7c6c9bf9cd13c8a1b824197a6ef158447`; yaml test `83d3efcafddaee7b865f4ab038dbe41af2b0962a81ee99d0c346e75a8f447a56`; tests test `a162bfa22768fecf733524873ef55eb69d04b46c4108b591cc50f3f31deb33cb`; default examples `f2dade6af4a7fe5fd60d6f4eac12d0148a37001f9b8eb9a08989382b919438dd`.

### Data and Schema Inventory

Counts below concern top-level records in syntactically valid envelopes, not the number of canonical events after migration. All nine files require a deterministic import report; current complete legacy record/schema migration is **Gap**.

| ID | Tracked path | Static observations | Concrete acceptance |
| --- | --- | --- | --- |
| LC-D01 | `json/covid19.json:1` | Syntax valid;1613 records; start/data; all lack ID and end; title/text. | Stable generated IDs from documented namespace/source identity; explicit point kind; no random IDs on each import. |
| LC-D02 | `json/ephemeris.json:131` | Syntax invalid; first parser error at offset62107, line131. | Reject original without partial import; separate repaired artifact plus exact change report/hash before validation. |
| LC-D03 | `json/event_or_session_model.json:1` | Syntax valid illustrative `session` array, one entry; placeholder dates; repeater, originals, domain fields and render. Not JSON Schema. | Never load placeholders as real dates or advertise schema validation; proposed canonical schema requires explicit field/type mapping. |
| LC-D04 | `json/jfk.json:1` | Syntax valid;130 records; all lack top-level ID;114 missing/empty ends; isDuration and data title/text/image/link/icon/id/classname. | Preserve custom content/links safely; nested data.id not blindly treated as authoritative global ID; historical dates accepted. |
| LC-D05 | `json/space_exploration.json:1` | Syntax valid;1287 records; no IDs/ends; title/text. | Deterministic IDs and point migration; no arbitrary 1970 date cutoff. |
| LC-D06 | `json/test.json:1` | Syntax valid;450 records; all top-level IDs;198 empty/missing ends; original dates, namespace, data, render. No activities in this file. | Map original dates, sources, status/system/priority/tolerance and icons with explicit typing; no invented nested structure. |
| LC-D07 | `tests/data/events.json:4` | Syntax invalid; first error offset331, line4; malformed/trailing-comma generated shapes. | Strict rejection and bounded diagnostic output; never use permissive recovered record count as authoritative. |
| LC-D08 | `tests/data/SOURCES1/2024/03/18/events.json:4` | Syntax invalid; first error offset480, line4. | Same repair workflow; provenance distinguishes SOURCES1 from SOURCES2. |
| LC-D09 | `tests/data/SOURCES2/2024/03/18/events.json:4` | Syntax invalid; first error offset479, line4. | Same repair workflow; original remains byte-for-byte unchanged. |
| LC-D10 | `tools/com/openbexi/timeline/event_generator.java:130-197` | Attempts parent/activities with IDs and domain/render fields; writes trailing commas and namespace before child object at159-160. | Correct generator/adapter fixture shapes; comments or permissive parsing do not establish valid nested JSON. |
| LC-D11 | `init_sessions J:3538-3572` | Reads events; absent activities wraps record into synthetic activities[0]; missing ID becomes0; separates zone-presence records. | Correct: one authoritative record, no duplicate synthetic persisted child, no shared ID0; nested relationships explicit. |
| LC-D12 | `J:3557`, `:2692` zone records | Zones are separately rendered regions, not ordinary session allocations. | Explicit typed annotation, independent band projection, bounded label placement, zero CRUD on navigation. |
| LC-D13 | `event_descriptor.java:58`, `:78`; `J:1187` | Date/ID-based descriptor sidecars and unsafe custom descriptor execution. | Stable-ID details migration; executable text redacted/hash-only in public reports; safe declarative inspector. |
| LC-D14 | `json/event_or_session_model.json` repeater; no main-JS consumer found | Declared recurrence-like field, no demonstrated expansion behavior. | Excluded implied recurrence execution; preserve metadata until explicit recurrence contract exists. |
| LC-D15 | `J:3757` empty end renders a point; canonical v2 kind/end distinguishes ongoing session | Correct ambiguity. Empty legacy end requires explicit point-vs-ongoing policy; never silently reinterpret all empties as infinite sessions. |

Per-record fields observed across valid files include `start`, `end`, `original_start`, `original_end`, `namespace`, `id`, `isDuration`, `data`, `render`; custom data includes title/text/description/system/namespace/type/priority/tolerance/status and image/link/icon/classname. Preserve recognized custom fields without treating unknown values as executable markup. A syntax-valid file still requires strict duplicate-property/ID detection, finite/safe numbers, canonical dates, authorization and reference checks.

## 9. Menu, Search and Management Semantics

These are outside `ob_setListeners` but required to interpret its effects and the user's reference views correctly.

| ID | Actual source behavior | Current support/disposition and acceptance |
| --- | --- | --- |
| LC-K01 | Header `J:1242`, start/stop `:1288` invokes login/account `:860/:874/:889` | Partial capability-based connection, not account administration. Do not label these icons playback; unauthenticated import never creates identity. |
| LC-K02 | Calendar `J:1018/:1055`, create form `:1096` | Partial range picker and CRUD forms. Navigate date independently from creating record; validation errors preserve entered values. |
| LC-K03 | Sync `:1342` invokes reset time `:166/:176`, not reload | Partial separate Now/Refresh. Button semantics named accurately; follow-now separate from one-shot reset. |
| LC-K04 | Filter `:1364` invokes grouping picker `:726`; CRUD at `:561/:582/:630/:637` | Gap full saved-filter CRUD; partial source/kind/search controls. Grouping is not table sorting; all four saved-filter fixtures round-trip. |
| LC-K05 | Search `:1382`, Enter `:1535` applies query; no explicit input-clear handler | Partial literal search. Clearing returns complete context and overview, resets match state only, never persisted style. |
| LC-K06 | Marker `:1403` indicator with no handler | Implemented reference cue, not missing button. Do not invent an action from icon appearance. |
| LC-K07 | Overview toggle `:1417` | Partial two-band display; toggle gap. Hiding/reopening overview preserves current window/query, never changes grouping implicitly. |
| LC-K08 | 3D/2D toggle `:1474` selects cameras | Gap Perspective. It is not Table/Timeline; table is a new independent view. |
| LC-K09 | Settings `:1501/:801`, Help `:1520/:939`; draggable header | Partial modern settings. Model changes preview/diff before apply; moving an app panel never pans data accidentally. |
| LC-K10 | `json_files_manager.java:103` date/filter/search pipeline; `searchEvents :418` regex over serialized JSON | Correct: no unsafe regex/eval. Literal any/all/phrase/field scopes require documented exact parser and cross-provider fixtures; current bounded any-search is not complete grammar. |
| LC-K11 | Search writes yellow `#F8DF09` and next_date; returns original context; nested branch skips parent | Correct: transient match IDs. Parent/child context and counts explicit; search cannot mutate records or silently ignore matching parent title. |
| LC-K12 | `J:3757` overview includes yellow matches; `:3786` parent uses different background field | Partial match-only overview. Exact M vs C sets, zero matches, off-page match reveal and one parent enclosure; never inspect persisted colors to determine match. |
| LC-K13 | Saved settings `J:2873` merge view/filter/source/user | Partial catalog lifecycle, gap full relationship import. Validate complete dependency graph, explicit ownership remap, no implicit active-version upgrade. |
| LC-K14 | Modern versioned catalog has no direct legacy equivalent | At this inventory baseline, bounded nine-field model management was implemented. Create/edit/validate/preview/publish/apply/duplicate/archive/delete/import/export preserve immutable versions and explicit pins in both providers. The later optional presentation extension is defined by the current catalog and presentation contracts. |
| LC-K15 | Local/Server fallback, authorization and unknown command recovery are new requirements | Implemented bounded workflows, broader release gate outstanding. Full snapshot not a row page; no automatic upload; old-source/auth responses cannot alter new source; unknown write keeps original key. |

Search screenshot strings `5_1` and `0_3` are useful cases, but the malformed repository activity fixtures do not establish an authoritative runtime hit count. Use a repaired/provenanced or deliberately synthetic fixture with a declared exact ID set before asserting counts.

## 10. Historical Extension Proposal

This section preserves the original proposed field names and remaining legacy motivations, not a competing schema. The subsequently implemented subset uses the exact [presentation v1 contract](presentation-contract.md), including `bands.primary`/`bands.overview` objects rather than the proposed bands array below. Existing nine-field definitions remain valid and immutable. Proposed arbitrary assets, Perspective, fixed placement and full source/schema migration remain gaps; supported measured styling, custom grouping, text-only inspectors and nesting are now defined by the linked contract. Do not create empty UI controls for unimplemented fields.

| ID | Proposed typed extension | Exact legacy motivation/values | Boundary and acceptance |
| --- | --- | --- | --- |
| LC-X01 | `presentation.version`; `presentation.bands[]` with stable `id`, explicit `role`, `label`, `height` policy | ob_band_1 and ob_overview_band_2; 75%/25% | Default remains responsive two-band bottom-axis 2D; imported top-axis/proportion is explicit compatibility profile. No nested authoritative records in model. |
| LC-X02 | Per-band `background`, `labelColor`, `axisColor`, `sessionColor`, `eventColor` | Main #f3ffff or #ffffff; #040404/#000001/#f8feff/#0f91f9; overview #d9dbde/#f31733/#a110ff/#238448 | Exact validated colors; source override then record override where relevant; independent from transient match/selection. |
| LC-X03 | Per-band `axis.position`, `unit`, `formatId`, `intervalPixels`, `subdivisions` | TOP, HOUR, MM/dd-hh:mm, string1000, AUTO; overview DAY, yyyy mmm dd, number1000 | Normalize mixed numeric types with reported conversion. Format enum/approved formatter only; independent band unit and axis reservation. |
| LC-X04 | `labels.fontProfileId`, `size`, `weight`, `style`, `color`, `background`, `overflow`, `fields` | Arial/Normal/Normal/12 defaults; inherited band and per-record overrides | Ship matching approved font/metrics/weight assets; support full/compact modes honestly. The current four measured Noto Sans profiles do not establish Arial exactness. |
| LC-X05 | `markers.pointRadius`, `durationHeight`, `iconAssetId`; safe per-record counterpart | Default radius5/bar10; preloaded image IDs; icon left of session start | Full union measured before layout; approved embedded raster/checked assets, no imported executable SVG/URL behavior. |
| LC-X06 | `grouping.field` JSON pointer, typed ordering/missing-value policy; source `styles` map | NONE, saved status/system/namespace; source colors black/white and #D3D3D3/black | No eval; table sort separate. Avoid implementing arbitrary nested grouping by pretending extra model array entries had consumers. |
| LC-X07 | `groups.enclosure`, `padding`, `label`, child-order/continuation policy | Multi-activity enclosure, 0.35 independent opacity, consecutive rows | Reserve whole parent block; paginate with explicit continuation; one enclosure per fragment; no duplicate canonical children. |
| LC-X08 | `camera.mode` orthographic/perspective; bounded named compatibility profile | Saved Orthographic; menu supports Perspective; derived fov70/near1/far50000 and height-based positions | Orthographic primary; perspective remains an explicit gap until renderer/projection/collision/hit tests exist. No silent orthographic substitution. |
| LC-X09 | `inspector.sections[].fields[]` with label/field/approved display kind | Built-in descriptor and unsafe custom descriptor strings | Text/links/images only through validators; no code/HTML execution; blocked executable property hash, not secret-bearing public raw source. |
| LC-X10 | Separate view `initialTime`, `followNow`, dimensions/placement preferences and source binding | current_time versus fixed2024-03-18T20:00Z; 2000x1000/1350x1000/1350x600/2200x1000; ports | View preferences never redefine server access. Fixed geometry adapts within viewport while preserving original import provenance. |
| LC-X11 | Source/schema/record import report with explicit mappings and repair provenance | Nine data files, four source variants, missing IDs/end/placeholder dates | No partial activation of malformed/unknown data; public reports redact secrets and executable strings; original files unchanged. |

Recommended implementation order: LC-X01/X02/X03/X05/X06 establish the actual templates and source-grouped reference views; LC-X07 addresses nested layout; LC-X04 and LC-X09 add safe rich labels/inspector; LC-X08 remains a distinct compatibility task. Model lifecycle support must carry every implemented extension through validation, draft diff, preview, immutable publication, apply, Local JSON export and Server restart. A UI-only color override is not model support.

Suggested precedence, to freeze explicitly: system defaults < selected published model < approved source/group style < permitted record override; transient selection/search paint is separate and nonpersistent. View geometry/time preferences and authorization/source policies are separate concerns, not later style overrides.

## 11. Reference Image Pairs and Verification Limits

| ID | Existing reference image | Source pairing and honest interpretation | Acceptance target |
| --- | --- | --- | --- |
| LC-V01 | [Descriptor reference](ui/v2.2/evidence-descriptor.png) | User-supplied black detail/light overview with activity blocks, icons and right descriptor. Pair with production/test band template plus source overrides as a **candidate reconstruction**, not proof of exact serialized origin. | Inspectable events, correctly padded parent/child blocks, all icons resolved, safe descriptor; default 2D and explicit imported profile both usable. |
| LC-V02 | [Grouped reference](ui/v2.2/evidence-grouped.png) | SOURCE1 dark/white and SOURCE2 light/black bands. Pair with `tests/yaml/sources_default_test.yml` colors and data-path grouping; screenshot alone cannot identify active source file/version. | Independent source-band colors/labels and grouping, common UTC coordinates, stable rows, no text/axis overlap. |
| LC-V03 | Production vs test template rendering | Exact authored palettes/dimensions are in section2; these are different compatibility fixtures despite identical basename/name. | Capture both named imported models with deterministic canonical data; record effective settings and deliberate responsive/calendar corrections. |

The reference images are evidence assets, not executed application test results. Preserve original attachments unchanged. New screenshots require the exact model version, source snapshot, query/map/layout IDs, viewport, font profile, provider, selected record/search and expected visible IDs. Pixel similarity alone cannot prove authorization, complete query sets, CRUD durability, source import or full-label layout.

## 12. Completion Gates and Remaining Limits

1. Machine-readable migration report covers every encountered pointer with original type, disposition, exact target, diagnostic, dependency and restricted/redacted provenance. Known unsafe/no-effect/derived values are not omitted just because they do not become active fields.
2. Both visual templates, four saved views and four source files remain individually identifiable. Every syntactically valid data variant has deterministic ID/schema mapping; malformed originals are rejected until an explicit separately hashed repair is supplied.
3. Listener and allocator cases above run in Local and Server modes where applicable. Navigation produces zero record writes. Equivalent inputs produce the same authorized sets, grouping and collision-safe rows, with decimal mapping tolerance from the normative contract.
4. Published model versions containing every implemented capability survive preview, apply, duplicate, archive/reference checks, export/import and Server restart. Unsupported capabilities block publication/apply with precise diagnostics; a default fallback cannot count as compatibility.
5. Browser visual/accessibility tests cover desktop/mobile, all allowed fonts/styles/markers, nested parents, source palettes, full labels, mixed units/formats and supported camera profiles. Performance/resource bounds and source-isolation tests remain mandatory.

This inventory is complete for the tracked artifacts and named source functions at the pinned commit. It does not claim every external user-authored model was available, every connector declaration works, every malformed data file has a known intended repair, or every template property affected the old runtime. Those limitations must remain visible until additional source/runtime evidence resolves them.
