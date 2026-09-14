# OpenBEXI Timeline: source audit for the rebuild prompt

Prepared 12 September 2026. Purpose: improve the specification before any application code is produced.

Repository: https://github.com/arcazj/openbexi_timeline

Branch/commit inspected: `master` / `cf5d263853e550aab44d3d1959637c1e324b719e`.

The source was obtained in an isolated temporary shallow clone. The workspace's original seven-page `OpenBEXI_Timeline_Rebuild_Prompt.pdf` was read in full. Revision 2.2 also reviews the complete, distinct 17-page `OpenBEXI_Timeline_Rebuild_Prompt_legacy.pdf`, preserved unchanged at the project root. The revised specification is maintained in `../OpenBEXI_Timeline_Rebuild_Prompt.md`; its PDF is generated from that source. The original seven-page brief is preserved at `reference/OpenBEXI_Timeline_Rebuild_Prompt.original.pdf`. Revisions 2.0 and 2.1 are separately retained as Markdown and PDF under `reference/`.

## Scope and limitations

This is a targeted static audit. It establishes what particular source paths do or declare, not what a running deployed instance successfully supports. No legacy build, server, browser workflow, Java test, throughput benchmark, or security scan was executed. No application source was authored or modified. The whole tracked-file inventory was examined; relevant frontend, Java storage/request handlers, configuration/models, examples, test source, and build/deployment manifests were inspected. Large example datasets were sampled for structure and edge cases rather than asserted to be completely valid or fully reviewed.

IDE metadata, generated artifacts, binary icons/screenshots, and bundled certificate material were classified as supporting/non-code material, not treated as executable-feature evidence. Source access and documentation verification do not establish current dependency compatibility. Future M0 work must complete the runtime/coverage inventory and report missing evidence honestly.

## Findings that materially changed the prompt

| Finding | Pinned source evidence | Consequence for the specification |
| --- | --- | --- |
| Empty ends are point-event inputs in rendering, not proof of ongoing sessions. | [Frontend at 3757](https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L3757) branches between event marker and session bar based on the parsed end offset. | Add explicit canonical kind; finite/ongoing sessions are intentional, and migration does not reinterpret empty ends as ongoing. |
| The response variable is called sessions, but it reads `events` and synthesizes singleton activities. Genuine nested activity records also exist. | [Initialization at 3548](https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L3548); [generator at 153](https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/tools/com/openbexi/timeline/event_generator.java#L153). | Preserve actual child IDs/relationships, but never migrate the renderer's synthetic copy as a second authoritative record. |
| The illustrative model is not an authoritative schema. | [Event/session example](https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/json/event_or_session_model.json) uses a `session` envelope and placeholder date strings. | Separate canonical validation schemas from example adapters and visual models. |
| Creation uses hand-built JSON, writes per configured source, and reports success even after caught I/O errors. | [JSON manager at 482](https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/com/openbexi/timeline/data_browser/json_files_manager.java#L482), especially 490, 499, 513-535. | Require one explicit destination, strict serialization, transactions, durable acknowledgement, and fault/retry tests. |
| Update/delete are not implemented as complete JSON CRUD. | [JSON manager at 539](https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/com/openbexi/timeline/data_browser/json_files_manager.java#L539); [servlet at 115](https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/com/openbexi/timeline/servlets/ob_ajax_timeline.java#L115). | Treat full versioned CRUD, tombstones, restoration, and batch commands as new mandatory capabilities. |
| HTTP action dispatch and Swagger do not establish a REST-complete implementation. | [Servlet at 85](https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/com/openbexi/timeline/servlets/ob_ajax_timeline.java#L85); [Swagger at 22](https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/swagger/openbexi_timeline_swagger.yaml#L22). | Define new resource contracts, complete documentation, HTTP preconditions, typed bodies, and server-side permissions. |
| Endpoint-only range filtering misses some enclosing sessions. | [JSON manager at 389](https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/com/openbexi/timeline/data_browser/json_files_manager.java#L389). | Specify half-open overlaps, strict window validation, and queries independent of start-date file placement. |
| The existing visual model contains parameters, bands, overview scale and styling. | [Regular model](https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/models/regular_timeline.json); [band synchronization at 3064](https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L3064). | Preserve bands/overview and distinguish schema, visual model, saved view, grouping and table sorting. |
| Shaded regions, original-time overlays and tolerance graphics are present. | [Regions at 2692](https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L2692), original time at 3463, tolerance at 3667. | Define versioned region annotations; preserve baseline dates and raw tolerance without assigning an unsupported temporal unit. |
| Dragging in the existing handler is not evidence of persisted date editing. | [Drag handler at 4506](https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L4506). | Specify move/resize as new validated commands, with preview, snapping, conflicts, undo and keyboard alternatives. |
| Calendar scaling approximates months/years; time-zone logic is limited. | [Time calculations at 1752](https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L1752); timezone code at 229. | Require actual calendar boundaries, UTC instants, IANA display zones and DST fixtures. |
| Configuration mixes sources, UI defaults, user fields and filters; writes overwrite JSON directly. | [Default filter file](https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/filters/default_filter_setting.json); [data manager at 163](https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/com/openbexi/timeline/data_browser/data_manager.java#L163), write at 299. | Give settings/models/filters separate schemas, ownership, revisioning, precedence and safe persistence. |
| User identity is not established by localStorage or mutable request configuration. | [Frontend identity at 4916](https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L4916); [servlet shared state at 25](https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/com/openbexi/timeline/servlets/ob_ajax_timeline.java#L25). | Specify verified token identity, request-local context, capability checks, revocation and isolation tests. |
| Executable descriptor/configuration evaluation and HTML concatenation occur. | [Descriptor at 1187](https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L1187), eval at 1237, 3565, 4221. | Replace executable customization with typed JSON, safe field access and sanitized content. |
| Description sidecars depend on dates and IDs. | [Descriptor manager at 78](https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/com/openbexi/timeline/data_browser/event_descriptor.java#L78). | Inventory/migrate sidecars by stable identity so changing dates does not orphan details. |
| Examples contain Java-style dates, missing IDs, string numerics, and historical timestamps. | [Test data](https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/json/test.json); [historical data](https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/json/space_exploration.json). | Require explicit adapters, stable import mappings, preserved raw values and no arbitrary 1970 cutoff. |
| A malformed fixture includes point-like parents with distinct nested activities. | [SOURCES1 fixture](https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/tests/data/SOURCES1/2024/03/18/events.json). | Reject malformed JSON first. For an explicitly repaired equivalent, quarantine the aggregate or apply a declared synthetic-container policy; do not silently reinterpret it. |
| Source examples/dependencies include non-JSON connectors. | [Source YAML](https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/yaml/sources_default.yml); [Maven manifest](https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/pom.xml). | Explicitly exclude those integrations and drivers. User-required JSON-only persistence overrides connector preservation. |

## Build, test and deployment evidence

`package.json` declares calendar/Three.js/sprite-text dependencies but no frontend test/build scripts. `pom.xml` declares Java 17, embedded Tomcat, JUnit versions, and MongoDB/Kafka dependencies. Java filtering tests exist, but they were not run. `openbexi_test_timeline.html` is a demonstration entry point, not proof of browser assertions. No tracked CI workflow or JavaScript dependency lockfile was found in the inspected inventory. The Dockerfile references preexisting `lib`, a JAR and `node_modules`; a clean build was not attempted.

These observations justify explicit future installation, runtime, test and performance gates. They do not prove the original application cannot run in its owner's prepared environment.

## Changes from the original brief

- Replaced open-ended database choice and connector preservation with mandatory JSON-only persistence and a single-writer local-filesystem deployment contract.
- Replaced optional/legacy-dependent API wording with required REST CRUD, typed resources, schema/model/filter/settings management, authentication and concurrency contracts.
- Added a recoverable JSON transaction protocol, backup/restore generations, retry ordering, tombstone discovery, root-level control transactions, and bounded atomic batches.
- Defined point events, finite/ongoing sessions, activities, shaded annotations, date boundaries, legacy adapters and exceptional aggregate migration.
- Made timeline/table filtering, ancestor context, selection, snapshots, pagination and live-update behavior consistent under concurrent writes.
- Added concrete proposed performance budgets, implementation milestones, worked contract examples and traceability. Revision 2.0 contained 37 requirement IDs and 32 acceptance scenarios; revision 2.1 extends these to 43 and 44 respectively.
- Kept source-derived facts separate from design defaults and unexecuted future tests. Added the explicit prompt-only gate, Markdown source, preserved original, and visually verified PDF delivery.

## Revision 2.1 additions

- Completed the full `ob_setListeners` source analysis, including picked descendants, target-specific drag/release behavior, synchronization math, clock/inertia, redraw and instance isolation. See the [detailed interaction audit](legacy-interaction-audit.md).
- Made Navigate the default record-drag behavior, with zero record writes; date-changing gestures require explicit Edit mode. Defined CSS-pixel activation thresholds separately from model-coordinate synchronization, overview recentering, cancellation and follow-now policy.
- Inventoried both shipped visual templates, all source-consumed parameters/band/render properties, grouping, discovered field catalogs, data templates, saved settings, JSON source mappings and safe descriptor replacements. See the [model compatibility inventory](legacy-model-compatibility.md), including all 35 recognized custom date formats plus DEFAULT and explicit sentinel diagnostics.
- Required all-model compatibility classification and fixtures, JSON-backed model/schema draft and publication APIs, structured/JSON editors, isolated previews, version comparisons, package mapping and explicit reference upgrades.
- Added six static design screenshots and one separately attributed historical repository image to both Markdown and PDF. The [visual gallery](ui/v2.1/README.md) records provenance and the common 12-record fixture. The proposed screens do not establish implemented behavior or successful migration.
- Reviewed cross-document and image-state consistency: coordinate units, follow-now, overview activation, sorted table slice, draft/reference identity, five-view publication selection, region definitions and chart-label overlap.

## Verification of revision 2.0

Verification is limited to the specification artifacts: full original-PDF text review; pinned source inspection; independent content/contradiction reviews; Markdown-to-PDF text and link checks; page rendering and visual inspection; final file/change review. No application test pass, measured performance gain, or operational JSON-store guarantee is claimed at this stage.

Historical artifact checks for archived revision 2.0: 24 rendered pages visually reviewed; all 439 source text blocks and all 20 explicit reference links retained in that PDF; all 37 requirement IDs and 32 acceptance scenario IDs present in sequence; no missing-glyph replacement characters or text outside the checked page margins. The original was byte-verified before replacement.

Archived revision 2.0 Markdown SHA-256: `716146b5f7ae5d6fd2b1a4e40cc40b3fd9937c1dd0fb932993a7deeeda1b632c`.

Archived revision 2.0 PDF SHA-256: `38b81a5534974ed1bb4688b6334d98860f09fc6c2abbafe2332e5613754ce4cf`.

## Verification of revision 2.1 (historical)

The final PDF has 40 pages: portrait specification pages plus five landscape desktop design plates. All pages were rendered with Poppler and visually reviewed; the changed timeline plate was inspected again after the final label correction. The mobile inspector is on its own portrait page. The PDF retains all 614 checked Markdown text blocks, all 26 explicit Markdown links, all 43 requirement definitions and all 44 uniquely numbered acceptance scenarios. No checked text crosses page margins, no page is blank, and no replacement-glyph character is present.

All seven embedded PDF images were pixel-verified against their Markdown PNG assets: six design mockups and the attributed historical screenshot. The six mockups were captured through Playwright/headless Edge at their declared desktop/mobile dimensions. Capture checks found no JavaScript errors, unresolved Lucide icons, overflowing buttons, offscreen checked controls, or overlapping visible chart labels; document scroll dimensions match each viewport. These are static artifact checks, not interaction, accessibility conformance, performance or application acceptance tests.

Poppler emitted environment warnings for display fonts Symbol and ArialUnicode; the document uses embedded Segoe/Consolas fonts, and text/glyph and visual checks passed. Source-reference validation means URLs were retained in PDF annotations and pinned evidence was inspected, not that every external server was re-tested at delivery time. Companion Markdown links are relative to the project root document; open the root PDF/Markdown with the accompanying `docs/` folder for those local references.

The original and revision 2.0 archive hashes were rechecked. The root PDF and `output/pdf` delivery copy are byte-identical. Only specification documents, static image assets and verification metadata were added or revised; temporary document-rendering helpers remained outside the project. No application code, server, installed application dependencies, database, or runtime test results were produced.

Final revision 2.1 Markdown SHA-256: `0eab8527dc5b813e8152d5fd3f81068d0ae8ed07ea897a9ea0dff29adf0eef90`.

Final revision 2.1 PDF SHA-256: `c8777dd83283e41d53e46e27e6eff29efd067ff65fb48572cb354b9091dc9861`.

## Revision 2.2 additions

- Revisited all 17 pages, figures and numbered requirements in the newly supplied legacy illustrated brief. The [58-item coverage and resolution matrix](legacy-brief-coverage.md) distinguishes historical omissions, current resolutions and intentional scope overrides. The [normative visual contract](legacy-visual-contract.md) preserves exact geometry, tokens, responsive rules and the authoritative 14-record fixture.
- Restored Classic blue as the default visual direction: compact metallic toolbar, colored thin bars and glyphs, grouped bands, reference marker, overview, right calendar/descriptor and equivalent Table shell. Black/neutral and custom models remain first-class. The earlier dashboard-like default is superseded without removing the model-management requirements.
- Traced `get_first_free_tracks`, `get_room_for_session`, text measurement and their callers. The [layout audit](legacy-layout-audit.md) documents a source-derived occupied-track counterexample, font/bounds problems and an overview-scale defect. The new contract requires complete rendered-footprint reservations, positive clearance, stable tracks, accessible full text and projected-geometry tests without changing event dates. The counterexample is static reasoning, not a claimed executed failure.
- Traced the compact menu and server/frontend search flow in the [menu/search audit](legacy-menu-search-audit.md). Retained verified command meanings, contextual detail and yellow search labels, while requiring a findings-only overview based on explicit match IDs rather than stored color or raw regular expressions.
- Added eight static proposed screens: Classic Gantt, Table and Split; dark descriptor and grouped variants; searches `5_1` and `0_3`; and compact filter/model access. The [current gallery](ui/v2.2/README.md) keeps the three user attachments unchanged and distinguishes the exact 14-record Classic fixture from the synthetic 40-record dark fixture. The supplied search attachment visibly demonstrates `5_1`; `0_3` is a separately requested proposed example.
- Added explicit source read-only policy, complete first-party discovery and coverage gates, preference/share-state classification, CI and contribution requirements, fixed seeds and leap-year cases. Ordinary JSON-only persistence, REST CRUD, all-model compatibility and prompt-only authorization boundaries remain mandatory.

## Verification of revision 2.2 (historical)

The final PDF contains 52 pages. Artifact verification retains all 855 checked Markdown text blocks, all 37 explicit links, 48 requirement definitions, 56 uniquely numbered acceptance scenarios and 12 embedded images. Every PDF image was pixel-verified against its source PNG. No checked text crosses page margins, no page is blank, and no replacement-glyph characters were found. All 52 pages were rendered with Poppler and visually inspected, with closer checks of the new visual plates, fixture and search contract. The same environment display-font warnings described above occurred; embedded-font rendering and glyph checks passed.

All eight static mockup captures report no JavaScript errors, unresolved icons, overflowing checked buttons, offscreen checked controls or visible chart label/label and label/mark intersections. The final correction includes each label's own start icon. Capture scroll dimensions match the declared viewports. Classic EVT-004 measured x=720.828125 to 919.484375 CSS pixels, within the specified tolerance. Both search captures retain 40 detail labels and highlight exactly the two expected IDs, which are also the entire overview data layer. These are bounded static-artifact checks, not tests of a reusable layout/search engine or functioning application controls.

The final checks are retained in `specification-v2.2-verification.json` and `ui/v2.2/capture-verification.json`. The complete 17-page brief, original seven-page brief, historical 2.0/2.1 archives and supplied attachments remain preserved. The root PDF and `output/pdf` delivery copy are byte-identical. Only specification documents, static images, design-fixture JSON and verification metadata were authored in the project; temporary document-rendering helpers remain outside it. No application code, server, database, dependency installation or runtime acceptance result was produced.

Preserved 17-page legacy brief SHA-256: `814e8bb6ff57845d6b46092345fed08409e7d452903ad9f27e9f14e9ddcba697`.

Final revision 2.2 Markdown SHA-256: `a24b21e12113afd107f27f18001dd92e9a76ccc29d59879fa9b385ed2d654b1f`.

Final revision 2.2 PDF SHA-256: `2a4de8626549e304c114fe61edffbae54402801161b8840e3d2da1ad76f66fdb`.

## Archived Revision 2.3 additions

- Made the newly supplied two-band screenshots the primary default appearance: light main timeline, smaller synchronized overview, bottom axes, compact labeled points/durations and independently projected translucent zones. The complete Classic blue fixture and dark/model compatibility work remain, with explicit precedence that prevents the former default or scalar mapping from overriding the new one.
- Added a [continuous adaptive-scale contract](adaptive-scale-contract.md), including full-filter density, strictly increasing piecewise mapping/inverse, fixed overview domain, shared endpoint projection, local scale cues, exact main/overview drag and resize formulas, geometry hysteresis and two independent mathematical fixtures. Colored annotation zones, magnified intervals and IANA time zones are explicitly different concepts.
- Added a [server query and row-page contract](adaptive-query-contract.md): complete filtered snapshot statistics, bounded separate overview/detail transfers, server-owned font-aware global tracks, height-based capacity, stable row cursors, explicit payload fragments, query/profile bindings, scoped counts, footprint-only context, cancellation and coherent pinned/live refresh. All caches and durable data remain within the existing JSON-only architecture.
- Added the [G0-G5 integration and code-delivery plan](integration-test-plan.md), with real JSON fault/restart/API tests, browser workflows, all-model coverage, security/accessibility checks, fixed performance tiers, clean-install matrices and commit-bound reports. Mandatory failures, skipped checks and missing evidence cannot be called passed. This is a required future execution plan, not an executed application test report.
- Embedded five new proposed screens and the two unchanged two-band references in Markdown/PDF. The [revision 2.3 gallery](ui/v2.3/README.md) distinguishes the 48-record operational illustration from actual application data and from the older Classic-14/Dark-40 fixtures. Archived revision 2.2 Markdown/PDF are retained under `reference/`.

## Verification of revision 2.3

The final PDF has 68 pages, all rendered with Poppler and visually inspected. It retains all 984 checked Markdown text blocks, all 47 explicit links, all 53 requirement definitions, all 74 uniquely numbered acceptance scenarios and 19 images. Embedded images were pixel-verified against their source PNGs. No checked text crosses margins, no page is blank and no replacement glyphs were found. The known environment-only Symbol/ArialUnicode display-font warnings remain; embedded-font rendering and glyph checks passed.

The five new static captures have no reported JavaScript errors, unresolved Lucide icons, overflowing checked controls, offscreen checked controls or label/label, label/mark or zone-label intersections. A discovered page-two zone-label/bar collision was corrected by reserving the top label strip and recapturing all five states. Desktop capacity is now 15 readable logical rows: 23 records on page one and 15 on page two. Their main geometry, bottom ticks, zone boxes, overview viewport and overview IDs compare exactly. Search highlights two loaded records while the overview contains all five matching IDs. Mobile displays 12 loaded records of 40 in its focused interval, with 48 in the broader overview; one explicitly declared ellipsized label still requires future accessible interaction testing.

Independent document-arithmetic assertions checked the AS-MAP-01 positions/inverse values and the 48-record illustration's unique IDs and exact five Telemetry matches. These assertions and browser captures validate static specification artifacts only. They do not execute a density solver, global row allocator, HTTP server, application interactions, persistence, accessibility conformance or any G1-G5 integration gate.

The two newly supplied screenshots were byte-verified unchanged. The 17-page brief and archived revision 2.2 hashes were rechecked. The root PDF and `output/pdf` copy are byte-identical after delivery. Temporary document-rendering helpers remain outside the project; only documents, static PNGs, illustrative fixture JSON and verification metadata were authored. No application code, application dependency installation, dev server or runtime test results were produced.

Checks are preserved in `specification-v2.3-verification.json` and `ui/v2.3/capture-verification.json`. Final revision 2.3 Markdown SHA-256: `d3a6eb3707becb66bed1e1ca9cfbf21cb98c7dc0946b28719a73c26f96c5c197`.

Final revision 2.3 PDF SHA-256: `293367b5acc25d87add11fb8676fe602e314e3412dba782b7810396527b3a3d1`.

Unchanged two-band duration-reference PNG SHA-256: `ee2ce7b18d8a500bb27901b65f1c9eedf51dcd5a698bf434b6bfad9ae6c2938f`.

Unchanged two-band zone-reference PNG SHA-256: `319801a3f14e6faf82c8466292e8839fc01acfca6a1f6002b8629ad1855154ba`.

## Revision 2.4 Changes

The current main prompt fixes Python/FastAPI/Pydantic/Uvicorn plus modular JavaScript/Three.js, with a generated self-contained HTML build from the same source. The [provider/standalone contract](provider-standalone-contract.md) defines Server and Local query/command parity, complete declared-scope JSON snapshots, RAM-only local edits with explicit JSON export/reimport, resource admission, mandatory complete fallback and controlled reconnect without automatic uploads. Lost server writes have read-only outcome lookup; download requests are not falsely labeled durable saves.

The requested directory tree and directory responsibilities are now explicit. Provider authority resolves earlier server-only density/layout/persistence wording without weakening Server JSON durability/security. All eleven valid time units and inventoried formats remain required; precision-aware continuous viewport transport supplements the unchanged adaptive mapping mathematics. The [coherence audit](revision-2.4-coherence-audit.md) maps the new constraints and corrected older clauses to the requirements and future tests.

The active prompt uses generic event/session visual examples throughout. Sixteen proposed static design targets plus three retained generic user-evidence images are embedded. The [current gallery](ui/v2.4/README.md) adds complete-snapshot, reconnect and all-unit scale-control states to five two-band views; eight Classic/dark/search compatibility targets remain. Original historical-content references and revision 2.3 are preserved in archives, not presented as current example data.

The expanded [integration plan](integration-test-plan.md) requires actual Python/JSON, JavaScript-provider, production browser and direct-file/network-blocked tests. All 59 requirements and 92 acceptance scenarios must receive candidate-bound evidence before implementation completion. This revision remains prompt-only: no application skeleton, code, dependency installation, dev server, runtime integration, storage fault test or performance measurement was produced.

## Verification of Revision 2.4

The final 76-page PDF was rendered with Poppler and visually inspected across all pages, including an independent review of pages 1-40 and full-size checks of the new scale/source/reconnect figures and project tree. The machine check retained all 1,062 Markdown text blocks, 51 explicit links, 59 requirement definitions, 92 unique acceptance scenarios and 19 source images. Embedded-image pixels match the final PNGs; no checked text crosses margins, no page is blank and no replacement characters were found. The known Symbol/ArialUnicode environment display-font warnings did not affect the embedded-font/glyph checks.

Eight current static captures passed fixture ID/count, search membership, row-to-row geometry, label/mark/zone collision, panel/control/text bounds and icon checks. All eleven unit options fit, the Local status text has 20 CSS px right clearance, and the overview stays visible under the source/settings popovers. One deliberate mobile label ellipsis remains documented with its future accessible interaction requirements. The screenshots are document mockups, not a running Three.js application or successful provider test suite.

Final checks are recorded in [specification-v2.4-verification.json](specification-v2.4-verification.json), [capture-verification.json](ui/v2.4/capture-verification.json) and the [coherence audit](revision-2.4-coherence-audit.md). The root/output PDF copies are identical. The 17-page legacy brief and archived revision 2.3 MD/PDF retain their original SHA-256 values. Original historical reference assets remain archived; the active prompt, current gallery and normative companions use generic terminology/data. Git whitespace checking passed with only the existing LF-to-CRLF notice.
