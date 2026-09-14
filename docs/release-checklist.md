# Full Release Completion Checklist

Baseline: the third implementation increment, immediately after the 359-case run documented in [testing](testing.md), before the newly authorized full-release work. Prepared 13 September 2026 UTC. This is a read-only implementation/specification audit plus a new checklist, not a release approval or a newly executed test report. Concurrent implementation after this baseline must update evidence against a named candidate rather than silently changing these observations.

The entire [revision 2.4 specification](../OpenBEXI_Timeline_Rebuild_Prompt.md), all sections of the [integration plan](integration-test-plan.md), and the complete 241-ID [legacy inventory](legacy-compatibility-matrix.md) were reviewed. The original prompt is unchanged; its SHA-256 is `f4cad95facd38095851171df8130551b3dd90a62964dcd95e455178a96f83514`. Companion audits remain authoritative for their detailed cases. This document indexes their remaining work; it does not replace them or reduce the release scope.

## Status Rules

| Status | Meaning |
| --- | --- |
| OPEN | A required capability or contract is absent in the baseline implementation. |
| PARTIAL | Working implementation exists, but named mandatory clauses or coverage remain incomplete. |
| VERIFY | No new implementation gap is identified for this particular assertion, but exact-candidate release evidence is still required. This is not a passed release result. |
| RESOLVE | A concrete contract/version discrepancy must be resolved explicitly before dependent changes. Existing behavior is not automatically wrong, but it cannot certify a different contract. |
| EXCLUDED | The specification deliberately excludes that legacy mechanism or optional product feature. Its exclusion, provenance and safe diagnostics still need verification; it must not be reintroduced to inflate compatibility. |

The current 73 JavaScript, 194 Python, 20 real-HTTP parity and 72 browser cases are valuable incremental evidence. They are not 359 mapped release requirements, a cross-platform qualification or a substitute for G0-G5. No delivered commit/tag exists in that report. A requirement is closed only when every applicable clause and its companion cases have implementation and current result links. Never count skipped, missing, flaky or blocked evidence as passed.

## Evidence Anchors

These are baseline inspection anchors, not a claim that every line was dynamically exercised by this audit.

| Key | Baseline evidence |
| --- | --- |
| E01 | [Implementation status](implementation-status.md), especially Limits That Remain; explicitly identifies incomplete full release. |
| E02 | [Implemented API](api.md) and [route module](../server/app/main.py): one configured token, default workspace, record/model subset, no complete administration/job/live surface. |
| E03 | [Repository](../server/app/repositories/json_repository.py), `_recover`, `_commit_files`, `mutate`, `mutate_model`: serialized JSON redo workflow; no complete release batch/backup/audit/retention system. |
| E04 | [Record schema](../shared/schemas/record.schema.json), [snapshot schema](../shared/schemas/snapshot.schema.json), [Local validation](../client/src/data/snapshot.js), [Python validation](../server/app/models/domain.py): draft-07, custom schema activation rejected, limited complete-package members. |
| E05 | [Catalog](../client/src/data/model-catalog.js), [catalog contract](model-catalog-contract.md), [model manager](../client/src/ui/model-manager.js): versioned visual catalog with one workspace-default usage reference, not the full resource/reference graph. |
| E06 | [Presentation contract](presentation-contract.md), [presentation schema](../shared/schemas/presentation.schema.json), [layout](../client/src/timeline/layout-presentation.js): four measured Noto profiles, two band roles, primitive grouping and bounded nesting/styles. |
| E07 | [Query service](../server/app/services/query.py), [Local provider](../client/src/data/local-provider.js), [table service](../server/app/services/table_query.py): immutable complete-scope calculations; no response fragmentation, aggregate drill-down or full preparation/admission protocol. |
| E08 | [App](../client/src/app.js), [table view](../client/src/ui/record-table-view.js), [filter editor](../client/src/ui/filter-editor.js): real navigation/forms/filtering/table/export/source safeguards; incomplete saved resources, explicit drag-edit, multi-instance and table authoring surface. |
| E09 | [Worker provider](../client/src/data/worker-provider.js), [standalone guide](standalone-mode.md): embedded core and startup-only direct fallback; direct fallback is not cooperatively sliced. |
| E10 | [Legacy dry-run adapter](../client/src/data/legacy-visual-adapter.js), [CLI](../scripts/inspect-legacy-model.mjs), [migration guide](migration-from-tomcat.md): sanitized pointer diagnostics and partial visual mapping, not full model/data/source/filter migration. |
| E11 | [Performance](performance.md): baseline 100,000-record startup exceeded 120 seconds; service-only measurements bypass startup; full query plus full-range layout approximately 19.67 seconds. No release percentile gate passed. |
| E12 | [Testing](testing.md), [backend tests](testing-backend.md), [package scripts](../package.json), [Playwright config](../playwright.config.mjs): Windows/Edge incremental evidence; broader matrix, CI, formatting/static-analysis and commit-bound traceability remain. |

## Contract Decisions Before Dependent Work

These are coordination items, not permission to weaken the original prompt.

| ID | Required resolution |
| --- | --- |
| D01 | Freeze versioned JSON contracts for schemas, sources, groups, filters, views, settings, permissions, packages and reference edges. Specify migration from existing flat presets/canonical visual histories and current snapshot format without rewriting immutable published definitions. Parent-owned catalog architecture should establish this first. |
| D02 | Align release HTTP semantics and provider adapters: REQ-16 requires replacement PUT, allowlisted JSON Patch and record DELETE 204; current PUT merges supplied fields and DELETE returns a result body. Define migration/backward compatibility, ETag/Location/error payloads and outcome retrieval together; do not make UI success depend on a deleted response body. REQ-52 ready query/layout preparation is 200 or preparing 202, not current 201. |
| D03 | Reconcile the actual recovery protocol with REQ-12. The prompt specifies before/after PREPARED, target installation, then COMMITTED, with rollback before commit. Current code durably marks COMMITTED before installation and redoes after-images. Preserve proven safety while implementing the specified protocol, or obtain an explicit reviewed contract decision with equivalent required guarantees and new tests. Existing redo tests do not prove the specified rollback algorithm. This audit changes neither. |
| D04 | Adopt the pinned OpenAPI 3.1.1 and JSON Schema 2020-12 contract, with complete native schemas and strict Python/JavaScript conformance. Current draft-07 artifacts and generated route metadata are not that deliverable. Freeze extension compatibility and local-only reference resolution before catalog expansion. |
| D05 | Freeze one effective-default policy: section 47 names Adaptive ratio 8, while the current base catalog/provider defaults use 4. Preserve authored historical values/version pins. Record the selected default and migration behavior, rather than editing every stored definition. Likewise implement the specified application/workspace/model/view/personal/ephemeral precedence, distinct from per-record style resolution. |
| D06 | Keep Python, JSON-only persistence, one local-disk writer and orthographic 2D default fixed. The written prompt also explicitly requires opt-in source-backed Perspective compatibility in REQ-05/40/46 and camera acceptance cases. An orthographic default does not silently cancel that obligation. If a later explicit user instruction requires orthographic-only, record that exact scope decision before marking those cases excluded; do not infer it from the current implementation's limitation. |
| D07 | Freeze safe multiband IDs/order/size, grouping/array semantics, font/shaping/asset registry, zone ownership and model-package closure. Existing `presentation.version:1` has primary/overview objects, not an arbitrary band array. Extend versionedly and preserve old geometry; do not activate nonfunctional optional keys. Approved asset support is required; arbitrary remote code, arbitrary host paths and unsafe descriptor execution remain prohibited. |
| D08 | Freeze resource-capability vocabulary and snapshot scope invalidation across every endpoint before adding roles. Define pending/committed/failed/not-found/expired outcome states and principal/generation/route scope. Current single-token trusted operator and committed/not-found lookup cannot stand in for that contract. |

## Implementation Work Packages

All packages below remain release work. Suggested module boundaries are locations to extend, not authorization to create duplicate authorities or frameworks.

| Work ID | Remaining capability and concrete closure condition | Dependencies / leverage |
| --- | --- | --- |
| RL-01 | Complete M0 machine-readable file/capability manifest. Classify every first-party file, template, property and companion case with pinned path/hash/lines, evidence type, disposition, test ID and status. Attempt isolated legacy execution; preserve exact failures if blocked. Zero unclassified rows; each activated model has zero unresolved activation blockers. | Existing source audits and LC inventory; no runtime pass inferred from comments/images. |
| RL-02 | Versioned data-schema registry and canonical validation. Enforce declared built-in field types, scoped custom-schema versions/local references, full required record/audit fields, schema-compatible predicates and reference retention for tombstones. Old valid snapshots import without losing metadata/history; unknown future formats fail atomically. | D01/D04; shared schemas, domain validators, catalog/provider core. |
| RL-03 | JSON workspace/source/group management and reference safety. Implement documented CRUD, empty-workspace deletion, stable source/group IDs, enable/readOnly/writable policies and explicit reassignment/archive; no arbitrary runtime paths or connectors. A read-only source rejects every write channel, including Local/batch/import, with matching UI explanation. | RL-02/RL-06/RL-07; common catalog services and both providers. |
| RL-04 | Saved filters/views and effective settings. Persist personal/shared ownership, named typed filters, columns, grouping/collapse, timezone, scale, calendar/overview/search preferences; resolve origins/precedence/reset correctly. Reload Server and export/reimport Local retain intended state; switching never discards a draft or broadens a filter silently. | D01/D05, RL-02/03/06; one resolver used by API, UI and preview. |
| RL-05 | Complete model/schema authoring and reference management. Separate owned drafts, immutable version routes, read-only validate/preview/diff, reference enumeration and explicit upgrades, package import/export and impact reports. Publish v2 and upgrade two of five references only; stale/unauthorized combined commands change none. Preview Timeline/Table/Inspector without modifying active state. | RL-02/04/06/08/09; extend existing catalog/model manager, preserve working lifecycle. |
| RL-06 | Root JSON principal/token/capability administration. Viewer/editor/admin with scoped resource/field/export/audit access, one-time bootstrap, hashed opaque expiring tokens, rotation/revocation, disabled restored tokens, logout and local recovery. Verify no client role/owner flag grants access and no private data/count/stream leak after revocation. | D08, RL-08; central authorization policy, root control repository and administration UI. Server-only identity authority. |
| RL-07 | Full REST/schema contract. Implement all section 08/26/49 endpoint families and native schemas, replacement/patch/delete semantics, typed routes, complete problem details, health/capabilities, limits and Retry-After. Exercise through external HTTP clients independently of UI. Local provider commands retain semantic parity without fake HTTP durability. | D02/D04, RL-02/03/05/06; modular route adapters rather than more persistence in main.py. |
| RL-08 | Complete transaction, audit, history and backup infrastructure. Add atomic mixed batches/cascade/restore, root/workspace lock order, 500 records/8 MiB request/32 MiB envelope preflight, durable audit/outcomes, integrity monitoring/freeze, checkpoint/retention, consistent backup and inactive-root restore with fresh generations. Fault each phase; restart twice; exact old-or-new result, no mixed state. | D03/D08; repository/writer protocol first; supports RL-03/05/06/09/10. |
| RL-09 | Full dry-run/reviewed import and job framework. Cover both visual templates, four saved filters, four source files, all nine JSON data variants, genuine activities and descriptor sidecars. Strict invalid-file rejection, separate reviewed repairs, stable restart-safe ID mappings, quarantined ambiguous dates/point parents, dependency/collision preview, bounded chunks/cancel/resume and audited result IDs. Preserve originals and unknown metadata without executing it. | RL-01/02/03/05/06/08; build on sanitized adapter, not its blocked report as conversion. |
| RL-10 | Committed SSE and polling replay with pinned/live policy. Snapshot-then-resume handshake, atomic transaction envelopes/invalidation, deduplication, 10,000 transactions or 24h retention whichever larger, backpressure/heartbeat/reconnect and permission invalidation. Two browsers traverse page ten under five writes/s; pinned rows remain fixed and live rows/map/counts swap coherently. | RL-06/08 and RL-18; one change stream for records and configuration. |
| RL-11 | Complete record editing and recovery. Explicit Navigate/Edit, move/resize/snapping/keyboard equivalents, ongoing close, trash/restore, bounded cascade/shift, conflict comparison/reapply and conditional undo/redo. Cancel never commits; parents do not move children implicitly. Preserve original-source unknown outcomes and record-editor recovery across reload without storing tokens/private drafts unexpectedly. | RL-03/06/07/08; common commands for Timeline/Table/Local/Server. |
| RL-12 | Full Table/Split workflows. Schema-derived configurable columns/order/width/visibility, group/tree collapse, missing/null/derived duration, inline edits, keyboard virtualization and explicit page/IDs/all-matches bulk selection. True user-resizable 60/40 split and defined responsive variants; shared scope/selection, independent sort, sticky identity columns and complete scoped exports. | RL-02/04/07/08/11; extend record-table view, not separate record state. |
| RL-13 | All-model multiband workspace and Classic compatibility. Stable arbitrary detail/overview band roles, sizes/order, per-band scale/spacing, source bindings, legends, collapse, optional overview/calendar/descriptor and exact Classic-14 geometry/indicators. Both shipped templates coexist, render, edit and round-trip with no blocked active fields. | D06/D07, RL-04/05/09/15/17; Classic geometry is an opt-in profile, not new default. |
| RL-14 | Complete listener/lifecycle/multi-instance behavior. All typed targets, exact mouse/touch thresholds, overview-record activation, cancellation/lost capture/blur, buffered reload, optional bounded inertia, follow-now pause/resume and explicit synchronization groups. Mount two independent instances and 100 lifecycle cycles; one controller per canvas, zero leaked work after disposal. | RL-11/13/15/17/18; isolate current app-level state before claiming embeddable multi-instance. |
| RL-15 | Full approved rendering/asset capability and footprint safety. Broader glyph coverage/shaping including bidirectional text, required approved icon/image/material mappings, measured fonts, complete label overflow access, model conditional styles and supported camera transforms. Reserve true label/icon/baseline/selection ink, 4 px unrelated clearance, <=0.5 px epsilon; never silently omit or substitute unsupported assets. | D06/D07; extend registered font/asset resolver and shared layout; maintain existing four-profile regressions. |
| RL-16 | Editable versioned zones and baselines. Put annotation IDs, scopes, dates, styles/visibility and provenance in governed model resources; expose version-checked authoring, safe details and non-color cues. Export/reload and both band transforms agree; zones/context never become records, match counts or bulk targets. Raw tolerance remains metadata until units are defined. | RL-02/05/06/13; current zone rendering alone does not satisfy authoring. |
| RL-17 | Complete scale controls/stability. Add per-band interval multiple/spacing/subdivisions/week start, reference/time-domain controls, explicit Recompute, automatic-adjustment policy, 0.002/30s/2s/500ms hysteresis and fresh density/retained-geometry lineage. Freeze maps during gestures; preserve UTC endpoints and exact 1 ms/long-domain arithmetic. Existing eleven units and 35 formats must remain intact. | D05/D07, RL-04/10/13; extend current Decimal/Temporal core, not a new scale engine. |
| RL-18 | Complete bounded query/layout protocol. Add preparing/status/cancel/admission, principal-aware retention, exact model/scope/profile identities, global byte accounting, 16 KiB projections, paginated zones, same-row-range fragments (<=8), authorized ancestors/footprintOnly context, aggregate drill-down and search next/previous/fit/match metadata. No full-list download for ordinary Server navigation; every intended instance reachable exactly once. | RL-02/06/10/15/17; reuse current immutable query/layout/table core. |
| RL-19 | Cooperatively cancellable Local execution and full capacity accounting. Same algorithms in embedded worker and worker-denied <=8 ms slices, including large strict parse/validation; bounded preparation/queue/memory, timely cancellation and no unknown-write replay. Test 25k records/64 MiB bundle/32 MiB assets/128 MiB working data at boundaries, repeated changes and disposal. Functional direct fallback is not this gate. | RL-02/15/18; maintain worker command-intent/outcome safety, avoid duplicated algorithms. |
| RL-20 | Complete source/outcome transitions. Configured nonblocking <=2s initial probe, explicit activation after interaction, compatibility diagnostics, no silent filter broadening, complete-only fallback and reload-safe record outcomes. Test pending/failed/expired/generation-changed results, credential revocation and file-origin CORS independently of network failure. Preserve already passing stale-source/cleanup/import/worker-loss guards. | RL-03/04/06/07/10/11/19; extends existing source state, no automatic upload/merge. |
| RL-21 | Meet and qualify performance. Optimize real 100k startup and cold display without skipping validation; freeze the normative 100-group/nested/ongoing fixture and 4-core/16-GiB/SSD environment. Five cold and thirty warm samples; startup <=30s, page/save p95 <=300ms, Uniform useful view <=3s, Adaptive overview <=3s/full <=10s, live notice <=1s/warm <=3s, frame p95 <=33ms, no repeated >200ms stalls, twenty clients/five writers <=2GiB RSS. Report million-record stress separately. | RL-08/10/13/15/18/19; backend profiling is implementable work, not an external certification blocker. |
| RL-22 | Operational delivery and maintainability. Linux single-writer persistent-volume container, safe startup/shutdown/liveness/readiness, sanitized correlation logs/metrics, disk/history quotas, backup warnings and troubleshooting. Full README/migration/backup/admin/user/API guides, UI spec, license manifests/changelog/contribution workflow, formatting/lint/static checks and CI. Clean install and restore commands must execute, not merely exist. | RL-01/06/07/08/09/21; retain native lockfiles and single-file build. |
| RL-23 | Execute and retain complete release evidence. Every REQ/A/LC/I/L/MS/LB entry maps to exact-candidate tests/results, fixture/environment hashes, logs, traces, screenshots/diffs, security review, manual accessibility and benchmark distributions. Re-run changed shared contracts and full matrix; no stale report or missing artifact counts as pass. | All packages; G0-G5 below. |

Suggested dependency order: D01-D08/RL-01 first; then shared schema/catalog, authorization and transaction foundations (RL-02-08); migration/live/query services (RL-09/10/18); full authoring/table/multiband/interaction (RL-11-17/20); scheduling/performance/operations and complete gates (RL-19/21-23). Unit, fault, parity and browser checks accompany each package, not only the final step. Independent UI/accessibility and packaging work can proceed against frozen contracts.

## Requirement Ledger

Each of the 59 original requirement IDs appears exactly once below. Work-package closure criteria above cover the named remaining clauses; the original prose remains the complete acceptance authority.

| Requirement | Status | Remaining release obligation / work |
| --- | --- | --- |
| REQ-01 | VERIFY | Ordinary JSON/memory boundary already implemented; inspect complete new config/job/audit dependencies and both modes, RL-22/23. |
| REQ-02 | VERIFY | Existing lock/serialization evidence; Linux volume, operational refusal and concurrent supported matrix, RL-08/22/23. |
| REQ-03 | PARTIAL | Complete mandatory product surface without adding deferred scheduling/connectors, RL-02-20. |
| REQ-04 | PARTIAL | Complete-file manifest, activation classification and reproducible legacy execution attempt, RL-01/09/23. |
| REQ-05 | PARTIAL | Preserve fixed modular stack; resolve supported camera compatibility and remaining service boundaries, D06/RL-13-15/22. |
| REQ-06 | PARTIAL | Full workspace/root resource ownership, authority, bounded jobs and capability-aware epochs, RL-02-10/18. |
| REQ-07 | PARTIAL | Pinned custom schemas, strict declared fields, group references and complete canonical representation, RL-02/03/08. |
| REQ-08 | PARTIAL | Out-of-parent indication, explicit shift/cascade/restore/batch and reference-safe resource deletion, RL-03/08/11. |
| REQ-09 | VERIFY | Current canonical/Decimal/Temporal tests retained; full zone/platform/date-boundary evidence and scheduled ongoing cue, RL-11/17/23. |
| REQ-10 | OPEN | Real legacy date/envelope/aggregate adapters and quarantine rather than visual dry-run alone, RL-09. |
| REQ-11 | PARTIAL | Config/control/job/audit areas, source write policy, scalable ID partitioning and validated rebuild/monitoring, RL-03/08/21/22. |
| REQ-12 | RESOLVE | Recovery ordering/ADR plus cross-file batch/root/audit/outcome atomicity and idempotent recovery, D03/RL-08. |
| REQ-13 | PARTIAL | Full real-filesystem fault matrix and explicit OS/power-loss guarantees, RL-08/22/23. |
| REQ-14 | OPEN | Out-of-band write freeze, consistent complete backup, inactive restore and verified compaction, RL-08/09/22. |
| REQ-15 | PARTIAL | Every mandatory resource family plus pinned native OpenAPI/schema contracts, D04/RL-07. |
| REQ-16 | RESOLVE | Complete replacement/Patch/delete/ETag/idempotency retention and pending protocol, D02/RL-07/08. |
| REQ-17 | PARTIAL | Full problem-details/field/request IDs, batch envelope limits, rates, cancellation/Retry-After, RL-07/08/18. |
| REQ-18 | PARTIAL | Saved/cross-schema typed filter scopes, array rules and authorized ancestor context, RL-02/04/18. |
| REQ-19 | PARTIAL | Principal/global retention, invalidation, live/pinned notices, full export/bulk scopes, RL-06/10/12/18. |
| REQ-20 | PARTIAL | All distinct catalog/resource types, ownership/visibility and shared management parity, RL-02-05. |
| REQ-21 | PARTIAL | Full reference graph including tombstones, schema impact/migration and effective settings origins, RL-02/04/05/08. |
| REQ-22 | PARTIAL | Conditional styles, multiband sizes/collapse, columns, editable regions and personal/shared views, RL-04/12/13/15/16. |
| REQ-23 | PARTIAL | Remaining calendar/legends/multiband/camera/Follow now and explicit interaction modes, RL-13/14/17. |
| REQ-24 | PARTIAL | Full edit/restore/batch/undo/conflict workflows and accessibility, RL-11/15/18/23. |
| REQ-25 | PARTIAL | Resizable Split, schema columns/group tree/inline edits/bulk scopes/persisted settings, RL-04/11/12. |
| REQ-26 | OPEN | Committed SSE/polling replay including metadata and atomic batches, RL-08/10. |
| REQ-27 | PARTIAL | Existing controlled reconnect remains; add live-stream failure/replay/revocation/backpressure, RL-06/10/20. |
| REQ-28 | OPEN | Real principals/roles/scoped tokens/bootstrap/rotation/revocation/restore recovery, RL-06. |
| REQ-29 | PARTIAL | Full-resource access checks, hostile boundaries, quotas/rates and sanitized effective config, RL-03/06/07/18/23. |
| REQ-30 | PARTIAL | Metrics/quotas/operations, Linux container, admin restore/purge and troubleshooting, RL-08/22/23. |
| REQ-31 | OPEN | Complete data/source/schema/filter/sidecar migration with preserved provenance, RL-01/09. |
| REQ-32 | PARTIAL | Sanitized visual dry-run exists; full reviewed repair, stable resumable import and rollback manifests, RL-09. |
| REQ-33 | PARTIAL | Actual startup/cold-range targets missed; optimize and run controlled full benchmark matrix, RL-21. |
| REQ-34 | PARTIAL | Map every data/API clause to independent real-result evidence, RL-23. |
| REQ-35 | PARTIAL | Full mandatory scenarios, security/accessibility/platform evidence, no partial-suite certification, RL-23. |
| REQ-36 | PARTIAL | Existing increments runnable; M0 and full M2-M5 exit gates remain, RL-01-23. |
| REQ-37 | PARTIAL | Full native specifications, operations/user/backup docs, CI/contribution/static quality and traceability, RL-22/23. |
| REQ-38 | PARTIAL | Every listener target/camera, precise thresholds/Edit/lifecycle corrections, RL-11/13/14. |
| REQ-39 | PARTIAL | Independent mountable instances, complete motion/clock/buffer/disposal contract, RL-14/23. |
| REQ-40 | PARTIAL | Both activated shipped models, every consumed capability/package family and machine-readable classification, RL-01/05/09/13/15/17. |
| REQ-41 | PARTIAL | Complete authoring surfaces, cross-view previews, affected references and publication review, RL-02/04/05/13. |
| REQ-42 | PARTIAL | Owned-draft/history/preview/diff/reference/package/field-catalog/effective-settings API, RL-02/05/07/09. |
| REQ-43 | PARTIAL | Prompt targets exist; real legacy/current state and full model/camera visual comparisons remain, RL-13/15/23. |
| REQ-44 | PARTIAL | 58-item brief classification exists; retained implementation/test mapping and exact optional Classic behavior, RL-01/13/23. |
| REQ-45 | OPEN | Runtime Classic-14 identity/colors/geometry/calendar/edit-reload oracle, RL-09/11/13. |
| REQ-46 | PARTIAL | Calendar/overview/camera/help/account/search-navigation commands, full descriptor/hidden-selection state, RL-06/13/14/18. |
| REQ-47 | PARTIAL | Broader approved profiles, footprint-only candidates, complete camera/multiband/instance/live bounds, RL-13-15/18/23. |
| REQ-48 | PARTIAL | Search core works; custom permitted fields, match metadata/navigation/fit, exact Dark-40 and live/privacy/bulk cases, RL-02/06/10/12/18. |
| REQ-49 | PARTIAL | Working light default preserved; full scoped editable/versioned zones, touch/non-color and responsive proof, RL-13/16/23. |
| REQ-50 | PARTIAL | Hysteresis/geometry lineage/Recompute, full domain policy and camera mode obligations, D05/RL-10/17/23. |
| REQ-51 | PARTIAL | Fragments, context/instance identity, stable reanchor and complete profile/expansion behavior, RL-13/15/18. |
| REQ-52 | PARTIAL | Preparing/status, admission/cancel, scoped memory/queues/limits, context/zone pages and live bundles, RL-06/10/18. |
| REQ-53 | OPEN | Full G0-G5 exact-candidate evidence, RL-23. |
| REQ-54 | VERIFY | Fixed Python/JS/Three.js stack works; validate new modules and supported clean deployment, D06/RL-22/23. |
| REQ-55 | PARTIAL | Existing modular build/lockfiles preserved; complete services/schemas/docs/license closure and reproducible clean package, RL-07/22/23. |
| REQ-56 | PARTIAL | Both providers support every common new config/batch/job-equivalent workflow and exact scoped results, RL-02-05/08/11/18-20. |
| REQ-57 | PARTIAL | Full package dependency closure/assets, cooperative fallback/cancel and complete Local envelope, RL-02/09/15/19/23. |
| REQ-58 | PARTIAL | Initial configured probe, all outcome states/record recovery, compatibility explanations and revoked scope handling, RL-06/10/20. |
| REQ-59 | PARTIAL | Existing units/formats remain; per-band multiples/spacing/week policy, manual/automatic/Recompute and multiband combinations, RL-13/17. |

## Acceptance Scenario Ledger

These entries describe missing implementation or missing full-scenario qualification, not replacements for original acceptance wording. VERIFY retains existing positive incremental evidence but remains open for the full supported matrix/candidate. No row below claims its complete scenario passed.

| Scenario | Status | Next required closure evidence |
| --- | --- | --- |
| A01 | VERIFY | Create/restart JSON identities and relationships on both storage platforms; RL-08/23. |
| A02 | OPEN | Empty-end/invalid-date legacy migration and quarantine; RL-09. |
| A03 | VERIFY | Exact enclosing/left/right boundary sets through release APIs/providers; RL-23. |
| A04 | PARTIAL | Complete DST legacy-policy and canonical/calendar edge vectors on all runtimes; RL-09/17/23. |
| A05 | VERIFY | Real simultaneous edits, 412 and preserved draft across supported browsers; RL-11/23. |
| A06 | PARTIAL | Every actual transaction phase and mixed batch, old/new state after two restarts; D03/RL-08. |
| A07 | PARTIAL | Disk-full/permission/sharing/replacement failures on real Windows/Linux roots; RL-08/23. |
| A08 | PARTIAL | Batch/import outcomes, lost replies and retention across restart; RL-08/09. |
| A09 | OPEN | One invalid/stale/denied batch item produces zero writes and item errors; RL-08. |
| A10 | PARTIAL | Explicit atomic subtree cascade and restore; RL-08/11. |
| A11 | PARTIAL | Independently verify rebuildable index/cache corruption behavior and counts; RL-08/18/23. |
| A12 | PARTIAL | Existing second-writer test plus out-of-band write detection/freeze; RL-08. |
| A13 | PARTIAL | Page ten under five writes/s, expiry/restore/scoped cursor failures; RL-10/18. |
| A14 | OPEN | Real scoped principals/workspaces/imports/streams and revocation attacks; RL-06/23. |
| A15 | VERIFY | Audit full installed dependency/runtime/storage closure; RL-22/23. |
| A16 | PARTIAL | Both views restore/complete editing and durable reconciliation; RL-11/12. |
| A17 | PARTIAL | Saved state plus true resizable/responsive Split and query parity; RL-04/12. |
| A18 | VERIFY | Full schema sorting/reveal, stable timeline lanes and unchanged temporal focus; RL-12/23. |
| A19 | OPEN | Explicit drag-edit/snapping/keyboard versus zero-write Navigate; RL-11/14. |
| A20 | OPEN | Personal/shared saved resources, precedence, reset and restart; RL-04/05. |
| A21 | OPEN | Schema impact and all referenced source/group/model deletion guards; RL-02/03/05. |
| A22 | OPEN | Reordered/duplicate/missing SSE or polling batches never expose partial transactions; RL-10. |
| A23 | OPEN | Full legacy import/resume/export semantics and audited ID mappings; RL-09. |
| A24 | OPEN | Backup while writing and isolated validated restore; RL-08. |
| A25 | PARTIAL | All error/read-only/recovery/long-label/input/screen-reader states; RL-15/23. |
| A26 | PARTIAL | Frozen full distributions and repeated resource lifecycle, not single runs; RL-21. |
| A27 | PARTIAL | Clean supported Windows/Linux installation from exact checkout/package; RL-22/23. |
| A28 | PARTIAL | Selected IDs/C/M/visible exports, canonical dependencies and bulk scope; RL-09/12. |
| A29 | OPEN | Authorized ancestor context excluded from counts and schema-scoped null/type semantics; RL-02/18. |
| A30 | PARTIAL | Imported all-band/camera/original/style meaning survives edits/reload; RL-09/13/15. |
| A31 | OPEN | Governed zone authoring round trip and point-parent aggregate quarantine; RL-09/16. |
| A32 | OPEN | Restored generations, disabled old tokens and concurrent scoped clients; RL-06/08/10. |
| A33 | PARTIAL | Every typed detail/overview/structural target with zero persisted navigation writes; RL-14. |
| A34 | PARTIAL | Uniform model-unit oracle plus actual camera/DPR conversion and calendar; RL-13/14/17. |
| A35 | PARTIAL | Exact mouse/touch threshold boundaries, explicit Edit and every cancel path; RL-11/14. |
| A36 | PARTIAL | 100 mount/model/camera/unmount cycles with measured resource ownership; RL-14/23. |
| A37 | OPEN | Both shipped templates fully activate, render, edit and round-trip separately; RL-09/13. |
| A38 | PARTIAL | Every property, format, grouping value, approved asset/source/camera and diagnostic; RL-01/13/15/17. |
| A39 | PARTIAL | Current draft isolation extended to all fields and Timeline/Table/Inspector previews; RL-05. |
| A40 | OPEN | Concurrent owned drafts and atomic publication/upgrades of two of five references; RL-05/08. |
| A41 | OPEN | Model/schema packages with collisions/assets/dependencies/impact and safe lifecycle; RL-05/09. |
| A42 | OPEN | Actual eight compatibility states plus required variants/diffs, not generic substitutes; RL-13/23. |
| A43 | OPEN | Two simultaneously mounted independently scoped timelines; RL-14. |
| A44 | OPEN | Clock/inertia/reduced-motion/Follow now/buffer oracle; RL-14/17. |
| A45 | PARTIAL | All 58 brief items have implementation/test dispositions, not document-only coverage; RL-01/23. |
| A46 | OPEN | Exact Classic geometry/counts/calendar and EVT-004 durable edit oracle; RL-13. |
| A47 | PARTIAL | Complete compact menu/account/calendar/overview/search/camera/help at all widths; RL-13/14/18. |
| A48 | PARTIAL | Actual busy-track/font/overview regressions across complete approved profiles; RL-15/23. |
| A49 | PARTIAL | Complete projected live/camera/multiband/long-text geometry with bounded overflow; RL-13-15/18/23. |
| A50 | OPEN | Dark-40 exact 5_1 identities, two yellow labels and two overview findings; RL-09/13/23. |
| A51 | OPEN | Exact 0_3 fixture in all required model variants without stored changes; RL-09/13/23. |
| A52 | PARTIAL | Current grammar tests plus real hidden-field permissions and full profile variants; RL-02/06/23. |
| A53 | PARTIAL | Global search navigation under live writes, restore and changing permission scope; RL-10/18. |
| A54 | PARTIAL | Complete contextual/matches table, hidden selection and exact bulk/export preview scope; RL-12/18. |
| A55 | PARTIAL | Classic/dark calendars/full descriptor/read-only/hidden-selection/failure states; RL-03/13/15. |
| A56 | OPEN | Declared menu/view preferences reload with ownership and multi-instance isolation; RL-04/14. |
| A57 | VERIFY | Actual selected-source/empty two-band rendering throughout supported matrix; RL-23. |
| A58 | PARTIAL | Current projection plus versioned/scoped zones and all page/scale combinations; RL-16/23. |
| A59 | VERIFY | Full-domain independent density sets after all new scope/schema policies; RL-18/23. |
| A60 | VERIFY | Exact AS-MAP-01 and invalid-knot invariants on final math/render profiles; RL-17/23. |
| A61 | PARTIAL | Current nonlinear pan/zoom plus calendar and all accessible controls; RL-13/14/17. |
| A62 | OPEN | Hysteresis, lineage, explicit Recompute and deterministic gesture/reduced-motion clocks; RL-17. |
| A63 | VERIFY | ROW-05 2/2/1 same-map rows through real HTTP and final providers; RL-18/23. |
| A64 | PARTIAL | Expansion, resized layout stable-anchor preservation and oversized blocks; RL-13/15/18. |
| A65 | OPEN | <=8 same-row-range fragments and preflight rejection without omissions; RL-18. |
| A66 | VERIFY | Exact continuous overlap membership remains independent of integer fetch envelopes; RL-18/23. |
| A67 | PARTIAL | Existing contextual results plus complete privacy/ancestor/expansion scopes; RL-02/06/18. |
| A68 | VERIFY | Preserve current delayed-response guards and extend to all new async services; RL-20/23. |
| A69 | OPEN | Pinned/live five-write-per-second behavior with geometry lineage/revocation; RL-10/17/18. |
| A70 | PARTIAL | Full payload/admission/cache enforcement and authorized aggregate drill-down; RL-18/19. |
| A71 | PARTIAL | Both required camera profiles, complete glyphs and manual accessible bounds; RL-15/23. |
| A72 | PARTIAL | Controlled supported-tier cold/warm/frame/memory/live distributions; RL-21. |
| A73 | OPEN | Full security/restore plus clean supported-platform restart/install matrix; RL-06/08/22/23. |
| A74 | OPEN | G0-G5 and per-clause traceability, zero unresolved mandatory evidence; RL-23. |
| A75 | PARTIAL | Python single writer already exercised; full legacy migration and clean platform proof; RL-09/22/23. |
| A76 | VERIFY | Same-source reproducible bundle with expanded asset/license closure; RL-22/23. |
| A77 | PARTIAL | All required common workflows offline on actual supported browsers, not Edge alone; RL-19/23. |
| A78 | VERIFY | Complete admitted source traversal after new scopes/relationships/fragments; RL-18/23. |
| A79 | PARTIAL | Authorized complete source-set packages and model/schema/asset closure during writes; RL-02/06/09. |
| A80 | PARTIAL | Current strict imports plus large cancellable parse/assets/legacy-review paths; RL-09/15/19. |
| A81 | PARTIAL | Cross-language properties for all new scope/schema/group/fragment/asset contracts; RL-23. |
| A82 | OPEN | Full Local schema/filter/group/view/settings/batch authoring and complete export; RL-02-05/08/11. |
| A83 | PARTIAL | Pure Local works; configured <=2s probe remains usable and never switches late; RL-20. |
| A84 | PARTIAL | Existing fallback/race evidence extended to every phase and explicit compatibility changes; RL-20/23. |
| A85 | PARTIAL | Model recovery exists; complete record/source-scoped outcome state and reload flow; RL-11/20. |
| A86 | PARTIAL | Existing staged switch plus explicit incompatible filter/model adjustments and edit retention; RL-04/20. |
| A87 | PARTIAL | Current token/CORS checks plus real role revocation, restore and complete file-origin matrix; RL-06/20/23. |
| A88 | VERIFY | Existing eleven-unit/format arithmetic retained; full runtime/zone-boundary evidence; RL-17/23. |
| A89 | PARTIAL | Multiple differently scaled bands, all controls and no numeric/paging regression; RL-13/14/17. |
| A90 | OPEN | Full-capacity worker/cooperative fallback/cancellation/memory/frame qualification; RL-19/21. |
| A91 | PARTIAL | Current 15-page preview is not all sixteen required target-state comparisons; RL-13/15/23. |
| A92 | OPEN | Exact-candidate G0-G5 and full release handoff evidence; RL-23. |

## Legacy and Companion Coverage

The 241 LC identifiers remain stable. The historical matrix's per-row support column describes an earlier increment; do not copy its old 'Gap' label onto features now implemented. The ranges below collectively account for all 241 IDs while retaining the original individual source evidence and acceptance text. Every activated capability still needs import/render/edit/save/reload/export and relevant provider/browser result links.

| Inventory IDs | Current release disposition |
| --- | --- |
| LC-A01-A08 | PARTIAL: artifact classification and safe visual dry-run exist; full two-template/four-filter activation and relationship migration remain RL-01/09/13. LC-A07 is an inventory fact, not a missing third template. |
| LC-I01-I38 | PARTIAL: core navigation and source guards work; full target/camera/threshold/buffer/motion/clock/instance matrix remains RL-11/14/23. Do not reproduce legacy coordinate/URL/timer defects. |
| LC-L01-L17 | PARTIAL: measured first-fit, baselines, icon spacing and nested continuation now exist. Remaining full-block reuse, complete profiles, footprint-only context, multiband/camera/live stress and independent final bounds belong to RL-13-15/18/23. |
| LC-P01-P19 | PARTIAL: named-zone/style/inspector subset exists; view dimensions/time/source bindings, broader fonts and camera activation remain RL-04/09/13/15. P06/P07 model-owned transport remains EXCLUDED; P05 never authorizes arbitrary URL/path access. |
| LC-C01-C05 | PARTIAL: orthographic implemented; source-derived Perspective and projected interaction require D06/RL-13/15. C03 initialization defects and C04 oversized transient geometry are corrected, not preserved literally. |
| LC-B01-B34 | PARTIAL: independent palettes, axis position/unit/formats, bar/radius/label styling now exist. Band sizing/order, more detail bands, spacing/subdivisions, font/assets/depth/grouping semantics remain RL-13/15/17. B11/B26/B27/B30/B34 are derived state; B21/B24/B25 lack demonstrated authored effect; retain precise inactive/derived diagnostics rather than activate them. B31 becomes bounded provider prefetch policy, never a full-list requirement. |
| LC-G01-G05 | PARTIAL: safe primitive data-path grouping and source styling work. Schema/value discovery, saved-filter grouping precedence and documented array-value behavior remain RL-02/04/18; G02's unconsumed old field is not proof of a working alternate-color effect. |
| LC-R01-R13 | PARTIAL: color/text/font size/400-700/italic/background and nine icons work. Broader approved icon/image/material/family mappings and explicit alias/ownership semantics remain RL-09/15. R10/R11 unforwarded legacy effects stay inactive provenance, not mandatory imitation. |
| LC-T01-T37 | VERIFY: all 35 finite format IDs, DEFAULT and corrected padding/month/24-hour/large-year behavior exist. Preserve exact tests through migrated models, all supported zones/platforms and per-band formatting; RL-09/17/23. Do not reimplement these as absent. |
| LC-U01-U11 | VERIFY: all eleven scale units exist; retain exact boundary/long-domain/navigation properties and configurable week/multiple rules, RL-17/23. |
| LC-U12-U13 | EXCLUDED as usable scales: EPOCH/ERA negative sentinels have no verified valid scale. Required import diagnostics retain originals and block activation, RL-09/23. |
| LC-S01-S08 | PARTIAL: complete source admin/migration remains RL-03/09. S05's fourteen non-JSON runtime connectors remain EXCLUDED; S08 deployment/Swagger artifacts are not visual models. Separate same-basename/disabled/duplicate namespaces and reviewed ownership. |
| LC-D01-D15 | PARTIAL: full nine-data-file/envelope/sidecar/zone migration is absent, RL-09/16. D14 recurrence execution remains EXCLUDED while metadata is preserved. Invalid D02/D07-D09 originals require explicit separate repair, never permissive silent import. |
| LC-K01-K15 | PARTIAL: search grammar, safe transient highlights, basic menu, model lifecycle and stale-source safety now exist. Account/calendar/overview/camera/help/saved settings/search navigation and full relationships remain RL-04/06/13/14/18/20. |
| LC-X01-X11 | PARTIAL: historical proposal names are not current schema. X02/X06/X07 and much of X03/X04/X05/X09 now have bounded implementations; complete bands/assets/spacing/camera/view/source migration remain D07/RL-09/13/15/17. |
| LC-V01-V03 | PARTIAL: actual new screenshots exist, but exact reconstructed source-backed template/reference comparisons and remaining behaviors are still RL-09/13/23. |

Other mandatory companion cases must be attached individually in the executable manifest:

| Companion IDs / fixture | Remaining evidence |
| --- | --- |
| I01-I14 in [interaction audit](legacy-interaction-audit.md) | All target/lifecycle/clock/camera/edit/independent-instance cases, RL-11/13/14/23. |
| L01-L14 in [layout audit](legacy-layout-audit.md) | Independent actual-ink bounds for full profiles/bands/cameras/nesting/live/overflow, RL-13-15/18/23. |
| MS01-MS15 in [menu/search audit](legacy-menu-search-audit.md) | Complete menu, exact search sets, schema privacy, navigation, live/multi-instance and large-data evidence, RL-02/06/10/13/14/18/23. |
| LB01-LB58 in [brief coverage](legacy-brief-coverage.md) | Keep each existing preserve/correct/exclude decision; map retained items to runnable tests, including CI/contribution/source policy and Classic visual geometry. LB07 does not authorize databases; LB58's implementation gate is now activated by user authorization. |
| Classic-14 / Dark-40 | Exact fixtures remain separate from the 48-record sample. Runtime identity, geometry/edit, 5_1/0_3 and all compatibility models still need their dedicated results. |
| AS-MAP-01 / AS-UI-01 / ROW-05 | Retain independent numeric/illustrative/paging oracles without treating the hand-authored map or row arrangement as automatic solver output. Existing core evidence needs final-bundle/profile/matrix attachment. |
| LOCAL-COMPLETE / PROVIDER-PARITY | Expand existing fixtures with all new catalogs, policies, schema/asset dependencies, fragment/context and failure cases; exact sets/counts plus declared geometry tolerance. |
| Boundary/privacy and scale tiers | Add truly permission-hidden fields, two workspaces, bidi/glyph cases and normative 100-group/nested/ongoing 100k fixture. Existing ten-source service benchmark is not that fixture. |

## Release Gates and External Evidence

Most remaining work is implementable within the repository. A missing feature, slow startup or unavailable test harness is not an external certification exemption.

| Gate | Baseline status | Required exit evidence |
| --- | --- | --- |
| G0 | PARTIAL | D01-D08 resolved, full file/capability manifest, native contracts, complete fixture hashes, supported runtime/browser/filesystem/asset registry and per-clause test map. |
| G1 | PARTIAL | Existing unit/parity/build/Ruff results preserved; add formatting, JavaScript lint, applicable static/type checks, every new component property and offline dependency closure. >=1,000 independent seeded cases per required mapping/layout property, not aggregate iterations relabeled as per-property coverage. |
| G2 | PARTIAL | Real HTTP and real JSON on Windows/NTFS and Linux local-volume container: full resource/auth/batch/fault/retry/audit/import/restore/live/admission matrix. Mock success cannot establish storage semantics. |
| G3 | PARTIAL | All common workflows in Server and file:// Local, every required model, fragments/contexts, live changes, explicit edits, multiple instances and retained source/outcome safety on exact production build. |
| G4 | OPEN | Sixteen target states plus required variants, actual canvas/DOM/ink bounds/diffs, automated and manual accessibility, hostile boundary/security tests and controlled performance/resource distributions. |
| G5 | OPEN | Clean checkout/package/locked install/build/start/migrate/restart/restore on full supported matrix, isolated single-file execution, commit-bound report and all mandatory IDs closed. |

Required platform work is Windows/NTFS server plus actual Chrome, Edge and Firefox; Linux single-writer container/local persistent filesystem plus Chromium and Firefox. Run standalone file:// on those browsers without server processes/network/sibling assets, worker enabled and denied. Cover 1600/1440/1280/1024/390 widths, 360/768/1200/1440 boundaries, DPR1/2, 200% zoom, keyboard and touch-pointer paths. Availability of a Linux host/container, Firefox/Chrome binaries and an assistive-technology test environment may require environment setup or operator access; record a blocked run precisely, never turn it into a pass or silently remove the platform.

Manual WCAG 2.2 AA review needs keyboard/focus, screen-reader names/selection/page announcements, non-color cues, contrast, reduced motion, touch alternatives and accessible full text. This does not require an invented external certificate, but automation alone cannot establish conformance. Native Safari/iOS and physical-device certification are required only before advertising those additional environments; WebKit or viewport emulation is not equivalent evidence.

OS-crash/power-loss assurances need filesystem/platform-specific evidence and an explicit guarantee statement. Process-kill tests establish only their exercised failure model. Licensed font/asset availability and permission to redistribute are real supply constraints; include license records and explicit supported replacements, never silently call a Noto rendering pixel-identical Arial. Legacy runtime may be unavailable despite a documented isolated attempt; that limits observed comparison, not the mandatory source-derived compatibility tests.

Store final evidence at `artifacts/verification/<commit>/<run-id>/`: manifest of commands/exit codes, source/lockfile/build/schema/fixture/font hashes, OS/filesystem/CPU/browser versions, seeds and clocks; machine-readable pass/fail/skip results; sanitized HTTP/storage/stream logs; browser traces/screenshots/diffs; manual accessibility checklist; raw benchmark samples and profiles; security findings; clean-install and restore transcripts; and one requirement/companion-to-test/result map. Preserve prior failures and explain fixes/reruns. Mark any missing entry missing.

## Non-Goals and Precedence

- JSON-only applies to authoritative data, persistence, caches/queues and application-owned configuration. Native assets and external secret configuration remain allowed. Do not add SQL/NoSQL, IndexedDB, a browser database, brokers or NDJSON canonical journals.
- Python replaces Java/Tomcat. Old build/runtime/connector examples are migration evidence, not deployment requirements. No return to language selection is needed.
- The light orthographic two-band application is primary. Classic's exact blue scalar geometry applies only to its explicit Uniform compatibility fixture; it cannot override Adaptive mapping or fixed-height row pages. Extra detail bands and explicit camera compatibility are separately governed capabilities, not permission to change the default.
- Complete Local snapshots are required and limited; ordinary Server row browsing must remain bounded. These are complementary contracts, not a contradiction resolved by downloading all server data or making Local read-only.
- Local changes stay in RAM until explicit JSON export; server durability, identity administration and root backup/recovery are Server-only. Common schema/model/filter/view/source/group authoring must still work locally. No automatic upload/merge or forged server actor identity.
- Recurrence expansion, automatic scheduling/dependency propagation/critical path/resource optimization, external live connectors, multiwriter shared/network-disk deployment, unsafe descriptor code and arbitrary remote assets remain excluded/deferred by the specification. Preserve meaningful metadata and sanitized provenance instead.
- Old prompt-only statements document an earlier authorization phase. The user's implementation/full-release request activates M0-M5 and G0-G5; it does not erase them. Static mockups and historical audit dates remain historical, not newly executed results.

Final completion condition: all applicable original requirement clauses, A01-A92 and retained companion cases have implemented behavior and current required evidence; no unresolved mandatory failure, unsupported silent fallback, missing platform or unreviewed contract discrepancy remains. A larger test total alone does not meet that condition.
