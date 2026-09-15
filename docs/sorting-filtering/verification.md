# Documentation Verification

2026-09-14 | Windows local verification | Application baseline `2c3b0c17e3167577c00951ee456588c8ed9cd521`.

## Scope

This change adds a reverse-engineering report, a versioned implementation prompt, an acceptance plan, reproducible legacy method probes and three documentation-only UI proposals. It corrects one stale capability statement and adds the new PDF to the publication allowlist. No renderer, API, production query behavior, data source or dependency has been changed.

The PDF is generated from the same Markdown prompt. The separate analysis and acceptance plan remain linked documents; their future gates have not been executed as new application features. The original rebuild prompt/PDF is unchanged.

## Executed Checks

| Check | Result |
| --- | --- |
| Extracted legacy Java methods | 14 cases passed, JDK 17.0.19; recorded source/method hashes. |
| Extracted legacy JavaScript methods | Six checks passed, Node 24.13.0; not a full legacy UI run. |
| Focused existing client tests | 30 passed; filter semantics, scoped fields, presentation, legacy model adaptation and read-only policy. |
| Focused existing Python tests | 161 passed, Python 3.12.14; filters, presentation and legacy source validation. Two existing dependency deprecation warnings. |
| Existing real-HTTP/local parity tests | 23 passed; configuration, filtering, presentation and legacy providers. |
| Proposed UI capture | Three Playwright captures, desktop 1360 x 860 and mobile 390 x 844; no page overflow, clipped controls or hidden preview counts; visually reviewed. |
| PDF | Generated from Markdown, all 20 headings and four images verified; final pages rendered with Poppler and visually inspected. |
| Publication checks | Document links, source/image hashes, R1-R11 presence, repository hygiene and diff whitespace checks. |

The 30 + 161 + 23 existing application tests are regression checks of the baseline, **not tests proving the proposed regex, new migration or saved-view UX exists**. The known post-merge Windows async-preparation failure remains a Phase 1 task described in the analysis. No complete browser/platform release matrix or user study was run for this documentation change.

## Reproduce

Install project dependencies using the existing lockfiles. The audit additionally requires a JDK and the separately available legacy source tree/JAR. No legacy server process is required.

```powershell
node scripts/audit-sorting-filtering.mjs C:/projects/openbexi_timeline "C:/Program Files/Eclipse Adoptium/jdk-17.0.19.10-hotspot"
node scripts/capture-sorting-filtering-proposals.mjs
node scripts/check-sorting-filtering-docs.mjs
node --test tests/client/filter-expression.test.mjs tests/client/scoped-filter-fields.test.mjs tests/client/presentation.test.mjs tests/client/legacy-presentation.test.mjs tests/client/legacy-read-only.test.mjs
.venv/Scripts/python.exe -m pytest tests/server/test_filters.py tests/server/test_presentation.py tests/server/test_legacy_sources.py -q
node --test tests/integration/filter-parity.test.mjs tests/integration/configuration-parity.test.mjs tests/integration/presentation-parity.test.mjs tests/integration/legacy-parity.test.mjs
npm run check:repo
git diff --check
```

For PDF authoring, use a separate Python 3.12+ environment with ReportLab and pypdf; these are documentation tools, not new application runtime dependencies. The current workstation uses `tmp/pdf-tools/Scripts/python.exe`:

```powershell
tmp/pdf-tools/Scripts/python.exe scripts/build-sorting-filtering-pdf.py
pdftoppm -r 90 -png output/pdf/OpenBEXI_Timeline_Sorting_Filtering_Prompt.pdf tmp/pdfs/sorting-filtering/page
```

The builder writes a source/PDF/image hash manifest under ignored `tmp/pdfs/sorting-filtering/build.json`. Re-render and inspect every final PDF page after text or figure changes; heading presence alone cannot detect clipping. The proposal capture manifest [ui-proposals.json](ui-proposals.json) expressly disclaims implementation verification. The historical screenshot has different provenance, explained in the prompt and report.

## Publication Boundaries

Do not publish generated Java harness classes, raw CI logs, credentials, local configurations or production records. Do not edit legacy fixture expectations just to make a changed source pass. Future source changes must trigger a new review. Retain GPL-3.0-only project licensing, original legacy notices and existing third-party attribution.
