# Visual Model Catalog: Increment 2 Contract

This increment implements versioned management of the currently supported visual definition. It does not claim every legacy property, data-schema lifecycle or source/filter administration is implemented. Unsupported definition fields are rejected, never silently dropped. Both providers implement the same contract.

## Canonical Data

`snapshot.models` accepts old flat presets for import compatibility, or canonical envelopes:

```json
{
  "id": "stable-slug-or-uuid", "name": "Operations", "description": "",
  "tags": [], "revision": 1, "lifecycle": "active",
  "createdAt": "2026-09-12T00:00:00.000Z", "updatedAt": "2026-09-12T00:00:00.000Z",
  "draft": null,
  "versions": [{"version": 1, "publishedAt": "2026-09-12T00:00:00.000Z", "definition": {
    "theme": "light", "rowHeight": 32, "fontSize": 13, "groupBy": "none",
    "displayUnit": "HOUR", "timeZone": "UTC", "scaleMode": "uniform", "ratio": 4, "bins": 128
  }}]
}
```

IDs match `[A-Za-z0-9_-]{1,128}`. Name is 1-100 characters, description at most 2000, at most 20 unique tags of 1-40 characters. Revision is an optimistic concurrency counter. Lifecycle is active or archived. At most 100 models and 32 immutable published versions per model. New models contain a draft and no published versions. Versions are contiguous starting at 1. Published definitions cannot be edited; rollback means making a draft from an old version, then publishing a new version, or explicitly applying an existing version.

Definitions are strict objects with the nine required fields shown and an optional versioned `presentation` object. Themes: light/classic/dark. Requested row height is integer 32-128; font size integer 11-24; requested row height must be at least font size + 19. Base grouping: none/sourceId/kind. Display unit is one of the 11 implemented calendar units. Time zone must be an exact supported name in `shared/fixtures/time-zones.json`, not a numeric offset or an arbitrary case alias. Scale: uniform/adaptive, ratio 1-8, integer bins 16-256. JSON/schema validation never coerces types. Both providers use the same named-zone registry; unsupported environment zones fail explicitly.

The optional [presentation v1 contract](presentation-contract.md) defines the implemented separate band palettes/axes/formats, source styles, safe custom-field grouping, label/inspector fields, four measured normal/italic 400/700 Noto Sans profiles, multiline labels, nested enclosures and original-time baselines. Its measured effective layout row height may grow to 192 even though the authored base rowHeight remains bounded to 128. Canonical per-record render overrides and approved icons have their own strict schema. These capabilities survive draft validation, preview, publication, explicit apply and complete snapshot export/import; they do not imply arbitrary fonts/assets, Perspective camera, full legacy conversion or source/schema administration.

Old flat presets normalize deterministically to one published version; use snapshot timestamp for dates and existing IDs, never invent a new ID on each read. Defaults for absent definition fields are HOUR, UTC, uniform, 4 and 128. Snapshot integrity is checked against the original bytes/data before normalization; remove or recompute a checksum after normalization. Do not reseed or overwrite a user's snapshot to upgrade it. `settings.modelVersion` defaults to 1 for an old preset and otherwise must reference an existing published version of `settings.modelId`. Archived referenced versions remain readable/renderable.

## Provider Methods

- `listModels(options={}) -> {items:[canonicalModel], active:{modelId,version}, generation, revision}`. Include archived models unless options.includeArchived is false. Small bounded catalog, no whole record dataset download.
- `getModel(id, options={}) -> {model, usage:[{kind:'workspace-default',modelId,version}], generation, revision}`.
- `validateModel(definition, options={}) -> {valid,errors:[{path,code,message}]}`. Read-only, no new catalog objects.
- `executeModelCommand(command, options={}) -> {model:null|canonicalModel, settings, durability,generation,revision}`.

Command fields are `{type,modelId?,expectedRevision?,generation,clientCommandId,payload}`. Types: create, update, publish, archive, unarchive, delete, apply. Create payload is `{name,description?,tags?,definition}`. Update accepts only optional name/description/tags/draft (at least one); draft is a complete definition, not a patch. Apply payload is `{version}`; other lifecycle payloads are empty. Duplicate is an explicit create with a copied published/draft definition and a new name/identity. Import a portable definition as a new draft, never overwrite a colliding ID.

Every command requires source generation and an idempotency key; every existing-model command requires expectedRevision. Same key/content returns the original result, changed content conflicts. Revision mismatch is 412, missing preconditions 428, missing model 404, references/lifecycle/generation/key conflict 409, invalid data 422, capacity 413. Unknown write replies retain original identity and support read-only outcome lookup, never automatic retry or Local replay.

Publish requires an active model with a draft. Append one immutable version, clear draft and increment model revision. Publication does not change current settings or any pinned view. Update/archive/unarchive likewise increment model revision. Archived models cannot edit/publish/apply; unarchive is explicit. Applying a published version atomically updates workspace default `settings.modelId`, `settings.modelVersion`, and all nine required definition settings. It copies the version's optional presentation into settings, or removes any previous settings.presentation when that version has none; immutable old versions are not backfilled. Navigation ranges/referenceTime and filters remain unchanged. Apply increments workspace revision, not model revision. UI application is explicit, refreshes active settings and preserves temporal focus. The existing renderer need not load models to query records.

Delete permanently removes only an unreferenced model; reject the workspace default and last catalog model. No published-history truncation or silent default reassignment. Usage presently covers this implementation's one workspace-default reference, not an unimplemented global dependency graph.

## Python Routes

Base `B=/api/v1/workspaces/default`:

| Method | Route | Body |
| --- | --- | --- |
| GET | B/models | Optional includeArchived query flag |
| GET | B/models/{id} | - |
| POST | B/models/validate | {definition} |
| POST | B/models | Create payload |
| PUT | B/models/{id} | Update payload |
| POST | B/models/{id}/publish, /archive, /unarchive | {} |
| POST | B/models/{id}/apply | {version} |
| DELETE | B/models/{id} | - |

All routes require Bearer authentication. Mutations require `X-Workspace-Generation`, `Idempotency-Key`, and for existing-model operations `If-Match: "<generation>:<modelRevision>"`. A model GET exposes that model ETag. Create returns 201; other mutations 200. Existing command-results endpoint returns raw model result; ServerProvider normalizes it to `{state:'committed',result}` just as for record outcomes. Workspace metadata exposes modelManagement/modelPublication capabilities.

Use the existing JSON writer lock and redo journal to install workspace metadata, catalog, settings, revision and command outcome atomically. Record files are not rewritten for model commands. Local uses the existing command queue and memory-only durability. Pinned query/layout data remains valid after catalog mutations; an explicit Apply may create a new query for changed scale/grouping.

Browser Local mode normally hosts this same provider/catalog core in the self-contained embedded Blob worker. Startup-denied or unavailable workers use the direct provider; there is no separate catalog algorithm. Public reinitialization refreshes metadata after retained-branch changes. A lost dispatched model response retains its original outcome identity and is never automatically replayed or used to start a fresh Local branch. Worker failure/disposal and direct fallback limitations are documented in [standalone mode](standalone-mode.md).
