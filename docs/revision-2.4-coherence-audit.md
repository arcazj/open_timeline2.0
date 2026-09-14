# Revision 2.4 Coherence Audit

Prepared 12 September 2026. This is a documentation review of the current [main specification](../OpenBEXI_Timeline_Rebuild_Prompt.md), not application implementation or executed acceptance evidence. Review covered the main document's existing and new requirements against the [provider contract](provider-standalone-contract.md), [adaptive scale](adaptive-scale-contract.md), [adaptive query](adaptive-query-contract.md), [integration plan](integration-test-plan.md), and relevant legacy model/visual compatibility boundaries.

## Review Result

The current contracts consistently require a Python server, one modular JavaScript/Three.js client, the orthographic two-band default, and a generated self-contained Local application. No unresolved must-fix contradiction was identified after the bounded corrections below. This means the reviewed specification is internally coherent; it does not establish that the proposed architecture, performance, filesystem protocol or browser behavior has been implemented or validated.

Sections 59-65 govern operating-mode and stack precedence. Server-only HTTP, authorization, durable journal, restart, backup and multi-user requirements remain mandatory for Server mode. Common record/configuration/model workflows also operate in Local mode, with separate source identity, memory-only revisions and explicit JSON export/reimport. The historical blue scalar fixture and dark/custom capabilities remain compatibility obligations, not competing defaults or nonlinear mapping formulas.

## New-Requirement Coverage

| Concern | Governing requirement and future evidence |
| --- | --- |
| Fixed backend and one JSON writer | REQ-05/54, sections 03/59; A75; G1/G2/G5. Python/FastAPI/Pydantic/Uvicorn replaces Java/Tomcat without a database runtime or multiple writers per root. |
| Shared modular client and generated artifact | REQ-55, section 60; A76; G1/G5. Prescribed modules, shared schemas/fixtures, lockfiles and build script produce dist/index.html without a second maintained UI. |
| Orthographic Three.js and generic two-band UI | REQ-49/54, sections 46/59; A57/A77/A89/A91. Optional cameras and Classic/dark models remain explicitly supported compatibility cases. |
| Direct-file dependency closure | REQ-57, section 62; A77/A90/A92; integration-plan section 8. Copy only HTML, block external networking, remove siblings/caches and exercise real workflows with all required assets embedded. |
| Complete Local data, not server-page cache | REQ-56/57, sections 61/62; A78-A80. Validate a complete declared workspace/source-set universe and dependency manifest before atomic activation; partial pages and selected/time/search subsets cannot impersonate completeness. |
| Complete coherent Server export | REQ-57 and provider section 3; A79. Pin authorized scope/revision, include relationships/definitions/assets, reject missing or denied dependencies, preserve integrity and explicit provenance. |
| Equivalent Python/JavaScript semantics | REQ-56 and provider section 7; A81. Exact IDs/counts/filter/search/date semantics, pinned Unicode 15.1 rules, safe integers and bounded floating-map tolerance; profile-aware row equivalence. |
| Full Local authoring | REQ-56; A82. Events/sessions/activities, models/schemas, filters/groups/views/settings, preview/publication and reference safety use Local commands, not disabled mock controls. |
| Honest Local durability | REQ-01/56/57 and provider section 4; A82/A86. RAM edits, explicit JSON export/reimport, no browser database or implicit filesystem overwrite, no fake server commits. Download requested is not a verified disk save. |
| Responsive startup and actual fallback | REQ-58, section 63; A83/A84. A complete labeled embedded/imported fallback remains usable during a bounded optional two-second probe and genuine outage; no late source switch after interaction. |
| Lost Server writes | REQ-58 and provider sections 2/6; A85. Source-scoped outcome-unknown, read-only command-result lookup, explicit original-key retry; not-found does not prove an in-flight request cannot arrive. |
| Controlled reconnect without autosync | REQ-58; A86. Compare source identity/scope/generation and local changes, explicitly activate Server, reject foreign handles and never upload or merge Local edits automatically. |
| Auth and file-origin security | REQ-28/29/58; A87. Distinguish 401/403 from outage, invalidate managed restricted content, opt-in authenticated CORS/preflight, no embedded secrets or trusted Origin:null. Exported copies are not remotely revocable. |
| Full unit/format catalog | REQ-40/59, sections 25/64; A38/A88/A89. All eleven units from millisecond through millennium, inventoried formats, years 0001-9999, calendar/DST boundaries and explicit unsupported-value diagnostics. |
| Bounded Local computation | REQ-57 and provider sections 4/5; A90. 25,000 records, 64 MiB decoded bundle including 32 MiB assets, 128 MiB working admission budget, two queries/two layouts, bounded preparation and denied-worker cooperative fallback. |
| Existing adaptive and row contracts | REQ-50-52; A58-A74/A89. Complete-scope density, independent overview/zone transforms, nonlinear gesture oracles, height-aware global rows, bounded fragments and coherent updates work through both providers. |
| Mandatory tests before code delivery | REQ-53 and section 65; A92. G0-G5 and every mandatory requirement/scenario require exact-candidate evidence; skipped, blocked, flaky or absent checks cannot count as passes. |

## Corrections Confirmed

| Older or ambiguous clause | Current disposition |
| --- | --- |
| Open language/framework decision and deferred read-only static demo | Sections 03/59 fix Python plus JavaScript/Three.js and require a fully functional generated Local application. Version/tool verification remains an M0 task, not an unresolved language choice. |
| Durable JSON/API success applied indiscriminately to Local edits | Sections 01/03/61 and the model/visual companion scope notes distinguish Server commits/restart tests from Local memory revisions/export/reimport. No common model capability is removed. |
| Browser must never hold all records | Sections 12/47-49/61 and the query companion scope this to ordinary Server browsing. Complete admitted Local snapshots and explicit complete export/import are required exceptions. |
| Complete snapshot could mean any selected subset | Section 62 specifies authorized workspace or explicit source-set completeness. Selected-ID/time/search convenience exports remain incomplete for automatic fallback. |
| Years 0001-9999 could silently narrow by runtime | Section 05 now requires the same full range in both providers and rejects conversion/arithmetic overflow. Section 64 and A88 preserve boundary tests. |
| Reconnect could retry an uncertain write as an availability check | Section 63 now defines read-only getCommandOutcome/GET command-results; executing the original retry key is a separate explicit user action. |
| Export click could be advertised as a durable save | The provider contract and integration plan distinguish preparation/download request from preservation confirmed by the user or verified by reimport/hash. Modification state cannot clear on click alone. |
| Stale screenshot/scenario counts and removed-image reference | Section 19 now requires A01-A92; section 21 requires sixteen design images plus three retained evidence images; S17 identifies archived static evidence instead of claiming reproduction in section 34. |
| Binary64-only normalized view coordinates at extreme zoom | Section 47 and the scale/query companions require precision-capable, origin-relative view arithmetic. `decimal-view-v1` transports continuous a/b and inverse bounds as normalized finite decimal strings with up to 34 significant digits and no exponent. Canonical record milliseconds, density formulas, accepted map semantics and named fixture coordinates are unchanged. |

## Checks and Explicit Limits

Documentation checks performed for this audit found 65 numbered sections, 59 requirement definitions, 92 acceptance definitions with no missing or duplicate acceptance IDs, and 19 embedded image references with existing local paths. These are text/path checks, not visual inspection of those images or the generated PDF. PDF rendering and page-layout QA are separately reported by the main task.

M0 still must freeze maintained dependency/runtime/browser versions, complete the required source inventory, encode native OpenAPI/JSON schemas, choose validated shaping/timezone profiles, record scale-boundary conventions, and establish repository-native verification commands. These are scheduled implementation-discovery deliverables, not reasons to weaken already mandatory product behavior. The full source runtime audit remains unexecuted; historical static evidence does not establish a working legacy feature.

Local and Server capacity/performance targets remain proposed until measured. Millennia-wide domains combined with millisecond detail windows must pass precision/inverse tests, not rely on default floating behavior. The decimal view encoding is shared by HTTP and Local envelopes, included in cursor identity and parsed through an established precision-capable library; G0 freezes normalized grammar and rounding fixtures. Approximation is allowed only when the existing geometry tolerances remain satisfied, never by widening the requested window. The relevant binary64 risk is loss of subpixel precision through rounding/cancellation, not a claim that every supported 1 ms interval necessarily collapses to identical endpoints.

Browser downloads and best-effort unload warnings do not promise durable autosave. File-origin CORS is an optional authenticated Server connection; pure Local still requires zero network. Different valid shaping profiles can have different row breaks, but cannot silently alter an already accepted layout or omit eligible IDs.

No application code, dependencies, builds, dev server, storage fault experiments, runtime browser journeys, performance tests or security scans were produced or executed for this audit. All A01-A92 and G0-G5 application results remain future verification obligations.
