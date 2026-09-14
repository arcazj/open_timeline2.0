# Migration from Java/Tomcat

The new runtime uses Python and ordinary JSON files. It does not load a WAR/JAR, Java servlet, legacy database connector or Tomcat configuration. Keep the old repository and data backed up; do not point development tests at production JSON directories.

The default application starts with a clearly labeled generic fixture or validated canonical snapshot. An optional [read-only legacy adapter](legacy-json-sources.md) now reads enabled JSON-file sources from legacy YAML, including `yyyy/mm/dd` partitions and explicit operating-system path mappings. It preserves original IDs and provenance, namespaces, nested activities and original dates, and applies supported two-band model properties with diagnostics. The Python server indexes the bounded archive without rewriting source files; the export command creates a new, explicitly scoped canonical snapshot outside legacy roots for standalone use.

This adapter is not certification of the full dependency-aware migration or every historical model. Do not rename a legacy events/session envelope and assume it meets the new contract. Use the named adapter and review its report, source-zone/date policy and unsupported-property diagnostics. Disabled sources stay disabled; legacy converters and database connectors are not executed.

Missing legacy end dates historically follow the event branch and must not silently become ongoing sessions. Ambiguous dates, malformed aggregates, unsafe assets and unsupported model values need explicit review/quarantine. Do not import bundled legacy credentials or certificates. Automatic recurrence, scheduling and external databases remain outside the current product boundary.

The full migration requires canonical comparison fixtures, all-model field coverage, independent backup/restore verification and actual old/new runtime comparisons where feasible. Those acceptance obligations remain open until their commit-bound results are recorded.

## Canonical JSON Storage Migration

The offline `scripts/migrate-storage.py` command converts an existing canonical
individual-record JSON root into a new authoritative JSON-shard root. This is a
storage-layout migration, not a legacy data importer. The source remains unchanged;
the destination must not exist, and the command never activates it automatically.

Both input paths are checked for symlinks, Windows junctions/reparse points, and
non-directory ancestry before resolving aliases. Original prefixes are inspected
before `..` normalization, so an unsafe prefix cannot disappear during canonicalization.
Equivalent or nested source/destination paths and ambiguous drive-relative paths
are rejected. Use a direct, regular path with an existing destination parent.

The command rechecks destination ancestry and root identity during staging, refuses
existing output members, and only removes its completion marker after validation
under that same destination. An interrupted or redirected migration preserves the
incomplete staging tree for inspection. It performs no recursive cleanup and never
removes source files or follows an alias to clean up another directory.
