# Smart Drag Verification

September 15, 2026. Implementation-candidate evidence, not stable-release certification.

Final standalone bundle SHA-256: `1229727bc581b884aecd86b5a1647825cb35aaa815292a9bdf6279fe75c1527f`.
Two consecutive builds produced the same HTML hash. Browser reports record their tested bundle hash in their metadata.

## Final Geometry Checks

Final review corrected one isolated helper, `client/src/timeline/navigation-preview-projection.js`: comparison baselines now follow their authoritative original timestamps beyond the old query map, including point events and zero-duration records. Rows, labels and canonical layout metadata remain unchanged. The affected checks were rerun on the final build:

| Check | Result |
| --- | --- |
| Client unit tests | 495 passed |
| Local/server integration and parity | 70 passed |
| Navigation, baseline pixels, keyboard and model-preview matrix | 54 passed across Chromium, Firefox and Edge |
| Complete presentation suite | 9 passed |
| Final descriptor capture checks | 2 passed |

Final reports include `client-122.tap`, `parity-122.tap`, `smart-drag-final-122-navigation-final.json`, `smart-drag-final-122-presentation.json` and `smart-drag-final-122-descriptor-captures.json`. The slow-preparation scenario also passed twice per browser in `smart-drag-final-122-status-gate-verified.json`; it delays status reads after a real allocation acknowledgement, so it tests slow preparation independently from lost-allocation recovery.

## Broader Regression

Before that baseline-only correction, the complete regression ran on bundle `06252380938e6469bc9fe16f967c67cde5bc04aef1251fc284fb7dfea0dc94dd`:

| Check | Result |
| --- | --- |
| Python server tests | 1,141 passed, 1 skipped |
| Complete default browser suite | 227 passed in two one-worker shards |
| Navigation, canvas, keyboard and model-preview matrix | 48 passed across Chromium, Firefox and Edge |
| Descriptor/configuration/reconnect browser matrix | 87 passed across Chromium, Firefox and Edge |
| Standalone, datasets, filtering and toolbar browser matrix | 90 passed across Chromium, Firefox and Edge |

The two default shards executed 114 and 113 tests. Their 227 unique IDs exactly match the complete collection, with no missing or duplicated cases. All reported browser runs used zero retries and finished with zero failures, skips or flakes. The full default suite was not repeated after the isolated baseline correction; final-build qualification targets the affected rendering paths plus the complete client and parity suites. The Python backend did not change after its full test run.

The Python skip is `test_record_symlink_and_recovery_parent_symlink_are_rejected`: this Windows environment cannot create the required symlink (`WinError 1314`). It is not counted as a pass. Ruff, generated OpenAPI consistency, all six dataset normalization checks and the historical sorting-analysis audit passed. The 60-case offline regex fixture passed in Python, Chromium and Firefox, with zero browser HTTP requests.

Local reports are retained under `artifacts/verification/` and `artifacts/browser/`; raw traces are not published with the application. Broader regression reports are `smart-drag-final-062-default-shard1.json`, `smart-drag-final-062-default-shard2.json`, `smart-drag-final-062-default-proof.json`, `smart-drag-final-062-descriptors-final.json`, `smart-drag-final-062-other.json` and `smart-drag-final-062-navigation-verified.json`.

## Actual Captures

These are unedited final-build application screenshots, not mockups or performance benchmarks. Chromium 153.0.8010.12 was used at device-pixel ratio 1. The drag viewports are 1600 x 1000 and 390 x 844; the descriptor viewports are 1600 x 900 and 390 x 844.

In the four-event drag fixture, the future record was prepared before entering the viewport. Tests assert its rendered marker pixels, unchanged row position, pinned query/map/page, bounded cache and one active preparation. The clean captures wait for the temporary import notification to disappear and independently check marker pixels, row stability, ready coverage and zero native horizontal scrolling. The orange zone is test data. Text at viewport edges clips normally during panning.

![Desktop timeline during a drag with a prefetched future event and synchronized overview](ui/smart-drag/desktop.png)

![Mobile timeline during the same prepared-record drag](ui/smart-drag/mobile.png)

The descriptor captures use generic legacy fixtures: server-side linked metadata on desktop, and complete inline snapshot metadata with expandable values on mobile. Status values such as `FAILED` are fixture record fields, not application loading failures.

![Desktop legacy timeline with a long selected session and linked descriptor](ui/smart-drag/descriptor-desktop.png)

![Mobile legacy descriptor with original dates and expandable nested metadata](ui/smart-drag/descriptor-mobile.png)

## Scope And Limits

Coverage includes cancellation, stale responses, long sessions, namespace-safe preview placement, vertical pages, descriptor retention, table/CSV admission, same-principal cross-tab contention, standalone imports and delayed server work. Keyboard checks cover offscreen prepared labels, focus retention and restoration of authored clipping. Reconnect checks cover preserved view settings, changed authority/generation, unresolved writes and newer navigation or file-import intent. Legacy JSON and YAML remain read-only.

The mobile coast distance test uses controlled browser time and actual pointer events for reproducible gesture timing. Its frame samples are not performance measurements; separate real-time desktop glide and click-stop tests remain enabled. Network failures, arbitrarily fast gestures and layouts requiring additional rows can still produce explicitly marked partial coverage. See [smart-drag behavior and limits](smart-dragging.md).

Manual accessibility/usability review, production-scale performance distributions and the broader release gates remain separate qualifications. GitHub CI results must be checked for the pushed commit; local success does not imply that remote checks or a stable release are complete.
