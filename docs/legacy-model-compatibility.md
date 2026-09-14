# Legacy model compatibility and management

Prepared 12 September 2026 for `openbexi_timeline2.0`. Documentation only; no application implementation is authorized by this document.

Baseline: [arcazj/openbexi_timeline](https://github.com/arcazj/openbexi_timeline) at commit `cf5d263853e550aab44d3d1959637c1e324b719e` (`master` when inspected). All source links below are pinned to that commit. The governing implementation requirements are in [OpenBEXI_Timeline_Rebuild_Prompt.md](../OpenBEXI_Timeline_Rebuild_Prompt.md).

Revision 2.4 scope: source evidence below remains historical; the successor uses Python and one modular JavaScript/Three.js frontend, orthographic by default. The main specification and [provider/standalone contract](provider-standalone-contract.md) govern operating modes. References below to API authorization, durable JSON commits, reload persistence and server management tests apply to Server mode. All common model-library, structured/JSON editor, validation, preview, diff, publication, reference-safety and import/export workflows also operate through Local commands over a complete embedded/imported snapshot. Local changes remain in memory until explicit JSON export/reimport and cannot claim a server commit, verified server identity or automatic synchronization. Server-only account/root administration is capability-limited, not a reason to omit local model management. Historical template dimensions and cameras are compatibility cases, not authority to override the current generic two-band default or provider-driven row pagination.

Current implementation boundary: the [versioned catalog contract](model-catalog-contract.md) now admits nine required visual settings plus the optional [presentation v1 extension](presentation-contract.md). Implemented presentation includes independent band palettes/axes/formats, source styles, safe data-pointer grouping, text-only inspector fields, four measured Noto Sans normal/italic 400/700 profiles, multiline labels, approved per-record icons, baseline geometry and nested enclosure continuation. Browser Local mode runs the same provider in an embedded Blob worker with a direct startup fallback; see [standalone mode](standalone-mode.md). These are bounded capabilities, not completion of every Map/Translate target below. Perspective, arbitrary assets/font families, full source/schema management and complete production/test-template conversion remain unresolved. The dry-run legacy adapter reports mapped pointers and blocked/redacted losses; it does not silently activate a fully converted legacy model.

## Evidence and compatibility boundary

This is a static source audit, not a claim that the legacy application was built or run. The tracked model files and both HTML entrypoints were read completely. The relevant frontend loading, defaults, grouping, rendering, time-format, descriptor and saved-setting paths were traced. Model-relevant source configurations, data templates and saved-setting files were inspected. No browser screenshot, unit-test pass or runtime compatibility result is claimed here.

Support all source-verified model families and capabilities, including both shipped visual templates and valid customized variants of the fields consumed by the renderer. Do not reduce compatibility to one default screenshot or one file named `regular_timeline.json`. A model name, declared property, icon, array shape or function argument alone is not evidence that its intended behavior works.

Every imported property must receive an explicit disposition. Preserve useful semantics through typed v2 definitions; retain raw provenance for ignored, overwritten, unsupported, unsafe or ambiguous properties. Never silently drop fields, execute a legacy expression, or claim a working capability where only a placeholder exists. Fixing an incorrect default or date calculation is compatible with preserving the user's intended model; reproducing the defect is not required.

The events/sessions store remains ordinary JSON files only. The legacy name `data_model` denotes a source path template; it does not authorize MongoDB, Oracle, Kafka, Elasticsearch, SQLite, another database, a broker, or a hidden persistent index. Non-JSON connector definitions are excluded from runtime configuration. Their presence in an imported package must be reported explicitly, with secrets excluded from diagnostic exports.

## Model-family inventory

| Family / inventory | Source evidence and observed shape | V2 treatment |
| --- | --- | --- |
| Production visual template | [models/regular_timeline.json][production-model]: `{params: [...], bands: [...]}`; current-time date, width 2000, height 1000, HOUR primary and DAY overview. | Import as a named visual model with separate view defaults and JSON-source binding. |
| Test visual template | [tests/models/regular_timeline.json][test-model]: same envelope and `params[0].name`, fixed `Mon Mar 18 2024 20:00:00 UTC`, width 1350, ports 8442/8441, different primary background. | Preserve as a distinct fixture/model identity. Its identical basename and authored name must not overwrite the production template. |
| HTML entrypoints | [Production HTML][production-html] and [test HTML][test-html] each construct a timeline and load their corresponding JSON template. | Both are inventory entries. Neither contains an additional inline visual-model definition. |
| Visual-model loading | [loadModel at 4939][j4939] checks only truthiness of `params`/`bands`, assigns them, and overwrites authored title/data before initialization. | Validate complete shape and every property; preview a staged candidate; apply explicitly without silently rewriting the submitted model. |
| Band grouping model | [Grouping at 2248][j2248] consumes `band.model[0].sortBy`; distinct `record.data` values create lanes. | Typed grouping definition, stable lanes, explicit no-grouping state and separate table sorting. |
| Discovered field/value model | [build_model at 4171][j4171] builds a transient Map from record `data`; [picker at 473][j473] derives grouping choices from it. | A schema-aware field catalog covering all permitted fields, including sparse and later-arriving fields. It is not an authoritative persisted schema. |
| Illustrative data model | [json/event_or_session_model.json][data-model] uses `session`, placeholder dates, domain fields and `render`. | Explicit data adapter into canonical records and custom-field schemas; do not parse placeholders as real records or treat the file as JSON Schema. |
| Record/aggregate presentation | [Render overrides at 3714][j3714], [session enclosure at 3808][j3808], [region rendering at 2692][j2692]. | Validated per-record overrides, parent enclosure presentation and explicit shaded-region annotations; no duplicate authoritative record data. |
| Saved view/filter state | [Default][filter-default], [guest timeline 2][filter-guest], [test timeline 0][filter-test0], [test timeline 2][filter-test2] combine `openbexi_timeline`, sources, layout, camera, background, named filters and grouping. [Consumer at 2873][j2873]. | Import all four fixtures into separately defined views, filters and settings, preserving their relationships and selected state. Map ownership explicitly; imported usernames are not identity proof. |
| JSON source path/render model | [Startup YAML][sources-startup], [test YAML][sources-test], [tests YAML][sources-tests], [default connector examples][sources-default]; `data_model` is a path template, while source render values influence lane colors through [2140][j2140]. | Administrator-controlled offline JSON path mapping; logical source IDs and allowed source styles in v2. Canonical record locations remain ID-based. |
| Descriptor/inspector model | `params[0].descriptor` is read at [238][j238], and its custom branch uses `eval` at [1187][j1187]. [Descriptor sidecars][descriptor-source] depend on dates and IDs. | Declarative inspector layouts and stable-ID details migration. Preserve raw legacy references in restricted provenance; never evaluate them. |

The tracked standalone visual-model inventory contains exactly the production and test files above. Additional customized models may exist outside the repository; support them by validated property/shape compatibility, not by assuming their contents have been audited. Arbitrary filenames are allowed as import provenance and must not be used as canonical model identity.

## Disposition vocabulary

Each property row below describes observed legacy handling and its required semantic mapping, not an assertion that the entire target is implemented. The current catalog/presentation contracts bind the implemented subset to exact schema pointers and provider fields; remaining M0 targets still require that binding before implementation. Preserve this historical source inventory rather than treating its proposed vocabulary as a competing current JSON schema.

| Disposition | Meaning |
| --- | --- |
| Map | Preserve the supported meaning in a typed v2 field, with validation and fixtures. |
| Translate | Convert a legacy spelling, mixed type, combined concept or source binding explicitly. Preserve original value and rule. |
| Correct | Preserve intended behavior while replacing an observed defect; document the difference. |
| Provenance | No demonstrated authored effect, ambiguous meaning or unsupported value. Retain the raw value and diagnostic; do not advertise it as implemented. |
| Replace unsafe | Use a declarative safe equivalent where meaning can be established; never execute the original value. |
| Derived | Recompute runtime state; exclude it from authored definitions and report its removal from imported runtime snapshots. |

Unknown fields cannot be silently discarded. The import report must preserve their JSON pointers and raw values under the applicable provenance policy. Any security-sensitive value is redacted or stored only in restricted source material, not copied into public model metadata.

## Parameters: complete authored-key inventory

Only `params[0]` is consumed by the inspected initializer. Additional entries are not demonstrated support for multiple independent timelines; preserve and diagnose them rather than silently taking the first. Parameter reads/defaults are at [238][j238]; geometry fallbacks are at [332][j332]; time selection is at [147][j147] and [229][j229].

| Legacy key | Observed handling/default | Disposition and v2 target |
| --- | --- | --- |
| `name` | Identity; no explicit initializer default. | Map to model/view metadata; new stable ID is independent of this name. |
| `date` | `current_time` or `Date.now()` means now; a four-character value takes the year branch; otherwise date parsing. | Translate to explicit initial-time/follow-now preference; never evaluate string contents. |
| `timeZone` | Reset to empty/browser-local unless date contains `UTC` or this value equals `UTC`. Other IANA names are not implemented here. | Correct into explicit display-zone preference, with a documented local-zone migration rule. |
| `title` | Initial default `""`; overwritten by `loadModel()` report titles at [4958][j4939]. | Map authored title; report that v2 preserves a value the old loader overwrote. |
| `data` | String URL with substitution; `loadModel()` replaces it through endpoint discovery. | Translate to approved logical JSON-source binding. Never accept arbitrary network/file access through model import. |
| `data_default_port` | Used for URL substitution/switching; no explicit default. | Translate administrator transport mapping separately from visual definition; not a model-controlled server port. |
| `data_sse_port` | Used for URL substitution/switching; no explicit default. | Translate administrator stream binding separately from visual definition. |
| `camera` | Undefined later becomes Orthographic; exact `Orthographic` selects that camera, other values enter Perspective branch at [4575][j4575]. | Map recognized Orthographic/Perspective values; diagnose unknown values instead of accepting the old fallback. |
| `descriptor` | Undefined selects built-in inspector; provided string is transformed/evaluated at [1234][j1187]. | Replace unsafe with a declarative inspector field/layout definition. |
| `top` | Integer parsing; missing/invalid default 0. | Translate to supported view placement/responsive layout preference. |
| `left` | Integer parsing; missing/invalid default 0. | Translate to supported view placement/responsive layout preference. |
| `width` | Integer parsing; ordinary missing default 1350, exception default 800 despite inconsistent log text. | Correct to a validated responsive size/preference; record the source value/default used. |
| `height` | Integer parsing; missing/invalid default 800. | Map to validated view height/responsive constraints. |
| `backgroundColor` | Preferred background; falls back to `color` when undefined. | Map to visual background style subject to effective-setting precedence. |
| `color` | Alias fallback for absent `backgroundColor`; exception fallback white. A first-band color can later supply background at [2463][j2460]. | Translate alias explicitly; diagnose conflicting authored aliases. |
| `fontSize` | Numeric/numeric-string intended; default 12. `"12px"` fails the `isNaN` guard and defaults. | Correct to a bounded numeric font-size value; document string/unit conversion. |
| `fontFamily` | Default `Arial`. | Map to approved font selection and fallback. |
| `fontStyle` | Default `Normal`. | Translate to typed normal/italic-style selection. |
| `fontWeight` | Default `Normal`. | Translate to approved typed weight. |

These are all 19 `params[0]` keys consumed by the inspected source. No parameter supplies an independent database model.

## Bands: complete authored-key inventory

Core defaults are at [2460][j2460]. Layout height handling is at [2307][j2307], geometry consumption at [2720][j2720], label placement at [3140][j3140], and record styles at [3714][j3714]. Falsy values are frequently replaced using `||`; v2 must validate explicitly instead of treating every zero/empty value as missing.

| Legacy key | Observed handling/default | Disposition and v2 target |
| --- | --- | --- |
| `name` | Identity and role by names matching `overview_`; some later paths inconsistently match `_overview`. | Translate to stable band ID, authored label and explicit primary/overview role. |
| `height` | Overview accepts percentage/pixel strings; primary height is recalculated from content; missing height derives from scene. | Translate to explicit fixed/relative/content sizing with bounds; preview differences. |
| `color` | Band background; source/group overrides or default black. | Map to band/lane background style. |
| `textColor` | Source/group overrides or default black. | Map to band/lane label style. |
| `dateColor` | Source/group overrides or default black. | Map to axis text/tick style. |
| `SessionColor` | Exact capital S; source/default black when falsy. | Translate to canonical session-color style. |
| `eventColor` | Source/default black when falsy. | Map to point-event color style. |
| `sessionHeight` | Default 10; zero replaced by default. | Map to bounded duration-bar height. |
| `defaultEventSize` | Default 5; zero replaced by default. | Map to bounded point-marker size. |
| `fontSize` | Parsed integer or timeline fallback; legacy string assembly can append `px` to an already suffixed fallback. | Correct to bounded numeric label size. |
| `fontSizeInt` | Derived/overwritten from `fontSize` or timeline integer value. | Derived; not a second authored size. |
| `fontFamily` | Inherits timeline value when falsy. | Map to label font override. |
| `fontStyle` | Inherits timeline value when falsy. | Map to label style override. |
| `fontWeight` | Inherits timeline value when falsy. | Map to label weight override. |
| `intervalPixels` | Default string `"200"`; downstream numeric parsing. | Translate to positive numeric scale spacing. |
| `intervalUnit` | Default `MINUTE`; trimmed, case-sensitive unit lookup. | Translate through the interval-unit manifest below. |
| `dateFormat` | Default `DEFAULT`; finite custom-format branches. | Translate through the explicit format manifest below. |
| `intervalUnitPos` | Exact `TOP` means top; all other values mean bottom. | Translate to an explicit validated axis-position enum. |
| `subIntervalPixels` | Undefined/`NONE` disables; otherwise HOUR with intervalPixels >=60 forces intervalPixels/4. Other values are integer-parsed. `AUTO` has no general implementation. | Correct to explicit disabled/automatic/fixed subdivisions, preserving valid spacing intent. |
| `texture` | Falsy becomes undefined; presence triggers hardcoded cubemap, not the supplied asset path. | Translate to a validated material/asset reference with missing-asset diagnostics. |
| `defaultSessionTexture` | Assigned/defaulted; no downstream consumer found. | Provenance; do not claim an independent legacy texture capability. |
| `image` | Per-band icon fallback for records; resolves against a preloaded icon Map. | Map to approved icon/asset reference, with explicit unavailable-asset fallback. |
| `textBackgroundColor` | Optional label background; record render handling can reset it to false. | Map to label-background override with corrected, documented inheritance. |
| `luminance` | Read locally but not forwarded to record-render calls. | Provenance; a new supported style requires an explicit v2 schema and test. |
| `opacity` | Read locally but not forwarded to record-render calls. | Provenance; do not imply the imported value already affected legacy records. |
| `x` | Integer default -10000, then centered/repositioned at [1982][j1982]. | Derived placement in v2; retain original as provenance if imported. |
| `y` | Recomputed from band/content layout. | Derived; not independent authored placement. |
| `z` | Integer default 0; used in geometry/depth ordering. | Translate to safe layer/depth configuration where relevant to camera mode. |
| `depth` | Integer default 0; geometry helpers have their own undefined fallback. | Translate to bounded rendering depth/layer intent; not arbitrary geometry injection. |
| `width` | Overwritten to 100000, then derived from viewport times multiples. | Derived; do not treat the submitted width as honored. |
| `multiples` | Overwritten from scene; scene initially uses 22, saved settings can replace it. | Translate performance/viewport-buffer intent separately from authored time scale. |
| `trackIncrement` | Overwritten from scene increment, initially 20; overview calculation can replace it. | Translate lane spacing as an explicit validated v2 control; report old overwrite. |
| `model` | Array; only first element consumed. | Translate its supported grouping meaning as specified below. |

Do not persist the following additional runtime band state as authored model configuration: `gregorianUnitLengths`, `heightMax`, `heightMin`, `iniMinDate`, `iniMaxDate`, `lastGreaterY`, `layout_name`, `layouts`, `layouts.max_name_length`, `maxDate`, `maxY`, `minDate`, `minViewOffset`, `minWidth`, `minY`, `pos_x`, `pos_y`, `pos_z`, `position`, `sessions`, `track`, `viewOffset`, `zones`. The array also receives `original_length` and `updated` internal properties. Recompute them from definitions, viewport and authorized committed records. References: [1752][j1752], [1982][j1982], [2164][j2164], [2307][j2307], [3538][j3538].

## Band grouping and field discovery

| Legacy key/concept | Observed behavior | Required mapping |
| --- | --- | --- |
| `band.model[0].sortBy` | Only consumed model-object key. Missing model defaults to `NONE`; reads a field under `record.data` using `eval`. First-band records build distinct lanes; numeric values get a field-name prefix. | Typed grouping field/path, no-grouping state, deterministic typed lane keys/order and missing-value behavior. Never execute the legacy path. |
| `band.model[0].alternateColor` | Declared in both templates; no consumer through `band.model`. Actual alternation derives luminance at [2224][j2164]. | Retain raw provenance; offer explicit validated alternating-lane colors as a v2 capability without claiming this legacy value worked. |
| `band.model[1...]` | No consumers found. | Diagnose/preserve additional entries; do not silently drop them or invent multi-level legacy grouping. |
| Saved `sortBy` | Saved workspace-level then active-filter `sortBy` overwrites first-band grouping at [2873][j2873]. | Preserve filter/view grouping precedence; table sort remains a separate definition. |
| Discovered `model` Map | Excludes `title`, `description`, `analyze`, `sortByValue`; aggregates values through comma strings/substrings. Later new fields can be missed. | Complete schema-aware field catalog and typed distinct-value service; preserve excluded domain fields in records. |
| Picker restrictions | [473][j473] requires multiple values and imposes <15 name/value-length/count heuristics. | Do not carry arbitrary discovery limitations into schema validity or configurable grouping. Use explicit supported-type/capability rules and pagination. |

Source render accessors recognize `color`, `textColor`, `dateColor`, and `alternateColor` at [2140][j2140]. Observed callers use the first three; the accessor's existence alone does not prove the source alternateColor is applied. Source-based lane-color intent remains part of the import map.

## Per-record render inventory

This includes genuine child records, parent session presentation and shaded-region source records where noted. The primary override block is [3714][j3714]; material/icon consumption is [3884][j3884] and [3992][j3992].

| Legacy key | Observed effect/default | Disposition and v2 target |
| --- | --- | --- |
| `color` | Overrides event/session color; also parent enclosure, tolerance graphics and shaded-region color. | Map to the corresponding typed record/annotation style; preserve scope. |
| `textColor` | Overrides band label color. | Map to label override. |
| `fontSize` | Overrides band integer font size. | Map to bounded numeric label size. |
| `fontWeight` | Overrides band label weight. | Map to approved label weight. |
| `fontFamily` | Overrides band label font. | Map to approved font/fallback. |
| `fontStyle` | Overrides band label style. | Map to typed label style. |
| `backgroundColor` | Label background; if `render` exists but this key is absent, value becomes false rather than inheriting band background. Also written by legacy search highlighting. | Correct inheritance explicitly. Imported intended style is durable; search/selection highlights are transient and never persisted. |
| `image` | Overrides band icon; preloaded icon Map or point sphere fallback. Sessions can receive an icon near their start. | Map approved icon IDs/assets with preview and missing-asset diagnostics. |
| `texture` | Overrides band texture presence; session rendering uses hardcoded cubemap. | Translate material intent to approved assets; do not execute/fetch arbitrary input. |
| `luminance` | Read but not passed to event/session rendering calls. | Provenance; no demonstrated authored effect. |
| `opacity` | Read but not passed; parent enclosure defaults to 0.35 at [3808][j3808], independent of this value. | Provenance; a v2 opacity control must be explicitly defined/tested. |
| `textBackgroundColor` | Consulted only when deciding whether searched overview parent enclosures render at [3786][j3786]. Not the general label-background alias. | Translate only established meaning, otherwise provenance/diagnostic. Do not silently merge with `backgroundColor`. |

No custom executable renderer belongs in a visual-model JSON document. Parent enclosure/material and inspector customization must use declarative schemas and approved assets.

## Complete date-format manifest

The source implements a finite case-sensitive formatter at [1834][j1834]. It first picks a separator by searching the entire format: space by default, slash if any `/` is present, then hyphen if any `-` is present. Expanding its comparisons gives these exact 35 accepted custom strings:

```text
MM/dd/yyyy/hh:mm | MM/dd/yyyy-hh:mm | MM-dd-yyyy hh:mm
dd/MM/yyyy/hh:mm | dd/MM/yyyy-hh:mm | dd/MM/yyyy hh:mm
MM/dd/hh:mm | MM/dd-hh:mm | MM/dd
mmm dd | mmm/dd
dd hh:mm | dd/hh:mm | dd-hh:mm
ddd dd hh:mm | ddd dd/hh:mm | ddd dd-hh:mm
mmm/dd/hh:mm | mmm/dd-hh:mm
dd/MM/hh:mm | dd/MM-hh:mm
mmm | MM
yyyy MM | yyyy/MM | yyyy-MM
yyyy mmm dd | yyyy/mmm/dd | yyyy-mmm-dd
yyyy mmm | yyyy/mmm | yyyy-mmm
yyyy | UTC | ISO
```

`DEFAULT` is a separate axis-label mode at [1932][j1932]. Unknown formats fall back to a local hour; they are not arbitrary supported formatting-library patterns. For example, `MM/dd/yyyy hh:mm` does not match the source's constructed first comparison despite looking conventional.

Migration must map every recognized token to a documented v2 format or an explicit diagnostic with original text. Preserve formatting intent while correcting these source defects: `hh` actually means 24-hour hours; numeric month/day output is not consistently padded; `yyyy MM`, `yyyy/MM`, and `yyyy-MM` use zero-based `getMonth()`; separator detection is not a general parser. Do not copy those accidental outputs as normative v2 behavior. All proposed mappings need representative-date fixtures and preview output.

## Complete interval-unit manifest

The table at [1752][j1752] trims the unit string but is case-sensitive. Unknown values fall back to the HOUR length; the default band setting is MINUTE.

| Unit | Legacy milliseconds/meaning | V2 disposition |
| --- | --- | --- |
| `MILLISECOND` | 1 | Map within supported timestamp precision. |
| `SECOND` | 1000 | Map. |
| `MINUTE` | 60000 | Map. |
| `HOUR` | 3600000 | Map. |
| `DAY` | 86400000 | Correct calendar tick boundaries for the selected zone. |
| `WEEK` | 604800000 | Map with an explicit week-start/calendar policy. |
| `MONTH` | 31 days | Correct to actual calendar boundaries. |
| `YEAR` | 365 days | Correct to actual calendar boundaries. |
| `DECADE` | 3650 days | Map calendar decade scale within supported date range. |
| `CENTURY` | 36500 days | Map calendar century scale within supported date range. |
| `MILLENNIUM` | 365000 days | Map calendar millennium scale within supported date range. |
| `EPOCH` | -1 sentinel | Provenance/explicit unsupported-value diagnostic; not verified usable scale behavior. |
| `ERA` | -2 sentinel | Provenance/explicit unsupported-value diagnostic; not verified usable scale behavior. |

`DEFAULT` labels explicitly handle CENTURY, DECADE, YEAR, MONTH, DAY, HOUR, MINUTE and SECOND; other values use a generic Date string. CENTURY/DECADE multiply the calendar year by 100/10 at [1949][j1932], an observed defect to correct. A recognized scale name must not imply unlimited geological time support beyond the canonical timestamp contract.

## Migration coverage manifest contract

M0 must produce a machine-readable JSON coverage manifest alongside this human-readable audit. This document defines the contract; it does not supply application code or claim the future manifest/tests already exist. One entry is required for every inspected model artifact and every encountered property JSON pointer, including array elements, unknown keys and runtime-only state.

| Manifest field/group | Required information |
| --- | --- |
| Baseline | Repository URL, pinned commit, audit date, adapter/manifest version, source artifact path and checksum. |
| Artifact identity | Full source path, authored name, model family, production/test/user origin and deterministic import identity. Never identify by basename alone. |
| Property identity | Exact source JSON pointer/key, original value/type or restricted/redacted provenance reference, and whether declared, consumed, overwritten, ignored, unsafe, derived or unknown. |
| Evidence | Exact source consumer/default path and line, evidence type, inspected coverage and limitations. Explicitly label static analysis versus later runtime observation. |
| Mapping | Disposition, exact v2 schema pointer once finalized, conversion/default rule, target model/schema/view/source IDs and version dependencies. |
| Diagnostics | Stable code, severity, readable reason, required review, unsupported/unsafe value handling and whether publication is blocked. |
| Dependencies | Referenced schemas/models/filters/groups/sources/approved assets; resolved, remapped, missing or rejected state. |
| Verification | Fixture/test IDs, expected semantic result, actual status (`not-run`, `passed`, `failed`, `blocked`) and later evidence artifact links. |
| Coverage | Counts by family/disposition, unmapped pointers, unresolved dependencies and failed mandatory fixtures. No aggregate pass may conceal an unmapped supported capability. |

Dry-run import leaves originals untouched. A repaired legacy file is a separate artifact with its own checksum/change log. Preview all effective settings and differences before applying. Package import uses complete deterministic ID/reference remapping, workspace authorization, size limits and the governing JSON transaction protocol; a collision cannot overwrite another model implicitly.

A package containing excluded connectors, executable descriptors or unsafe paths does not acquire permission to activate them. Preserve a restricted provenance record and return actionable diagnostics; required supported visual/data capabilities still need a mapped safe result. Do not silently replace an unmappable filter with ALL, an unknown unit with HOUR, or a missing model with the default template.

## Model-management acceptance checklist

These are future acceptance requirements, not tests executed during this audit. Every management operation must exist through both the UI and documented authorized API. Validation and preview remain read-only until an explicit apply/publish command.

- [ ] A searchable catalog lists visual models and data schemas distinctly, with stable ID, name, description, tags, owner, visibility, lifecycle, definition version and metadata revision; the two `regular_timeline.json` fixtures remain distinct.
- [ ] Users can create, duplicate, rename metadata, edit a draft, validate, preview, diff versions, publish, archive, export/import and inspect usage/dependencies according to capability rules.
- [ ] Structured controls and a JSON editor use the same schemas and error locations. All supported bands, scales, grouping fields, colors, fonts, labels, icons, regions, inspector layouts and table-related definitions have usable controls and persisted results.
- [ ] Preview covers events, finite/ongoing sessions, nested activities, sparse custom fields, shaded regions, long labels, dense overlap, Timeline/Table/Split views and permitted camera modes using representative authorized data or explicit fixtures.
- [ ] Publishing installs one complete validated definition version atomically. Existing records/views remain pinned; updates require explicit selection or migration. Concurrent edits conflict through the shared generation/revision rules.
- [ ] Usage and impact views identify live/restorable references, incompatible schemas, missing fields/assets, saved-filter/column effects and proposed remapping before an upgrade or deletion.
- [ ] Rollback selects or publishes a version through a new audited action; it does not rewrite immutable history. Referenced versions cannot be deleted; archival does not break existing use.
- [ ] Export/import retains all supported settings and dependencies or provides explicit unresolved-dependency diagnostics, with complete ID mappings and no external database/broker requirement.
- [ ] Every source property above and every additional encountered pointer has a coverage-manifest entry. Ignored/overwritten/unsafe/unknown fields remain visible in diagnostics and provenance instead of disappearing.
- [ ] Both shipped templates and valid customized variants pass migration, validation, preview, publication, restart and round-trip fixtures. Source name/filename collisions, wrong types, unknown fields, extra array entries and malformed JSON are tested.
- [ ] Format fixtures cover all 35 custom strings plus DEFAULT, supported interval units, calendar corrections and explicit EPOCH/ERA diagnostics; undocumented hour fallbacks are eliminated.
- [ ] Property fixtures cover sparse/mixed field catalogs, no-grouping and typed grouping, saved-filter precedence, styling inheritance, unavailable assets and safe replacements for executable descriptors.
- [ ] Unauthorized catalog entries, model versions, previews, references and assets are not disclosed. Revocation and workspace boundaries apply to all management operations.
- [ ] Mandatory model-capability coverage and management workflows pass before release acceptance. A working default template alone does not satisfy support for all models.

## Pinned source links

[production-model]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/models/regular_timeline.json
[test-model]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/tests/models/regular_timeline.json
[production-html]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/openbexi_timeline.html#L34
[test-html]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/openbexi_test_timeline.html#L34
[data-model]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/json/event_or_session_model.json
[filter-default]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/filters/default_filter_setting.json
[filter-guest]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/filters/guest_ob_timeline_2_filter_setting.json
[filter-test0]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/filters/test_ob_timeline_0_filter_setting.json
[filter-test2]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/filters/test_ob_timeline_2_filter_setting.json
[sources-startup]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/yaml/sources_startup.yml
[sources-test]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/yaml/sources_default_test.yml
[sources-tests]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/tests/yaml/sources_default_test.yml
[sources-default]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/yaml/sources_default.yml
[descriptor-source]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/com/openbexi/timeline/data_browser/event_descriptor.java#L58
[j147]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L147
[j229]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L229
[j238]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L238
[j332]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L332
[j473]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L473
[j1187]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L1187
[j1752]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L1752
[j1834]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L1834
[j1932]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L1932
[j1982]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L1982
[j2140]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L2140
[j2164]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L2164
[j2248]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L2248
[j2307]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L2307
[j2460]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L2460
[j2692]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L2692
[j2720]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L2720
[j2873]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L2873
[j3140]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L3140
[j3538]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L3538
[j3714]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L3714
[j3786]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L3786
[j3808]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L3808
[j3884]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L3884
[j3992]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L3992
[j4171]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L4171
[j4575]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L4575
[j4939]: https://github.com/arcazj/openbexi_timeline/blob/cf5d263853e550aab44d3d1959637c1e324b719e/src/openbexi_timeline.js#L4939
