# Preview Commit Verification

Recorded 14 September 2026 UTC. This is development-preview evidence, not a
stable-release certificate or a report of a successful public deployment.

## Committed Scope

The initial local commit is `c3e0c2151f3dbad5a79771473c5428b34caa273a`.
It contains the application, reviewed publication file selection, README/gallery,
opt-in Pages and preview-release workflows, dependency update configuration,
repository administration helper, reproducible ZIP packaging, and startup measurements.
The follow-up changes preserve authored axis formats, keep tall-label mobile
Split layouts bounded, and repair the Linux Firefox graphics setup. All original
legacy data and asset notices remain intact.

## Verification Results

| Check | Observed result |
| --- | --- |
| Publication audit | 639 files, approximately 51 MiB; working-tree and staged checks cover paths, common credential patterns, entry-document links, and build inputs |
| Git whitespace and Python lint | Passed |
| JavaScript client suite | 231 passed on Windows and Linux |
| Windows Python 3.12 server suite | 948 passed, one symlink test skipped because the session lacks the required Windows privilege; run preceded two added regression cases |
| Focused Python follow-up | 75 passed, including scoped asynchronous query polling and preview packaging |
| Final verification/packaging tooling tests | 27 passed after the Linux graphics-runner adjustment |
| Linux Python 3.12 server suite | 951 passed, no skips |
| Local/Server provider integration | 42 passed on each platform |
| OpenAPI and six dataset normalization checks | Passed; all 2,349 bundled records retained |
| Reproducible standalone build | Two consecutive builds matched on each platform |
| Full Windows/Edge browser suite | 158 passed, two presentation failures before the final presentation fixes |
| Focused table/live/configuration/filter rerun | 29 passed after fixing hidden-overview rendering |
| Final presentation/source-path rerun | 12 passed on Windows/Edge and 12 on Linux/Chromium |
| Final Windows focused browser matrix | 84 passed: 28 each in Chromium, Firefox, and Edge |
| Final Linux focused browser matrix | 28 Chromium and 28 Firefox cases passed in separate runs; Firefox uses the corrected virtual display |
| Fresh local clone of the initial commit | Locked npm install, build/input audit, and all four standalone-demo checks passed; npm reported zero known vulnerabilities |

The complete 160-case browser suite was not repeated after the last narrow
presentation fixes. Focused and cross-browser reruns are separate evidence, not
a retroactively relabeled full-suite pass. Python 3.13 and remote GitHub Actions
runs were not executed here. The complete G0-G5/manual release gates remain open.

## Defects Found and Fixed

- Table refresh attempted to project the hidden overview at zero width. Guards
  now let live reloads, filter changes, and saved-view application finish without
  leaving stale table results. The CSV-export regression also verifies returning
  to a visible, updated overview.
- Density-aware tick selection discarded an authored date format. It now keeps
  the configured format while selecting readable tick spacing.
- Four-line 24px labels in narrow Split view could push the overview into the
  table. In this constrained case the toolbar scrolls independently; complete
  record ink, overview, table row, and footer remain separate. Tests exercise
  access to the scrolled controls and nonblank canvases.
- A source-scoping server test assumed immediate query completion. It now polls
  a valid `202 Preparing` response with the same scoped identity, including a
  forced-asynchronous case.
- A multi-step navigation scenario exceeded its former 30-second overall test
  allowance on Linux. Its functional assertions remain unchanged; the scenario
  now has 60 seconds and passed in 30.8 seconds on the observed Linux run. This
  does not relax a product performance budget.
- ZIP packaging now records unavailable Git metadata as unknown, not as a clean
  working tree, when building outside an installed Git environment.
- Linux headless Firefox could not create WebGL2 in the test container. A direct
  probe returned false headlessly and true with Xvfb after installing the graphics
  libraries. The image/CI now install Mesa/EGL and Xvfb, and the Linux Firefox
  matrix runs with a virtual display. No canvas assertions or test cases are skipped
  to accommodate missing graphics support.

The first Windows candidate browser run was stopped after repeatable table
failures. The later Linux candidate browser run was stopped after a navigation
timeout to exercise the corrected build. Both candidate manifests remain
**incomplete**; their passing server/integration stages remain independently useful.

## Receipts and Packaging

Local generated evidence is deliberately excluded from Git:

- `artifacts/verification/preview-commit-windows/`: initial candidate manifest,
  preserved failure traces, complete pre-presentation-fix browser report, and
  focused rerun reports.
- `artifacts/linux-preview-fixed/verification/linux312-fixed/`: 951-case server,
  integration, schema, dataset, and reproducible-build results; incomplete
  candidate status is retained.
- `artifacts/linux-preview-final/targeted-browser.json` and
  `artifacts/linux-preview-final/browser/matrix.json`: corrected Linux presentation
  reruns and 28 passing Chromium matrix cases; the initial Firefox environment
  failures and unrun cases remain visible in that matrix report.
- `artifacts/linux-preview-firefox/browser/matrix.json`: Firefox rerun with the
  corrected virtual-display environment.
- `artifacts/browser/matrix.json`: corrected Windows matrix.
- `artifacts/preview-source/`: fresh local Git clone used for standalone packaging.
- `artifacts/releases/v0.1.0-preview.1/`: ZIP, `SHA256SUMS`, and source-commit-linked
  `release-manifest.json`. This directory is not a published GitHub release.

The corrected-build browser reruns used working-copy bundle
`5413b68653ca41177d3176a0e65ff6d354b780d2ef927efaaed0ebbf0c025977`.
The earlier full Windows browser report names its own bundle,
`efaaed62db66ca2784358fdf5846da679f55aaea468713abaefd52c791b968f6`.
Fresh-checkout HTML can differ because existing Windows CRLF help/notices become
the repository's declared LF bytes. The downloadable package is built and
demo-tested from a clean checkout; its manifest identifies the actual commit and
HTML/archive hashes. It is not assembled from an ignored runtime export.

Desktop and mobile screenshots were inspected, including the corrected tall-row
Split view. The existing README gallery/PDFs keep their earlier capture provenance.
The [startup measurements](demo-performance.md) remain small-sample local
observations: about 1.1 seconds on desktop and 16.4-16.7 seconds under slow-4G/mobile
emulation. Hosted performance and production budgets have not been certified.

## Publication State Before Owner Approval

Private vulnerability reporting was enabled on GitHub and read back successfully.
Dependabot configuration and required-check policies are committed, with no
automatic dependency merging. The branch-protection request returned HTTP 404
because the public repository has no `main` branch yet; a later remote-head
check also found no branches.

No public push, tag, GitHub release, or Pages deployment was performed. Project
license selection and historical-data/image redistribution still require owner
confirmation. The README keeps the demo marked pending; publication approval
variables remain unset. Follow [publishing](publishing.md) and
[the data/asset review](data-licensing.md) before activating those workflows.

On September 14, 2026, the owner subsequently selected GPL-3.0 and approved the
prepared datasets/images for redistribution and GitHub publication. The
[approval record](data-licensing.md) supersedes the licensing gate above, not the
historical test results. GitHub Actions remains responsible for verifying the
pushed candidate before a preview release can be published.

## First GitHub Push and Hosted Demo

Commit `e5af7cbbe3f531766b4523e49849bd6e65de6100` was pushed to `main` on
September 14, 2026. GPL-3.0, the redistribution record, and the existing third-party
notices were included. Branch protection and private vulnerability reporting were
applied and read-back verified. Force-pushes and deletion are disabled; required
checks also apply to administrators.

[Standalone Demo run 34821760189](https://github.com/arcazj/open_timeline2.0/actions/runs/34821760189)
passed and deployed the [live application](https://arcazj.github.io/open_timeline2.0/).
Independent hosted-browser checks at 1600 x 900 and 390 x 844 verified nonblank
canvases, all six datasets/2,349 records, search findings in the overview, stable
vertical pagination, and continued navigation with networking disabled. Dataset
switches and offline navigation made no HTTP requests. Screenshots were inspected;
the local report is `artifacts/hosted-publication/verification.json`.
The downloaded HTML hash matched the clean-checkout build recorded in
[hosted startup measurements](demo-performance.md).

The first [Candidate Verification run](https://github.com/arcazj/open_timeline2.0/actions/runs/34821760244)
found that two server startup tests assumed an existing generated client file.
Linux Python 3.13 reported 955 passed and 2 failed, with no skips. The correction
gives these tests a temporary client fixture and separately checks the actionable
404 when a build is missing; real application browser tests remain unchanged.
The full matrix must pass on the corrected commit before publishing a prerelease.

The same initial run reported the two missing-build fixture failures on both
Windows versions. Linux Python 3.12 also exposed a filter test that read an
asynchronous query-preparation response as a completed result. That test now polls
the documented 202 response through the existing bounded helper and exercises
both default and forced-asynchronous preparation, retaining the pinned-revision
and search assertions. No production response timing was changed to satisfy it.

## Windows Path and Container Qualification

On commit `c3be71f9fe96d9e6af3ea3d0af6bbd5f4d44eb3c`, Windows Python 3.13
CI passed all 960 server cases without skips, then exposed a real legacy-reader
failure in provider integration: Windows temporary directories used 8.3 names
such as `RUNNER~1`, while the opened file handle reported the long name.
Model loading also expanded only the configured root, causing a false containment
failure when the model filename still used its short spelling.

The correction expands short names with `GetLongPathNameW` when the opened path
differs, preserves drive/UNC identity, and retains file-identity, modification,
allowlist, and reparse-point checks. Model loading keeps the configured root's
spelling until those checks run. Native Windows regression cases cover file reads
and model/namespace loading; expansion failures remain fail-closed.

Local checks after this correction passed 176 focused Python cases and all 42
provider integration cases with `TEMP` and `TMP` deliberately set to an actual
8.3 directory alias. The latter report is
`artifacts/hosted-publication/windows-short-parity.xml`, with no failures or skips.
These are focused working-copy results, not a replacement for the protected
Windows/Linux candidate matrix.

The new mandatory root license also required Docker context/stage updates.
Both verification and runtime images build successfully with `LICENSE` included.
The runtime was checked as UID 10001: the GPL text exists in `/app/LICENSE` and
the self-contained HTML, and the Python application imports successfully. These
local image checks do not publish an image or certify production deployment.
