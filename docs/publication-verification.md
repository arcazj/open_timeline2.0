# Publication Preparation Verification

Checked on 13 September 2026, Windows, before the first commit. This is repository/package verification, not full release certification or a report of a successful public deployment.

This is the earlier preparation record. See [preview commit verification](preview-commit-verification.md) for the subsequent local commit, broader testing, regression fixes, packaging, and repository settings.

## Completed Checks

| Check | Result |
| --- | --- |
| Repository guard | Publication paths, common credential patterns, entry-document links, and first-party build-input inclusion passed against the working tree and staged index |
| Git whitespace check | Passed; exact original fixture bytes are intentionally exempt |
| Python lint | Ruff passed for `server`, `tests/server`, and `scripts` |
| Client suite | 231 passed using `--test-concurrency=1` |
| Focused Python suites | 59 passed: candidate verification, startup, configuration catalog, and local datasets |
| Provider integration suite | 42 passed over Local and real Python HTTP providers |
| Help/sharing browser regression | 9 passed in Edge, including offline README rendering and sanitized documentation |
| Demo browser suite | 4 passed in Edge: package identity, HTTPS project path/all datasets/offline interaction, mobile layout, and direct-file startup |
| Canonical dataset regeneration | `--check` passed for all six datasets; 2,349 records retained |
| OpenAPI | `--check` matched registered handlers and schemas |
| Fresh staged-file checkout | `npm ci --ignore-scripts`, demo build, dataset normalization check, 231 client tests, and all 4 demo tests passed without borrowing ignored application inputs |
| Dependency installation audit | npm reported zero known vulnerabilities for the locked JavaScript install; not a complete security audit |

The fresh checkout was generated with `git checkout-index` into ignored temporary space. It had no runtime state, source exports, installed dependencies, or generated standalone file before installation/build. Original fixture hashes survived checkout unchanged. This verifies the selected file set, not a GitHub-hosted clone or a remote Actions run.

## Build and Visual Evidence

- Working-copy demo HTML SHA-256: `ba1ceb057f42f563caa327af6c1627fa6c7dbd89572afbc6f24f7a7a03791a8f`.
- Fresh staged-checkout demo HTML SHA-256: `84fb6be888046cd3f4dbd44ac6f248c2e41538509be25a525e4c9119a72aab0e`.
- The hashes differ because checkout normalizes legacy CRLF text, including embedded notices/help, to the declared LF policy. Both packages were independently built and browser-tested. Original fixture bytes are never normalized by Git.
- Desktop 1600 x 900 and mobile 390 x 844 screenshots were inspected. Both timelines rendered nonblank canvas pixels; mobile had no horizontal document overflow.
- Local browser reports/screenshots are under ignored `artifacts/browser/`. Existing README gallery images and PDFs keep their earlier capture provenance; they are not silently relabeled as this new build.

## Not Completed Here

No commit, push, GitHub Actions execution, GitHub Pages activation, or public demo deployment was performed. The repository is prepared and staged for owner review. The README explicitly marks the intended demo address as pending.

The full Python suite and full cross-browser/platform matrix were not rerun for this publication-only change. Earlier broader evidence and its Windows symlink skip remain in [local dataset verification](local-test-data-verification.md). Existing Starlette/httpx and AnyIO deprecation warnings remain in the focused runs.

Project-license selection, historical-data/image attribution, and the existing GPL-noticed legacy assets still require the owner's publication review. Follow [publishing](publishing.md) before pushing or enabling the demo. Passing these checks does not close the independent [release checklist](release-checklist.md).
