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

The updated Linux Docker image subsequently passed all 967 server cases without
skips (`artifacts/hosted-publication/linux-server-gpl.xml`). A separate full native
Windows/Edge run with 8.3 temporary paths reported 159 browser passes and one test
race. Its trace showed the imported touch target being replaced between lookup
and bounding-box measurement. The touch test now reacquires a non-null box with
a bounded assertion, without changing the application or its gesture assertions.
All ten repeated touch cases then passed with zero retries and the same short-path
environment (`artifacts/hosted-publication/touch-regression.log`). The original
full-run failure remains in `artifacts/browser/results.json`; the focused rerun
uses a separate output directory and is not presented as a full-suite pass.

## Toolbar Click Stability

The protected run for `4b4bfc8a80065f4550ec4fad83a107d43efd3247` passed the
complete Linux/Python 3.13 job. Linux/Python 3.12 passed all server, provider and
160 full-browser cases, then failed one of 56 matrix cases: opening Help in a
Firefox mobile dataset test. Its trace is preserved in
`artifacts/github-pr5/4b4bfc8-linux312.zip`.

Investigation found that repeated Lucide initialization replaced already-rendered
SVG nodes during layout refresh. A deterministic Firefox regression reproduced
both removal of the pressed icon and loss of the Help click. The correction
removes the initialization marker from rendered SVGs, preserving existing nodes
while still initializing new toolbar, descriptor, and dialog icons. No failed
click is hidden by retrying the command or extending its timeout.

The new press-during-layout test passed three repetitions each in Chromium,
Firefox and Edge. Ten repeated Firefox mobile dataset cases, all 11 Help/boot
cases and all 231 client unit cases also passed. Fresh mobile Help and desktop
timeline screenshots were inspected. Focused evidence is under
`artifacts/hosted-publication/toolbar-after`, `firefox-mobile-after`, and
`help-after`; each has a separate log. The new toolbar case is included in both
the full suite and cross-browser matrix for subsequent candidate verification.

The updated Linux Docker Chromium/Firefox matrix then passed all 58 cases without
skips or retries (`artifacts/hosted-publication/linux-toolbar-matrix.json`), with
captures preserved under `linux-toolbar-captures` in the same directory.

The preceding Windows/Python 3.12 CI job passed 159 browser cases but its remaining
case never reached the UI: the fixture stopped polling just as cold JSON storage
recovery finished at 12.05 seconds. The fixture now uses a monotonic 30-second
readiness deadline and still requires a successful health response; individual
UI test timeouts and application behavior are unchanged. All seven native Windows
table cases passed afterward (`artifacts/hosted-publication/table-readiness-after.log`).
This is test-server provisioning tolerance, not a passed production startup budget.

## Hosted Windows Graphics

Candidate `383bd56bf5e418501e1b2e36c5094c510d77bad5` passed both complete Linux
jobs. Both Windows jobs passed 231 client, 969 server, 42 provider parity, and
161 full-browser cases, plus Chromium and Edge matrix cases. Their 29 Firefox
matrix cases all failed before timeline readiness: each preserved trace reports
`AllowWebgl2:false restricts context creation on this system`. This is not a green
qualification run; its reports remain in `artifacts/github-pr5/383bd56-*.zip`.

The isolated Windows CI Firefox profile now enables its software WebGL2 path,
as described in [Mozilla issue 1970486](https://bugzilla.mozilla.org/show_bug.cgi?id=1970486).
Installed user profiles and application code are unchanged. All matrix cases,
canvas checks, zero retries, and existing timeouts remain required. A new complete
candidate run is required before the protected merge.

The next run (`3ab403a`) rendered successfully in Windows Firefox: 27 of its 29
matrix cases passed, while both complete Linux jobs and all other Windows checks
passed. The remaining two cases were Ephemeris and Space Exploration. Their
preserved screenshots show the expected bars and overview, but the GPU-less
renderer supplied exactly four canvas colors, failing the test's arbitrary
greater-than-four palette threshold. Both Windows runners reproduced this result.

The fixture check now requires nonuniform pixels along canvas columns, detecting
record detail independently of antialiasing shades. A canvas containing only
vertical grids and zones does not satisfy this check. Four unit tests cover blank
canvases, many-color vertical grids, a solid bar without antialiasing, and missing
WebGL2. Existing complete-data, all-band, offline, descriptor and screenshot
checks remain. Application rendering code is unchanged. Reports from the failed
candidate are retained in `artifacts/github-pr5/3ab403a-*.zip`.

## Explicit Refresh During Layout

On `ef761ec`, both Linux jobs and all dataset pixel regressions passed. Initial
Windows Firefox configuration cases sometimes stopped at bootstrap discovery;
one unchanged-source rerun was requested and the first-attempt evidence retained.
That rerun found a separate Windows/Edge interaction failure in the revoked-access
case: no 401 request had actually been sent. Opening the descriptor had started a
layout update, and the change monitor silently discarded the user's Refresh while
the layout was busy. The old module reproduces this with zero reloads after it is
unblocked.

Explicit refresh requests now coalesce into one deferred read in Pinned or Live
mode. Source changes, authorization/generation boundaries, outages and disposal
cancel queued requests; automatic failures do not start retry loops. Three unit
regressions cover queuing, cancellation and concurrent requests. The browser case
now deliberately holds the descriptor's layout response, clicks Refresh, then
releases the response and requires the subsequent 401 to clear protected visuals.
All ten change-monitor unit cases and three browser repetitions passed locally.
The complete client suite passed 238 cases; all 17 verification-tool tests and all
11 server/change-monitor browser cases passed. Three additional Firefox
repetitions of the held-layout/401 case also passed. The final integration report
is `artifacts/hosted-publication/queued-refresh-final.json`.

Candidate verification now runs the focused engine matrix before the longer full
browser suite, after the same backend, parity and reproducible-build checks. No
required case is removed. The intermittent Windows Firefox bootstrap observation
remains explicitly recorded; this is preview qualification, not a claim of
production startup performance or flawless first-pass CI.
