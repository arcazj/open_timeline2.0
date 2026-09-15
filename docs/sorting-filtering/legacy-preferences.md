# Legacy Preferences

Legacy event/session JSON, source YAML, imported schemas and models remain read-only. Saved filters, views and personal/workspace settings use an application-owned JSON store. This feature does not enable event CRUD or rewrite the source files.

## Configuration

Global YAML profiles default to a `preferences` child directory below `server.state_root`. Override the location with `server.preferences_root`, which must remain a dedicated child of that state directory. Set it to `null` to disable preferences. Direct legacy configuration without an explicit preferences root keeps the original fully read-only behavior.

```yaml
server:
  host: 127.0.0.1
  port: 8765
  local_browser: true
  state_root: ../var/legacy-server
  preferences_root: ../var/legacy-server/preferences
```

The existing state-root protection keeps application state disjoint from source/model authorities. Preference paths additionally reject symlinks/reparse points and cannot select the state root itself. No source path is accepted from a browser as a preference destination.

## Persistence

`preferences.json` stores app-owned filter/view publications and drafts, settings, a preference revision, and idempotent command outcomes in one checksummed document. A lifetime exclusive lock prevents two server writers. Writes use a temporary file, flush/fsync and atomic replacement, reusing the existing JSON storage helper. Ambiguous failures after replacement retain the command identity and recover the durable outcome before retrying.

The store is bound to a hash of the configured authorities. A mismatched or corrupt store fails closed; it is not silently replaced. Catalog writes still use the existing permission checks, resource revisions, immutable publication versions and idempotency headers. Imported catalog items may be duplicated or applied, but cannot be modified in place.

The current safety ceilings are 16 MiB for the document and 256 stored command outcomes. Reaching either returns `preferences_capacity` without deleting histories or treating an old command key as new. Export required configurations before rotating a full preference directory. Do not manually edit a live store.

## Revisions

Data query snapshots preserve their source generation and data revision and add a separate `manifest.preferencesRevision`. Configuration API revision values describe the preference document, not a new version of legacy records. A saved definition always pins published model/filter/schema versions; changing preferences cannot claim that source records have changed.

Exports include applicable settings and app-owned catalog entries alongside the complete selected data snapshot. The source snapshot timestamp remains the source-data timestamp. Offline changes, when enabled by the exported capability, are local changes and require an explicit export; reconnecting does not implicitly publish or synchronize them with the server.

`manifest.localPreferencesPrincipalId` selects the exported personal settings when the file opens through the Local provider. The value is bounded to 128 code points and is used only as an unverified local owner, never as server authentication. Original personal resource ownership remains intact. Exported transient edits are marked `preferencesSource: local-export`; subsequent Local provider edits use `local-memory`. Both keep the originating server preference revision when available. Exports prune app-owned catalog identity markers to the resources actually authorized for export.

Before allocating a captured preference set, query admission charges its existing object graph plus a conservative allowance for two container copies and deepcopy bookkeeping. Rejected admission cannot allocate a preference capture or retain a query handle. This accounting is not a claim about total process RSS or native engine memory.

## Verification

`tests/server/test_legacy_preferences.py` exercises lifecycle publication/application, reopening the store, complete authorized snapshot export, separate revisions, immutable legacy configuration families, source-file hash preservation, exclusive locks, path boundaries, checksum failure, personal settings and an injected failure after atomic replacement. `test_legacy_preferences_api.py` covers eager/lazy HTTP query pinning and descriptor selection; `test_legacy_preferences_budget.py` covers rejection before capture. Client preferences and existing read-only tests cover selective mutation gates and personal export round trips. These focused checks do not replace the full browser authorization and release matrix.
