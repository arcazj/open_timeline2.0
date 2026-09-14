# Data Model

The shared record and snapshot JSON schemas live in `shared/schemas`. Records use explicit `event` or `session` kinds, UTC-normalized millisecond instants, nullable session ends for ongoing durations, stable UUIDs and source-scoped revisions. Point and zero-duration membership uses `[from,to)`; a positive duration intersects when its start is before to and its end is after from. Long sessions are not found through start-date folders alone.

A `timeline-snapshot` envelope contains manifest, records, zones, models, filters and settings. Complete means complete for the manifest's declared workspace/source universe, not current server freshness or authenticated authorship. Counts, duplicate IDs, schema/time/relationship rules and source boundaries are validated before a Local source is activated. The initial source is explicitly labeled Operations sample. Portable content never contains a token or server filesystem root.

Source identity includes provider epoch and workspace generation/revision. Local edits retain origin provenance but use a separate memory branch. Browser downloads are explicit export requests, not evidence of a confirmed server commit or arbitrary disk overwrite. Reimport is the reproducible preservation check.

The initial model schemas intentionally cover light, Classic-blue and dark themes, grouping, row height and font size. This is not the complete legacy model-field or immutable publication contract; see implementation status. The normative source-verified inventory remains the release target.

Font metrics and Unicode 15.1 casefold data are deterministic shared fixtures. Text is stored unmodified; normalization/casefolding is for comparison. Canonical timestamps are not fractional-millisecond view positions. Continuous mapped bounds use decimal strings, preserving the required mapping/inverse precision without changing stored events.
