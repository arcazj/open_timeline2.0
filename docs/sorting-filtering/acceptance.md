# Sorting and Filtering Acceptance Plan

Revision 1.0 | Specification, not a report of completed implementation tests.

## Evidence Classes

**Executed now:** the 14 Java and six JavaScript legacy method cases in [evidence.json](evidence.json). They demonstrate the inspected methods only. **Specified below:** future application acceptance outputs. Do not mark them passed until both providers and the real UI execute them. Proposed screenshots are design evidence, not runtime feature evidence.

## Golden Fixture Rules

Use the generic records in [cases.json](cases.json) as conceptual fixtures. For canonical provider tests, normalize through the real legacy adapter and freeze a reviewed alias-to-canonical-UUID map before asserting results. Preserve parent relationships. Do not put aliases such as E1 into production schemas or derive expected results from the same query implementation being tested.

For the examples below, independent records are E1, E2, E3, P1, C1 and C2, where P1 is the parent of C1/C2. All are in the broad March 18 domain. Children inherit source provenance through the adapter, not by copying unauthorized fields. For this target fixture explicitly add `data.namespace = "SOURCE1"` to C1 and C2 in the controlled input copy; the legacy method fixture intentionally omits those fields, so the group expectations below must not be used to assert implicit namespace inheritance. Declare `/data/type`, `/data/status` and `/data/namespace` with the fixture schema. Added ancestors have separate context IDs and are not counted as predicate hits.

| ID | Operation | Required result |
| --- | --- | --- |
| T01 | Empty filter, independent mode | Unique selected set E1, E2, E3, P1, C1, C2; six results. |
| T02 | Type in type0/type1 | E1 and E2 only; two results. |
| T03 | Import `status=SCHEDULE` | Diagnostic `intent_repair_required`; no automatic publication. Proposed equality selects E1, E3, P1. |
| T04 | Two OR branches both matching E1 | E1 appears once; one unique result, not legacy L05's duplicate. |
| T05 | Type equals type9, independent | Direct B = C1; ancestor context A = P1; one predicate result, two available context records. |
| T06 | Same predicate, keep-family mode | Direct predicate hit C1; B = P1, C1, C2; three filter results, two family-context records. |
| T07 | Search `5_1` on title, B = T01 | M = E1, C1; two findings. Main retains six B records. Authored yellow E2 is not a finding. Overview contains only E1/C1 marks plus zones. |
| T08 | Search `SCHEDULE` only on status | M = E1, E3, P1; parent P1 is independently searchable, correcting legacy L11. |
| T09 | Regex `^Activity_(5_1\|0_3)$` on title, case-sensitive | M = E1, E2, C1. E3's longer title is excluded. This table escapes the pipe for Markdown only; pattern bytes contain a plain pipe. |
| T10 | Clear search | Search inactive; overview uses B; all source-authored styles restored. |
| T11 | Group by namespace; codepoint ascending | SOURCE1, SOURCE10, SOURCE2; SOURCE1 contains E1/P1/C1/C2, SOURCE10 E3, SOURCE2 E2. |
| T12 | Same grouping; natural ascending | SOURCE1, SOURCE2, SOURCE10 with unchanged group membership and record counts. |
| T13 | Date case L14, [10:00,12:00) | D1, D2, D3, D6. D4 ends at left; D5 starts at right; both excluded. |
| T14 | Two overlapping OR source scopes | Same canonical record identity emitted once; different records with identical titles remain distinct. |
| T15 | Search with zero hits | B and density unchanged; M empty; overview has no event/session marks, but retains zones and selected range. |

The T09 expected pattern can also be read without Markdown escaping in R4 of [the prompt](../../OpenBEXI_Timeline_Sorting_Filtering_Prompt.md). Search and filter counts must be tested separately from ancestry/render counts.

## Small, Exact Semantic Oracles

Create separate canonical fixtures for these cases so their expectations are obvious:

- Four values for x: A missing, B null, C `""`, D `"ready"`. `exists(x,true)` selects B/C/D; `eq(x,null)` selects B; `not(eq(x,"ready"))` selects B/C. The inspected version-1 implementation treats null versus a non-null equality operand as false, so its negation is true; missing remains unknown and excluded. Add an explicit fixture assertion for this distinction.
- Numeric values A=2, B=10, C=null, D=missing: ascending A/B/C/D; descending B/A/C/D. String `"2"` in that numeric field rejects at validation, not comparison.
- Natural strings A=SOURCE2, B=SOURCE10, C=SOURCE1, D=SOURCE02: natural ascending C/A/D/B. Explicit case-insensitive mode must not alter literal display values. Null/missing groups remain last in either direction.
- Two equal sort keys with IDs ending `...001` and `...002`: ascending ID tie-break in either user sort direction; traversal yields each ID exactly once under every allowed page size.
- Namespace null and missing produce distinct stable typed keys and labels. A literal namespace string `"(missing)"` must not collide with the missing group, even if UI labels need disambiguation.
- Empty tags, null tags, missing tags, `["ready"]` and `["already"]`: exact-member contains matches only `["ready"]`. Wrong array element types reject, not stringify.
- A visible child with a parent in an unauthorized source: no parent ID, title, snippet or aggregate count leaks through ancestry or explanation APIs.

## Migration Oracle

Classify every inspected preset and nonempty YAML filter before enabling it. Golden migration outputs contain original text hash, recognized dialect, proposed AST, schema references, warnings, changed-result IDs and publication eligibility. Ambiguous pipe/plus/semicolon use remains blocked. Empty presets and safe field grouping can be exact structural mappings; repaired help syntax is not labeled exact compatibility.

Per-source fixture: SOURCE1 has records A(type=keep), B(type=drop); SOURCE2 has C(type=drop). SOURCE1's required `type=keep` predicate with both sources selected yields A/C, not A alone. Selecting SOURCE2 only yields C. A disabled source contributes zero records, facets, overview marks and density. A failed required-source predicate never broadens to an unfiltered source.

## Regex Qualification

Require both engines to produce identical membership and structured errors for anchors, alternation, classes, repetition, escapes, Unicode, newlines, flags, full versus search, malformed input, empty-match patterns and resource ceilings. Reject lookaround, backreferences, unsupported inline flags and native-engine fallback. Prove cancellation in an isolated worker/process with bounded test execution; do not run deliberately dangerous legacy regex on user data.

Test engine failure during compile, initialization and evaluation. A failed regex draft cannot replace the applied query. Pin engine/dialect versions in cache and query identity. Bundle all runtime bytes into the standalone build and verify zero requests in file:// mode, including worker/WASM startup. Measure cold initialization and resident memory on each supported browser.

## Pagination and Geometry

Use a fixture with at least three namespaces, 30 truly simultaneous sessions, two long crossing sessions, long multiline labels, icons, baseline geometry, nested sessions and overlapping colored zones. Use capacities 1, 2, 5 and the real viewport-derived value. Very small capacities may require a documented header-compaction rule, but never an empty-progress loop.

Assert complete unique-ID traversal, deterministic global row IDs, repeated headers excluded from counts, group continuation, keyboard next/previous, and no skipped rows. Geometry endpoints and map hash remain invariant during page changes. Search does not change density or map. Group collapse changes row allocation only. Namespace grouping and table sorting cannot alter event timestamps or zone boundaries.

Create pixel/geometry checks in addition to screenshots: canvas is nonblank; visible objects move during dragging; zone edges match the shared mapping within the declared pixel tolerance; labels and markers have disjoint allocated footprints. Capture before and after search, filtering, grouping, manual magnification and pagination on desktop and mobile.

## Async, Live Data and Integrity

Exercise immediate ready and HTTP 202 preparing paths with a deterministic gate, bounded polling, unchanged authorization headers and explicit deadlines. Cancellation, timeout, stale query, expired cursor, source mutation and revoked permissions have separate tests. A slower old response cannot overwrite the new state; an invalid draft does not wipe the valid view.

Hash all test input JSON/YAML/model files before and after startup, search, filtering, preview, save view, export, navigation and shutdown. Required writes are confined to application-owned preferences/cache directories. Verify file races and permission failures are reported without corrupting snapshots. Never publish raw logs containing tokens or private dataset contents.

Verify date-partition coverage with a session starting many days before the view, an empty day, midnight/year boundaries and a changed file. If coverage is incomplete, assert a preparing/incomplete state rather than a false exact count. Startup first paint must not require scanning all historical partitions.

## UX and Performance Targets

These are proposed acceptance targets, not measurements from this audit. Record reference hardware/browser, viewport, dataset hash/size and warm/cold state before evaluating them. A failed target is reported, not hidden by changing the fixture.

- With 10,000 local fixture records, draft feedback target p95 <= 100 ms for ordinary literal edits, with heavier regex preview asynchronous and cancellable. No continuous main-thread block over 100 ms during navigation.
- Warm prefetched panning target p95 frame time <= 33 ms on the documented desktop profile; pointer-down stops momentum by the next rendered frame. Reduced motion suppresses momentum without changing navigation reach.
- First shell target <= 1 second on the reference local machine; first exact visible data target <= 2 seconds when an interval index is ready. Cold index preparation has separately reported progress/timing, never an invented exact result.
- Five task-based sessions: combine two selected sources, group by namespace, find `5_1`, exclude one status, save/restore the view. Target at least four users completing each without assistance; record failures and time, not only satisfaction scores. A developer walkthrough is not a user study.
- Keyboard-only and screen-reader verification: opening/closing editor, nested-rule editing, validation announcements, applying and finding the next result; touch/mobile at 390 x 844; desktop at 1600 x 900. Also verify zoomed text and long labels without overlap.

## Required Implementation Order

1. CI correctness first: repair the baseline immediate-200 assumption without changing the authorization assertions; run Windows/Linux with all supported Python versions.
2. Contract and UX parity next: implement T01-T15, complete typed truth tables, safe regex, migration, saved-view isolation, all-model dry runs, and local/HTTP/browser checks.
3. Performance next: measure and optimize viewport-first loading, bounded caches, density, packing, motion and offline import without changing exact membership.
4. Release last: exact candidate SHA, all matrix gates, verified captures, complete snapshot, notices, checksums, README/demo and an honest limitation list. No tag/release from documentation-only probes.

## Release Evidence Checklist

For each supported model/source/browser/platform, publish pass/fail/not-run with commands, versions and fixture hashes. Separate legacy observations, proposed behavior, executed new behavior and known limitations. Required artifacts include API/schema changes, expected-ID fixtures, migration ledger, regex binding qualification, complete pagination traces, read-only hashes, screenshot/geometry verification and performance distributions. Do not claim all features or models are supported based on one successful screenshot.
