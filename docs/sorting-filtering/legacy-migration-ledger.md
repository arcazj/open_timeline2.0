# Legacy Migration Ledger

The read-only local audit inspected 20 configuration files and 52 saved/source filter entries in `C:/projects/openbexi_timeline`. All configuration hashes were unchanged. The complete originals, file hashes, JSON pointers, diagnostics, proposed drafts and per-model field-registry policy are recorded in [legacy-migration-ledger.json](legacy-migration-ledger.json).

| Result | Entries | Meaning |
| --- | ---: | --- |
| Exact | 48 | Empty predicates with `sortBy: NONE`; no filtering behavior is invented. |
| Intent repair | 4 | Explicit grouping is retained, but deterministic ordering replaces legacy encounter order. |
| Blocked | 0 | No nonempty ambiguous or unsupported expression occurred in this local inventory. |

The four unapproved changes are `BY_NAMESPACE` in `default_filter_setting.json`, `guest_ob_timeline_2_filter_setting.json`, and `test_ob_timeline_2_filter_setting.json`, plus `By_STATUS` in the test preset. Each requires acknowledgement of `deterministic-group-order`; none was published or activated by this audit. The preset named `BY_NAMESPACE` in the arcazj file actually declares `sortBy: NONE`; its name is not treated as executable configuration.

## Scope And Limits

This audit reads `filters/*.json`, `yaml/*.{yml,yaml}`, and `tests/yaml/*.yml`, using structured parsers with file-size limits and no aliases. It does not traverse source records, run legacy regex engines, connect to a database, or activate a source. Regex compilation, where needed, uses the same bounded v2 RE2 migration gate as the application. Client `filter_value` strings are not guessed apart at ambiguous pipes.

Each rendering model uses the approved built-in field registry plus the published legacy namespace field. Render labels are not declarations of custom data types; additional fields still require explicit published schema pins. The ledger references every local model but does not claim that rendering and filtering are interchangeable contracts.

The 48 empty expressions provide no evidence for nonempty legacy regex equivalence. Adversarial and nonempty examples belong to the separate shared migration and regex fixtures. The four grouping repairs remain unapproved. Operator-selected source connections, custom field schema definitions, user acceptance and historical pixel fidelity remain outside this dry-run evidence.

## Reproduce

```powershell
.venv/Scripts/python.exe scripts/audit-legacy-filter-migration.py --legacy-root C:/projects/openbexi_timeline
```

The report is generated inside the new project. The script refuses to write its output inside the legacy project and verifies that inspected configuration files remain unchanged.
