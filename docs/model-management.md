# Visual Model Management

The Model library is available in both Local and Server modes. A model contains metadata, an optional draft and immutable published definitions. These are visual models; custom data-schema authoring is a separate, unfinished capability.

## Workflow

1. Open **Model library**, then create a model or duplicate an existing definition.
2. Edit appearance, measured row/font sizes, grouping, display unit, named time zone and scale settings. An optional versioned presentation adds band palettes/axes, multiline label fields and fonts, source colors, inspector fields, grouping, nesting and baselines. Structured and JSON editors validate the same strict schemas. Unknown properties are errors.
3. Use **Validate**, **Changes** or the isolated **Preview**. Preview queries the active data provider but does not change the application's active settings, records or timeline window.
4. **Save draft** stores a candidate. **Publish** appends an immutable definition version. Neither operation changes the active timeline.
5. Select a published version and **Apply** it explicitly. The workspace default pins that model/version, while the visible time interval is preserved. Publishing another version does not upgrade the pin automatically.
6. To roll back, apply an existing published version or save its definition as a draft and publish a new version. Published history is never rewritten.

In Local mode, saved drafts and published versions remain in browser memory until a complete JSON snapshot is exported. A download request is not a guarantee that the file was saved. Local writes never upload themselves to the Python server.

## Import, Export and References

**Export definition** downloads the selected definition plus portable metadata, not the entire version history. Importing this portable file creates a new model identity and a draft; it never overwrites a matching name or ID. Complete snapshot export/import includes the full catalog, drafts, all published versions and the active pin.

Archive removes a model from the default catalog list without breaking its existing active reference. Archived versions remain readable, but editing, publishing or applying requires explicit unarchive. Permanent deletion is allowed only for an unreferenced model; the workspace default and final catalog entry are protected. Usage checks currently cover the implemented workspace-default reference, not a future global dependency graph.

Original flat presets import as deterministic published version 1 definitions with their original identities. On the server, normalization is persisted atomically with the next authorized mutation, never by an ordinary read. Model metadata and record files share the existing single-writer JSON transaction/recovery mechanism.

## Concurrency and Limits

Every mutation carries a source generation, original command identity and, for an existing model, its expected metadata revision. Conflicting edits preserve the editor draft and require an explicit reload/reconciliation. An uncertain write is resolved by checking its original outcome; it is not automatically retried or copied to another provider.

You can close an uncertain model editor after confirmation. Its recovery command remains bound to the original logical source/generation and returns when that source's model library is reopened, including after a controlled reconnect. For Server mode, only the normalized server identity, workspace/generation and command identifiers are retained in browser storage across reload. Tokens, payloads and private definitions are never persisted by this recovery feature. Storage denial falls back to page memory with an explicit limitation. A missing outcome is not proof of failure and does not unlock another mutation. Local in-memory records and drafts themselves are not persisted by command recovery.

Preview is a read-only snapshot of the current interval and filters. Resize coalesces layout requests against the same immutable query/map, releases superseded layouts and does not change the main timeline. Closing cancels pending work and releases its query. Source-data refresh remains explicit; the preview is suspended before a main query replacement needs its capacity slot.

The current catalog allows 100 models, 32 published versions per model and 20 metadata tags. The shared named-zone registry contains 597 exact-case names/aliases from the pinned time-zone data and the build runtime's supported intersection. A browser that lacks a named zone reports that limitation instead of silently substituting UTC.

The current presentation subset uses four measured Noto Sans Latin profiles (normal/italic, 400/700), approved icons and text-only inspector values. Styles, labels, marker/bar sizes and original-time baselines reserve their actual geometry before row allocation. Nested enclosures continue across pages without inserting or counting duplicate records. Old definitions without presentation remain valid; applying one clears any prior optional presentation instead of retaining stale style settings.

This does not yet implement every legacy band, camera, font/asset, source binding or data-schema capability. See [the presentation contract](presentation-contract.md), [legacy compatibility](legacy-model-compatibility.md), [the exact catalog contract](model-catalog-contract.md), and [implementation status](implementation-status.md). A successful supported-definition workflow is not a full legacy-compatibility certificate.

## Inspect a Legacy Template

The dry-run inspector reads original legacy JSON without evaluating descriptors or connecting to its URLs. It records original-byte SHA-256 and source-path provenance, classifies every JSON pointer, redacts sensitive configuration and lists explicit defaults and unsupported semantics. Production and test templates retain separate identities even when their names match.

```powershell
node scripts/inspect-legacy-model.mjs --input tests/client/fixtures/legacy-production-regular.json --source-label models/regular_timeline.json --output runtime/legacy-production-report.json
```

The output path must be new. This command never creates, publishes or applies a model. `canCreate: false` means unsupported semantics remain; a candidate is not permission to discard those semantics. Both shipped legacy templates currently require additional adapter/rendering work before a complete conversion can be accepted. The report is an implementation aid, not proof that every legacy capability is supported.
