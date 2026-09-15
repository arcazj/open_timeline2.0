# Model and Source Coverage

Generated: 2026-09-15T01:53:46.808Z. Node v24.13.0; Python 3.12.14.

Runtime adapter parity and complete per-property disposition; not pixel-perfect historical rendering qualification.

## Model Ledger

| Model | JS/Python adapter | Catalog dry-run | Input unchanged | Properties |
| --- | --- | --- | --- | --- |
| models/MCC_timeline.json | Same adapted result | blocked | Yes | 36 individually classified |
| models/regular_timeline.json | Same adapted result | blocked | Yes | 34 individually classified |
| models/regular_timeline_earthquake.json | Same adapted result | blocked | Yes | 34 individually classified |
| models/regular_timeline_esoc.json | Same adapted result | blocked | Yes | 36 individually classified |
| models/regular_timeline_mcc.json | Same adapted result | blocked | Yes | 36 individually classified |
| models/regular_timeline_pov.json | Same adapted result | blocked | Yes | 36 individually classified |
| models/SOC_timeline.json | Same adapted result | blocked | Yes | 36 individually classified |
| tests/models/regular_timeline.json | Same adapted result | blocked | Yes | 36 individually classified |

All eight configured models can be adapted at runtime with explicit corrections/substitutions. This does **not** mean that every authored property has equivalent behavior. The JSON ledger records every property, its runtime disposition, and its independent catalog dry-run disposition. Disabled connectors are never activated.

Shared limitations: measured Noto Sans replaces legacy font geometry; fixed placement becomes responsive; independent overview sort/label typography is not applied; inactive alternate-color declarations are not fabricated. Subdivision conversion is explicitly limited to the supported quarter-hour rule. Catalog creation remains blocked until unsupported/restricted properties are reviewed.

## Bounded Real Sources

| Profile | Probe | Metadata ready | Window read | Records | Namespace groups | All configured sources |
| --- | --- | --- | --- | --- | --- | --- |
| multiple_sources_test.yml | latest-day: bounded-window-verified | 21.47 ms | 180.85 ms | 383 | 1 | No |
| earthquake_volcano_data.yml | latest-day: bounded-window-verified | 15.81 ms | 245.08 ms | 251 | 2 | Yes |
| multiple_sources_test.yml | representative-sources: bounded-window-verified | 15.01 ms | 461.55 ms | 1145 | 2 | Yes |

These are single-run, local, foreground-only probes, not percentile benchmarks or full archive scans. Background reconciliation was disabled to bound work. All windows deliberately report incomplete archive coverage. The representative-source probe selects nearby partitions containing record files using directory metadata, with a 31-day maximum span. `no_record_partitions` means a configured source has only empty/descriptor-only date directories, so real combined-source qualification is unavailable; this is not counted as a pass. The Python reader used the repository YAML profiles and only allowlisted `/yyyy/mm/dd` partitions. Sample descriptor lookups use the record identity and namespace. The JSON ledger records sample statuses and before/after hashes without descriptor contents.

- multiple_sources_test.yml, latest-day: descriptor sample {"missing":5,"current":7}; crossing-start sessions 2; all files actually read unchanged: yes.
- earthquake_volcano_data.yml, latest-day: descriptor sample {"missing":14}; crossing-start sessions 0; all files actually read unchanged: yes.
- multiple_sources_test.yml, representative-sources: descriptor sample {"current":13,"missing":11}; crossing-start sessions 0; all files actually read unchanged: yes.

## Reproduce

```powershell
node scripts/qualify-sorting-models.mjs --legacy-root C:/projects/openbexi_timeline
# Models only, without local production data:
node scripts/qualify-sorting-models.mjs --legacy-root C:/projects/openbexi_timeline --skip-sources
```

The command writes only these generated reports and disposable application state outside legacy authorities. It verifies source hashes after reading. Synthetic cross-partition coverage: `tests/server/test_partitioned_legacy_repository.py`; real-HTTP ordering/grouping/collapse parity: `tests/integration/ordering-v2-parity.test.mjs`.

Detailed evidence: [model-coverage.json](model-coverage.json).
