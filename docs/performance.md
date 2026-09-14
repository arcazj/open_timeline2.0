# Exploratory Performance Measurements

## Versioned Release Fixture

The new `release-mixture-v1` generator supplies the previously missing complete
fixture mixture. It does not turn the historical results below into measurements
of the new data. Generate a new, isolated fixture directory with:

```powershell
.venv/Scripts/python.exe scripts/generate-performance-fixture.py --tier typical --output artifacts/performance/fixtures/typical-v1
```

`small`, `typical`, and `stress` contain 1,000, 100,000, and 1,000,000 records.
Each has ten JSON sources, exactly 100 published groups, three-level activity
trees, simultaneous dense clusters, distributed historical sessions, ongoing
sessions, zero-duration sessions, long boundary-crossing sessions, 480-character
labels, tombstones, original-time baselines, and sparse measurements pinned to a
published schema. Three overlapping zones include one spanning the entire
overview. All names and activity data are generic. The stress tier remains
unsupported until measured; generation alone is not a scale qualification.

The recipe and fixed snapshot timestamp are deterministic. Its manifest records
counts, average serialized record bytes, complete snapshot/content SHA-256, and
the generator and seed-source hashes. Complete canonical validation occurs before
output; the average serialized record must be at most 2 KiB. Existing output
directories are rejected. The generator never edits a live data root and does not
claim to measure production import throughput. Generation and validation time are
not server readiness time. The fixture contract is covered by
`tests/server/test_performance_fixture.py`; the full five-cold/thirty-warm,
20-client/five-writer experiment remains separate work.

### Benchmark the Versioned Fixture

The server harness accepts an optional tier without changing its historical default:

```powershell
.venv/Scripts/python.exe scripts/benchmark-server.py --fixture-tier small --storage-layout shards --skip-full-layout --output artifacts/performance/small-mixture-smoke.json
.venv/Scripts/python.exe scripts/benchmark-server.py --fixture-tier typical --storage-layout shards --startup-only --output artifacts/performance/typical-mixture-startup.json
```

The tier fixes its count; a conflicting `--records` value is rejected. `stress`
is an explicitly unsupported million-record experiment, still subject to the
per-phase supervisor deadline. The complete validated seed retains the recipe's
snapshot hash, while the separately materialized server metadata is marked as server
data. Both individual-file and authoritative-shard layouts are supported.

Tier reports include the fixture summary, exact seed/recipe hashes and before/after
hashes of the measured server, schemas, font metrics, dependency lock, and harness.
`sourceStateStable:false` means code changed during the run and the timings cannot
be attributed to one candidate. No tier run establishes controlled reference
hardware, cleared filesystem caches, percentiles, or the full concurrency gate.
Query phases call `QueryEngine` directly; they do not measure HTTP transport, the
asynchronous preparation coordinator, or browser rendering.

The fixture contains 100 published groups, but this harness currently exercises
`sourceId` layout grouping (ten source groups). Reports explicitly set
`groupLayoutQualification:false`; the data count must not be misreported as a passed
100-group layout test. No-flag commands below continue to use the historical recipe.

## Historical Measurements

Measured on 12 September 2026 on the shared Windows development workstation. These are single exploratory runs, not a passed release-performance gate, p95 estimates, browser frame measurements, or a comparison of equivalent Python and JavaScript workloads.

## Reproduce

```powershell
.venv/Scripts/python scripts/benchmark-server.py --records 100000 --phase-timeout 120 --output docs/performance-results-100000.json
.venv/Scripts/python scripts/benchmark-server.py --records 100000 --phase-timeout 120 --service-only --output docs/performance-results-100000-final.json
node scripts/benchmark-local.mjs 25000
```

The server command refuses an existing report output; use a new report name when repeating these commands. It creates a marked directory beneath the system temporary root, constructs deterministic canonical JSON records, and removes only that verified directory after all workers stop. Every phase has a supervisor-enforced 120-second maximum. A timed-out worker is killed and its incomplete phase is reported as a lower bound, never as a successful duration. The harness first smoke-tested all phases with 100 records. `--service-only` intentionally skips the production startup attempt and per-record fixture files; `--skip-full-layout` permits a bounded focused comparison without the full-month layout phase.

Python phase timings use `perf_counter`. On Windows, memory comes from `GetProcessMemoryInfo`: current resident working set, 50-ms worker samples, and the operating system's process-lifetime peak. The supervisor samples a timed-out worker independently. These are process-memory measures, not JavaScript heap or precise retained-query allocation. Sampling can miss transient peaks; the OS process peak may include an earlier phase.

The machine reports Windows 11 build 26200, Python 3.12.14 64-bit, eight logical CPUs and Intel Family 6 Model 158. The workstation was shared with the development session; its storage hardware, power state, background activity and cache state were not controlled. Earlier exploratory runs overlapped other development work. This is not the frozen 4-core/16-GiB/local-SSD, five-cold-start/thirty-warm-sample reference experiment.

## Server Dataset and Scope

The server fixture contains 100,000 records: 20,000 points and 80,000 finite sessions, ten sources, three statuses, thirty days of regularly distributed starts, 10-119 minute ordinary sessions, and deterministic seven-day long sessions. Each record contains full canonical identity/audit fields, tags, status/system/description metadata and color. The selected detail interval is six hours in the middle of the month. The complete seed is 72,327,873 bytes; the baseline production lane creates 100,001 separate data JSON files. Later service-only runs create the identical seed without those per-record files. Layout uses a 1200 CSS pixel plot, 600 pixel available height, 13 pixel base labels and source grouping.

This is a realistic bounded operational mixture, not the complete normative 100-group/nested/ongoing stress fixture. In particular, it does not establish arbitrary hierarchy, ongoing-session or million-record performance. Fixture construction writes benchmark data files directly; it is explicitly not a production bulk-import or durability throughput measurement.

The production lane calls normal `JsonRepository.open` on those files, then the real immutable query, density, overview, table, row-layout and complete-export implementations. If startup fails or times out, the separate service-only lane hydrates the repository's in-memory structures from the complete JSON seed under an exclusive writer lock. That lane exercises the actual snapshot/query algorithms but **bypasses production startup validation**. Its results must never be reported as successful server startup or end-to-end readiness.

## Server Results

Raw evidence: [baseline](performance-results-100000.json), [cached-time/bin optimization](performance-results-100000-optimized.json), [indexed packing](performance-results-100000-packed.json) and [final service measurement](performance-results-100000-final.json). The final run occurred after the presentation browser suite completed, with no intentional concurrent test or benchmark run. It remains a single uncontrolled-workstation observation, not a percentile.

| Operation | Baseline | Final | Qualification |
| --- | ---: | ---: | --- |
| Production repository startup | >=120 s, timed out | Not repeated | Normal validation/file loading did not complete. |
| Service-only JSON hydration | 7.345 s | 7.234 s | Not production startup. |
| Immutable query plus full density/map | 12.502 s | 6.961 s | 100,000 context records; 33,333 search matches. |
| Cached density manifest | 0.523 ms | 0.530 ms | 128 bins; creation cost belongs to query preparation. |
| Cached map manifest | 0.255 ms | 0.265 ms | 129 knots. |
| Matching overview aggregation | 13.276 s | 42.980 ms | 128 overlap bins; complete context/match totals retained. |
| Full-table sort and first page | 6.078 s | 8.578 s | Title descending, 100 records/page, 1000 pages. |
| Cached next table page | 12.643 ms | 12.710 ms | 100 records, canonical response 76,281 bytes. |
| Global six-hour detail layout and first page | 421.274 ms | 187.245 ms | 1143 records, 481 rows, 27 pages. |
| Cached first row page | Not separately measured | 2.430 ms | 82 record projections, not all 1143 records. |
| Styled six-hour layout and first page | 469.202 ms | 234.427 ms | 1143 records, 481 rows, 33 pages, 40 pixel effective rows. |
| Complete checksum export, encoding and fsync | 8.822 s | 9.038 s | All 100,000 records, 72,328,885 bytes. |
| Global full-month layout and first page | >=120 s, timed out | 12.712 s | 100,000 records, 27,067 rows, 1504 pages. |

The intermediate packing-only run completed the full-month layout in 27.621 s. Removing repeated full-record scans during page-budget preflight reduced the final observation to 12.712 s. The cold table observation got slower rather than faster in the final run; table sorting was not optimized or claimed to improve, and one run cannot identify that variation's cause. First table-page responses were 76,140 bytes; warm second-page responses were 76,281 bytes, both far below the 2 MiB ceiling.

Every successful complete export had identical SHA-256 `e701a35fb1e6a1560908f8b73be9eabbbe13482b04c62974ec0a686e35732ba9`, count and byte length. The final full-month layout returned 136 first-page records and the same 27,067 global rows as the intermediate run. Separate randomized tests compare the optimized allocator against original first-fit ordering and density against independent interval/bin oracles. The benchmark itself does not independently verify every packed footprint or traverse all server table/row pages.

Final service-process peak RSS was 834,994,176 bytes (796.31 MiB), reached during complete export; final RSS after the full-month layout was 750,915,584 bytes (716.13 MiB). Query preparation left RSS at 523,976,704 bytes (499.70 MiB), versus 319,778,816 bytes (304.96 MiB) before it. These are whole-process observations, not a precise per-query retained-memory measurement or proof of the normative 256 MiB global query/layout budget. The baseline successful export's peak was 819,863,552 bytes (781.88 MiB).

The baseline supervisor inadvertently sampled the Windows virtual-environment launcher rather than its child interpreter for timed-out phases. Consequently the roughly 4 MiB supervisor-memory figures for baseline startup/full-layout timeouts are **not valid worker-memory evidence and must be discarded**. Successful phases self-reported their own valid process memory. The harness was corrected to supervise the actual interpreter for later runs. All four runs report `temporaryDataRemoved:true`; no benchmark dataset remains in the temporary root.

## Interpretation and Remaining Bottlenecks

The measured improvements preserve complete data and existing ordering. Query-local parsed timestamps eliminate repeated date parsing. Integer overlap and difference arrays compute exact occupancy and overview counts across the full filtered domain. A coordinate-compressed bitset index selects precisely the first compatible row, matching the original allocator rather than using an approximate packing policy. Its explicit 128 MiB portable index estimate rejects over-capacity work with `layout_capacity`; this estimate is not a bound on operating-system RSS or all retained layout objects. Page-budget preflight now groups item references once instead of scanning every record again for every page.

Query acquisition now uses an isolated internal snapshot that omits the export-only checksum. It still copies the complete authoritative state and retains existing query admission checks; startup/import validation is not weakened. Public snapshot exports always compute RFC 8785 SHA-256, including requests containing unsupported checksum-disabling query parameters. This avoids computing an unused export digest during ordinary query preparation without claiming exports became free.

The later normal-startup investigation below supersedes the original unprofiled startup diagnosis. The fixture already had workspace metadata and no recovery journal/checksum, so neither startup measurement includes seed installation, journal recovery, query computation or export hashing. Validation remains complete before readiness.

That startup failure was not repaired by using the clearly labeled service-only lane. It blocks 100,000-record readiness qualification, not the separately exercised small-dataset preview, and is not evidence of data loss. Cold full-table preparation still visits the complete sorted projection and computes canonical per-item costs for deterministic page boundaries; 6-9 seconds is not a <=300 ms warm-page result. Only the already prepared next page was fast in this experiment.

Final query plus six-hour layout service time was approximately 7.15 s before transport/rendering, while query plus full-month layout was approximately 19.67 s. The latter still exceeds the provisional 10-second complete Adaptive cold-preparation target, and neither sum establishes p95, three-second overview availability, or warm live replacement. The <=3-second complete linear-view target was not measured. The 796.31 MiB single-process peak does not establish the <=2 GiB twenty-client/five-write-per-second target. Startup, full-range latency, complete resource admission and concurrent memory remain release work.

## Normal Startup Follow-Up

[Profiled baseline](performance-results-100000-startup-profile.json) identified
file loading as the actual first bottleneck: after 110 seconds it had read only
18,080 records, with 105.446 seconds in file read/parse versus 3.634 seconds in
record validation. Complete snapshot/schema validation had not started before the
120-second supervisor timeout. These are observed phase counters, not an inferred
claim that schema validation caused the original timeout.

The implementation now reads in deterministic batches of at most 256 queued files,
with at most 32 workers, drains all readers before releasing the owner lock on
failure, performs record-local checks once and relationships once, and normalizes
only catalog metadata rather than copying records for that operation. Strict JSON,
all schema constraints, record sizes, references and available snapshot checksums
remain mandatory. The compiled schema validator is configured with an offline,
explicitly registered schema set; importing a compiled validator is not permission
to fetch remote references or silently reinterpret the schema dialect.

| Normal Existing-Root Startup | Records | Total | Complete Snapshot Validation | Schema Portion |
| --- | ---: | ---: | ---: | ---: |
| [32-reader initial comparison](performance-results-10000-startup-parallel.json) | 10,000 | 13.181 s | 3.386 s | 2.608 s |
| [16-reader comparison](performance-results-10000-startup-16.json) | 10,000 | 13.837 s | 4.346 s | 2.833 s |
| [32-reader compiled validator](performance-results-100000-startup-compiled.json) | 100,000 | 107.667 s | 8.522 s | 0.506 s |

The complete 100,000-record run used normal `JsonRepository.open`, not service-only
hydration. File loading before snapshot validation took 99.145 seconds. Record-local
checks took 5.711 seconds and relationship checks 0.090 seconds inside the 8.522-second
validation phase. Peak process RSS was 644,382,720 bytes (614.53 MiB), with 516,907,008
bytes after startup. Summed worker read times exceed elapsed wall time because reads
overlap; they must not be reported as extra sequential startup seconds. Fixture
construction took 70.444 seconds and is separate from startup. Every follow-up
report confirms `temporaryDataRemoved:true`.

The 30-second readiness target still fails. These single profiled observations are
not controlled p95 evidence or a guarantee that more threads improve throughput.
The final timing predates the later bounded-descriptor read checks and journal-v2
change, so it does not measure their added overhead. The next reviewed direction is
fewer authoritative JSON shard files, not a trusted cache that skips validating
records. See [the storage protocol ADR](adr/0002-json-transaction-v2.md). No new
query/layout/export throughput claim follows from this startup-only experiment.

## Authoritative Shard Follow-Up

[Normal layout2 startup](performance-results-100000-startup-shards.json) measured
**16.369 seconds** for the same 100,000 records, with 25 ordinary authoritative
JSON shards and two manifests instead of 100,001 individual data files. The
benchmark generated this complete inactive fixture, then called normal
`JsonRepository.open`; it did not use service-only hydration, a validation cache
or a sampling shortcut. Every shard checksum/membership, every record schema and
every relationship was validated before readiness.

Loading and shard verification before complete snapshot validation took 5.222
seconds. Bounded descriptor reading/parsing accounted for 3.736 seconds; the
complete snapshot validation phase took 11.148 seconds, including 0.605 seconds
in schema validation, 7.204 seconds in record-local checks and 0.097 seconds in
relationships. Peak RSS was 331,968,512 bytes (316.59 MiB), and final startup RSS
was 326,254,592 bytes (311.14 MiB). Fixture construction took 27.176 seconds and
is separate from readiness. The report confirms `temporaryDataRemoved:true`.

This single observation is below the 30-second target, but **does not pass the
controlled readiness gate**. The sequential UUID fixture naturally yields 25 deep
prefix buckets; ordinary randomized UUIDs and the complete normative stress mixture
need separate trials. No OS cache flush, reference-machine qualification, repeated
cold distribution or concurrent load was established. New schema/source validation
also changed between the earlier legacy-layout and this shard run, so their phases
are not an isolated microbenchmark of storage alone. Query/layout/export phases
were not repeated in this startup-only run; the previously observed full-range
cold latency and concurrent-memory gaps remain unqualified.

Reproduce with a new output filename:

```powershell
.venv/Scripts/python scripts/benchmark-server.py --records 100000 --storage-layout shards --startup-only --profile-startup --phase-timeout 120 --output docs/performance-results-shards-repeat.json
```

The production layout change is explicit: [migrate-storage.py](../scripts/migrate-storage.py)
stages a new inactive root, preserves the old root and requires an operator data-root
switch. It is not an implicit migration or a database-backed shortcut. See the
[protocol ADR](adr/0002-json-transaction-v2.md) for journal recovery, size bounds,
failure behavior and migration evidence.

## Local Dataset and Results

Raw evidence: [Local report](../artifacts/performance/local-latest.json), timestamp **2026-09-13T01:31:40.120Z**, generated by [benchmark-local.mjs](../scripts/benchmark-local.mjs). The values below correspond to that report, replacing the earlier Local measurement. Runtime was Node v24.13.0 on Windows. The complete fixture contains 25,000 records and serializes to 15,987,541 bytes. It uses the shared sample's range and source, regularly distributed starts, points and finite sessions, including long overlapping sessions. It is different from the server fixture; do not compare elapsed times as a provider speed ranking.

| Local Operation | Measured Time |
| --- | ---: |
| Initialize and validate complete snapshot | 1,572.38 ms |
| Create query and full density | 797.36 ms |
| Allocate complete detail layout | 1,728.91 ms |
| Read first row page | 1.30 ms |
| Traverse all table pages | 665.50 ms |
| Complete snapshot export | 413.83 ms |

The layout had 2,044 logical rows; the first page contained 15 records. The harness verified 25,000 distinct IDs with no duplicates across complete table traversal and an export containing all 25,000 records. Final RSS was 421,998,592 bytes (402.45 MiB); `process.resourceUsage().maxRSS` was 427,732 KiB (417.71 MiB). Final JavaScript heap used was 232,627,416 bytes (221.85 MiB). These are Node process measurements, not browser memory or per-query retained memory.

These operations run LocalProvider directly in Node, not through the browser worker wrapper. The report does not identify a source commit or establish which later changes it includes. It measures neither Web Worker execution nor cooperative eight-millisecond slices, cancellation latency, denied-worker fallback, file-open browser responsiveness or frame budgets. Several direct operations lasted hundreds of milliseconds or seconds, so the worker/cooperative-scheduling requirement remains **unmet by this evidence**. The implemented browser execution and failure semantics are documented in [Standalone Mode](standalone-mode.md), with separate browser evidence in [Testing](testing.md). Those worker checks must be evaluated independently; these Node timings do not assert that the updated UI executes all work on its main thread. Fast first-page retrieval does not make initial global allocation nonblocking.

## Release Qualification

No performance gate is marked passed here. Required remaining measurements include controlled cold/warm distributions, 100 groups and nested/ongoing data, twenty concurrent clients and five writes per second, durable-save latency, complete live replacement, browser frame/long-task traces, worker/cancellation/fallback behavior, retained-memory admission, repeat-cycle cleanup and independent correctness checks under load. Single fast reads are useful observations, not substitutes for those gates.
