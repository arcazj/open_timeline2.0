# Sorting, Filtering and Search: Reverse-Engineering Report

Revision 1.0 | 2026-09-14 | Analysis and specification, not a feature release.

## Evidence and Scope

The reviewed legacy tree is `C:/projects/openbexi_timeline`, not `C:/projects/open_timeline`. The modernization baseline is commit `2c3b0c17e3167577c00951ee456588c8ed9cd521`. Local legacy file SHA-256 hashes, extracted method hashes and observed results are recorded in [evidence.json](evidence.json). A GitHub revision is not asserted for the entire local legacy tree.

This report combines source inspection with **14 Java method cases and six JavaScript checks**. The [probe script](../../scripts/audit-sorting-filtering.mjs) executes unchanged extracted methods against [synthetic inputs](cases.json), without initializing Tomcat, file watchers or legacy persistence. These are method-level observations, not a full legacy browser/server qualification. Fixture IDs such as E1 are readable test aliases, not valid canonical production IDs. No production dataset or private preset contents have been copied into this report.

Reproduce with Node 22+ and an installed JDK:

```powershell
node scripts/audit-sorting-filtering.mjs C:/projects/openbexi_timeline "C:/Program Files/Eclipse Adoptium/jdk-17.0.19.10-hotspot"
```

The harness compiles in ignored `artifacts/sorting-filtering/probes/`, using the legacy JAR only for its JSON classes. It does not modify the legacy project or source records. Review source changes before accepting regenerated expectations. All source references below are relative to that reviewed tree unless marked **current**; line numbers are audit anchors, and hashes are the reproducibility authority.

## Findings That Change the Design

1. **Legacy Sort by is primarily grouping.** `ob_apply_timeline_sorting` sets `model.sortBy` (`src/openbexi_timeline.js:399`); `create_new_bands` creates bands from distinct field values using encounter order (`:2247`). It is not a reliable multi-column sort. `sortFilter` in Java reorders saved presets, not timeline records.
2. **Help syntax differs from executed filtering.** Help uses `status=SCHEDULE` (`:492`), but the Java path removes JSON quotes and matches regex against strings containing `status:SCHEDULE`. The decoder does not translate equality signs. L03 returns no records; L04 returns E1, E3 and P1.
3. **A record can be returned twice.** Two matching include conjunctions append the same record twice (L05). New pagination must use unique record identity, not preserve this defect.
4. **Search is contextual, not a membership filter.** Java returns the original record collection and mutates response highlight colors. For parents with activities, it searches children rather than the parent. An authored yellow label is indistinguishable from a search hit to some overview code. Search must instead produce explicit match metadata.
5. **Serialized-JSON matching leaks structure into semantics.** A child type match selects its entire parent payload (L07). A key name, unrelated nested field or formatting detail can affect membership. Replace this with registered, typed fields and explicit relationship rules.
6. **The legacy date test drops spanning sessions and boundary events.** L14 selects only D3; correct half-open overlap selects D1, D2, D3 and D6. This is a deliberate compatibility correction, not a regression.
7. **Client regex support is narrower than it first appears.** The input sanitizer removes anchors/classes and other syntax. `build_sessions_filter` can construct lookaheads from an array, but the inspected ordinary loading call passes an empty string and disables it. Its string-input behavior is not a general query parser.
8. **Current legacy mode rejects nonempty YAML source filters.** This is an explicit fail-closed gap, not working legacy parity. Current canonical catalogs exist, but the legacy configuration service is read-only, including its impact-preview alias. Add an application-owned preferences/catalog boundary rather than enabling writes into the legacy repository.

## End-to-End Legacy Trace

| Stage | Source anchor | Observed behavior and implication |
| --- | --- | --- |
| Model and initial view | `openbexi_test_timeline.html:42`; `openbexi_timeline_earthquake.html:42` | Test page uses `tests/models/regular_timeline.json`; hazards use `models/regular_timeline_earthquake.json`. Audit the loaded model, not just the page name. |
| Discover group choices | JS `ob_get_all_sorting_options:473` | Omits fields with 15+ distinct values, one value, or long names/values; comma splitting makes some values ambiguous. Remove these arbitrary discovery limits. |
| Edit/select/save preset | JS `ob_get_filter_value:512`, `ob_update_filter:569`, `ob_load_filters:582`, panel `:726` | Sanitizes and sentinel-encodes input; selecting a radio can issue `updateFilter` and write preferences. URLs are concatenated, not structured query documents. |
| Search submission | JS handlers `:1382`, `:1535`; `load_data:4693` | Reloads with search/filter/time parameters; some paths reset the temporal anchor. Preserve focus explicitly in the new tool. |
| Decode and split | `data_configuration.java:49`; `data_manager.java:48` | Decodes sentinel strings; splits request at pipes into include/exclude. Additional pipes are not a safe nested-expression grammar. |
| Persist presets | `data_manager.java:132`, `:147`; servlet `ob_handle_http_requests.java:135` | Selected preset moves to the front; JSON stores current flag, grouping and visual settings. Preserve intent using revisions and validation, not raw string-built JSON or user-derived paths. |
| Resolve partitions | `json_files_manager.java:324` | Expands date directories and pads the range. Inspected loop does not enforce each entry's enable/type flag. Do not copy unsafe traversal or accidental disabled-source loading. |
| Query pipeline | `json_files_manager.java:81` | File parsing, date filter, include/exclude filter, search highlight, then merge. Errors/no results can return dummy data. New UI must distinguish empty, loading and failed states. |
| Match records | `json_files_manager.java:579` | Exclude then include; semicolon alternatives and plus conjunctions; regex on serialized objects; duplicate-appending paths; regex compilation per record. |
| Highlight | `json_files_manager.java:418` | Spaces/semicolons become regex alternatives, case-sensitive; `*` bypasses processing. Color mutation is response styling, not reliable match identity. |
| Build layout | JS `init_sessions:3538`, `set_sessions:3577`, `create_sessions:3720` | Flat events become activity-like items; bands follow grouping; overview uses naming/color conventions. Use explicit roles and match IDs. |
| Avoid collisions | JS `get_first_free_tracks:3172`, `get_room_for_session:3218` | Footprints include text widths, track occupancy and activity heights. One namespace group may require many physical rows. |
| Interact | JS `ob_setListeners:4232` | Drag start cancels motion; drag end moves linked bands, updates temporal state and can open descriptors; 5 ms interval momentum depends on displacement. Preserve the feel with frame-based motion, not those timing assumptions. |

Paths abbreviated as Java classes above are under `src/com/openbexi/timeline/data_browser/`, except the servlet under `src/com/openbexi/timeline/servlets/`. `sortByDate` is defined at `json_files_manager.java:24`, but no invocation was found in the inspected source. It is not evidence of stable server record ordering.

## Compatibility Matrix

| Capability | Legacy evidence | Current baseline | Required decision |
| --- | --- | --- | --- |
| ALL combined view | Empty preset filter + NONE grouping | Toolbar and layout support combined view | Preserve selected sources; ALL does not mean every configured path. |
| NAMESPACE and custom grouping | Dynamic bands; eval-based property access | Typed presentation grouping, source palettes, null/missing groups | Preserve group identity; safe pointers only; add friendly field discovery and natural ordering opt-in. |
| Include/exclude | Serialized regex, plus/semicolon conventions | Typed version-1 AST | Add explicit migration diagnostics and version-2 regex nodes, not a second engine. |
| Source YAML filters | Bean preserves fields; inspected JSON pipeline does not reliably apply them | Nonempty values rejected by `legacy_sources.py:214` | Define scoped source predicates explicitly; preview and approve migration; never silently ignore. |
| Search context | Whole collection retained; children highlighted | Literal Any/All/Phrase; match IDs and separate overview | Keep context; add safe regex mode and relationship policy without color-derived membership. |
| Stable sorting | Group encounter order; no demonstrated full record sort | Table: 1-3 fields, ID tie-break, whole-query sorting | Keep table sort separate from timeline packing; extend ordering version explicitly. |
| Null/missing/types | Implicit JSON-string behavior | Registered types, three-valued predicates | Preserve version-1 semantics; add visible operators and clear explanations. |
| Presets/models | JSON preference files and model arrays | Canonical revisioned catalogs, validation and schema publications | Reuse catalogs; legacy-source mode needs separately stored user view settings. |
| Nested sessions | Child match retains parent payload | Canonical parent IDs and nested layout supported | Specify direct hits versus context ancestors and optional family selection; do not infer matches by containment. |
| Rows/pagination | Collision allocation; no demonstrated stable server row cursor | Global allocation and pinned query/layout pages | Add repeated group headers and collapse rules without changing map or dropping rows. |
| Source paths | Date directory templates | Python legacy providers, lazy query preparation | Keep read-only roots, partition coverage and long-session correctness; no archive-wide startup scan. |
| Standalone | Client has local paths with behavior differences | Embedded/imported complete snapshot and local provider | Require identical query semantics and offline-safe regex assets; a cached page is not a full snapshot. |

Current implementation anchors:

- [Typed client predicates](../../client/src/data/filter-expression.js) and [Python predicates](../../server/app/services/filters.py): registered JSON pointers, bounded AST, NFC and shared casefold rules; regex unsupported.
- [Query configuration](../../client/src/data/query-configuration.js): saved publication intersected with transient scope/predicate; explicit search override.
- [Table query](../../server/app/services/table_query.py): full-set sort before paging; present, then null, then missing; scalar fields; stable ID tie-break. Text ordering is codepoint-based, not natural.
- [Client presentation layout](../../client/src/timeline/layout-presentation.js) and [Python presentation layout](../../server/app/services/presentation_layout.py): typed group values, source styles, temporal allocation, measured labels, nesting. These are not table-sort aliases.
- [Filter editor](../../client/src/ui/filter-editor.js): existing nested visual conditions and retained invalid drafts. Extend it rather than replacing it with a second builder.
- [Legacy configuration service](../../server/app/services/legacy_configuration.py): read-only mutation/preview boundary. New preview must not route through a forbidden write method.

## Model and Source Coverage

The hash inventory includes seven production models: `MCC_timeline.json`, `SOC_timeline.json`, `regular_timeline.json`, `regular_timeline_earthquake.json`, `regular_timeline_esoc.json`, `regular_timeline_mcc.json`, `regular_timeline_pov.json`, plus `tests/models/regular_timeline.json`. They share `params` and `bands`, but vary colors, sizes, units, labels and transport/default settings. Hashing and structural inspection do not prove complete model import parity.

Future qualification must dry-run every model and classify every property as mapped, intentionally replaced, unsupported or invalid. A partial preview must show diagnostics; publishing a model with unacknowledged unsupported behavior must fail. Preserve model-defined units, band proportions, zones, fonts, labels, namespace palettes and inspector fields. Old transport/Java settings are migration metadata, not executable instructions.

`C:/data` contains `earthquake`, `volcano`, `SOURCES1` and `SOURCES2`. This pass checked directory availability, not full record coverage. The legacy default-test YAML explicitly disables its SOURCES2 entry; the inspected reader's lack of an enable check must not become the new default. A combined-source scenario must explicitly enable both paths in an application-owned configuration copy. Source YAML filters and UI filters are different scopes.

## Recommended Contract

The normative decisions are in the [implementation prompt](../../OpenBEXI_Timeline_Sorting_Filtering_Prompt.md). In particular:

- Filter membership, search highlighting, logical grouping, table ordering and physical row packing remain five separate concepts.
- Evaluate complete authorized filtered data for the relevant range; derive density before search projection, grouping collapse or vertical paging. No scan of all history is required before the first visible view.
- Version-1 predicates retain their behavior. Version-2 adds explicit regex/relationship/order capabilities with version negotiation, not permissive unknown fields.
- Direct matches, context records and rendered instances have different counts. Export findings never accidentally exports hidden siblings or unauthorized ancestors.
- Legacy JSON is immutable input. Application settings use separate JSON storage with atomic writes, revisions and path restrictions; standalone persists/export settings separately from a complete data snapshot.

## Regex Feasibility and Limits

Use a proven bounded-complexity engine and a documented shared subset, not Java Pattern on one side and JavaScript RegExp on the other. RE2 omits lookaround and backreferences; structured AND/NOT can replace the audited generated lookahead intent without running lookaheads. See [RE2 syntax](https://github.com/google/re2/wiki/Syntax) and [RE2 design and guarantees](https://github.com/google/re2).

The [re2-wasm README](https://github.com/google/re2-wasm) describes Unicode-only execution and differences from native RegExp. It is a feasibility candidate, **not an approved dependency or a demonstrated file:// solution**. Do not copy its suggested native-RegExp fallback. Phase 2 must qualify maintained/pinned Python and browser bindings, common Unicode behavior, worker cancellation, inline WASM initialization, CSP, licenses, bundle cost and offline behavior before selecting packages. Linear-time matching still needs input, memory and aggregate work limits.

Accessible count and loading messages should be announced without moving focus, following [W3C status-message guidance](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html). This is a design requirement, not a claim that the proposed UI has passed accessibility testing.

## Visual Evidence

The [supplied search reference](../ui/v2.2/evidence-search.png) illustrates the historical toolbar, yellow label highlights and findings-only overview. Its capture environment is unverified. Do not confuse images under `docs/ui/legacy/production-source1/` with historical screenshots: their verification records describe the **new** app displaying legacy data.

The new [illustrated specification](../../OpenBEXI_Timeline_Sorting_Filtering_Prompt.md#proposed-interface) includes generic-data design proposals. They are explicitly not screenshots of implemented regex or saved-view behavior. Actual implementation captures and pixel/geometry assertions are a later release gate.

## Four Recommended Phases and Release Status

1. **Stabilize CI.** The post-merge baseline run [34857726943](https://github.com/arcazj/open_timeline2.0/actions/runs/34857726943) has a Windows/Python 3.12 failure: `tests/server/test_authorization_invalidation.py:14` assumes query preparation always returns HTTP 200. It received valid HTTP 202 before testing authorization. Use bounded polling with the same identity headers and add a deterministic held-preparation test. Do not weaken authorization assertions or hide failures with retries.
2. **Implement and verify parity.** Build the versioned contracts, approved legacy migrations, safe regex, separate preferences, grouping/search UX and exact golden/provider tests. Use controlled copies of real source configurations and every model. Correct the documented bugs explicitly.
3. **Optimize measured bottlenecks.** Qualify viewport-first startup, bounded prefetch, complete relevant-range density, cancellation, frame-based motion and offline performance on named hardware/profiles. No claim of unlimited scale or perfect performance.
4. **Qualify a preview release.** Only after green supported-platform gates, publish a deliberately chosen `v0.1.0-preview.1` tag/release with checksums, GPL-3.0-only project license, preserved third-party notices, dataset provenance and explicit limitations. This documentation commit is not that release.

The earlier candidate CI and Pages publication passed, but that does not make the later failing baseline run green. Live demo publication is separate from filtering-parity qualification.
