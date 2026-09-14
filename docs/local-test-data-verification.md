# Local dataset verification - 13 September 2026

Delivered standalone build SHA-256: `7c5c88efee8e9345f168f2e90c3e29249cc3b849e6c867eaf37807f17240eea8`.

## Completed Checks

| Check | Result |
| --- | --- |
| Normalization and original hashes | 2,349 input records, 2,349 output records, none dropped |
| Repeatable normalization | `--check` passes, including separate Python processes with two hash seeds |
| Client suite | 228 passed with `--test-concurrency=1` |
| Full Python server suite | 936 passed, 1 skipped |
| Dataset-specific Python tests | 12 passed, including the subsequently added hash-seed reproducibility test |
| Real HTTP / local integration suite | 42 passed |
| Edge dataset scenarios | 11 passed on the delivered build |
| Firefox dataset scenarios | 11 passed; both Monet cases rerun successfully after the final age-label refinement |
| Existing Edge browser regression set | 39 passed: Help, calendar/momentum, standalone, models, lazy loading, smooth navigation and viewport layout |
| Record gesture regression set | 12 passed: uniform/adaptive drag, cancellation, precise time editing, recovery, source-policy guards and offline export |
| Docker client and runtime builds | Passed |
| Read-only Linux runtime smoke | YAML resolution and complete 730-record Religions snapshot passed without network access |
| OpenAPI artifact | Generated contract matches handlers and schemas |
| Standalone runtime imports | None external |

The server skip is `test_record_symlink_and_recovery_parent_symlink_are_rejected`: this Windows account cannot create the fixture symlink (WinError 1314). It is not reported as a passing test. Existing Starlette/httpx and AnyIO deprecation warnings remain.

One existing timing-sensitive change-monitor assertion failed during a heavily concurrent client/server/browser run. The complete client suite passed when rerun serially; no unrelated runtime change was made to conceal that result.

## Capture Evidence

`docs/ui/test-data/*.verification.json` binds each delivered dataset screenshot to the current HTML hash, viewport, record count, band count, absence of console/HTTP errors and nonblank main-canvas pixels. Every visible band is also checked for nonblank pixels. Mobile captures verify no document-level horizontal overflow. The full application and isolated timeline images are retained alongside the source references in the [guide](local-test-data.md).

The PDF builder checks capture hashes before producing its eleven pages. PDF pages are rendered with Poppler and visually inspected, including the corrected default loading indicator and mobile age labels. Documentation tools were installed in an isolated temporary environment, not added as application runtime dependencies.

## Remaining Limits

This is not a pixel-equivalence or full-release certificate. Three fixtures have no supplied PNG. Historical dates with uncertainty, the literal Space exploration year 201, missing original artwork and unverified source redistribution rights remain explicitly reported. The Linux smoke test is not a full container integration/browser matrix. Read-only archive table scopes remain tied to the current query window; navigation or a complete export provides access beyond it.
