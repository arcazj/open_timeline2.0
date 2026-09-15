# Regex Engine Qualification

Implemented core qualification, 2026-09-14. This is not a full release or a claim that every platform and application workflow has passed.

## Pinned Contract

`re2-common-v1` uses [RE2JS 2.8.6](https://github.com/le0pard/re2js) in JavaScript and [google-re2 1.1.20251105](https://pypi.org/project/google-re2/1.1.20251105/) in Python. Matching is performed by those engines, never by native JavaScript RegExp or Python re on a user pattern. Literal search retains the existing NFC/full-casefold semantics.

Expression version 2 adds a field-scoped `regex` node with `pattern`, `flags`, `matchMode`, and optional `dialect`. Query `definitionVersion: 2` adds `searchMode: "regex"`, `searchFlags`, `searchMatchMode`, and `searchDialect`. Regex flags are unique `i`, `m`, `s`; regex search omits the literal-only `searchCaseSensitive` property. Regex fields must be registered strings, not arrays or serialized objects. Version 1 rejects these new keys/operators.

`search` matches anywhere; `full` uses RE2Set's anchored-both operation in JavaScript and RE2's fullmatch operation in Python. Subject text is normalized to NFC; saved pattern bytes are unchanged. Empty patterns are invalid; explicitly empty-matching patterns such as `a*` are accepted and identified. Clearing search must select the inactive literal search state, not submit an empty regex.

## Shared Subset

The syntax gate allows ordinary literals, groups, noncapturing groups, alternation, anchors, character classes, repetition and supported RE2 escapes. It rejects lookaround, backreferences, octal escapes, named groups, inline flag modifiers and engine-specific escapes. The engines still perform parsing and compilation. Gate diagnostics use Unicode-codepoint offsets; engine-only parse failures have `offset: null` rather than a guessed location. Labels are highlighted as whole labels; no unverified normalization-to-source substring mapping is used.

RE2JS includes Unicode 17 simple folding; the selected Python binding differs for newly introduced mappings. The implementation therefore rejects case-insensitive patterns/selected subject fields containing the 110 endpoints of the 55 simple-fold mappings added between Unicode 15.1 and 17. Case-sensitive regex and literal search remain available. Unicode property escapes are unavailable in this initial common dialect. These restrictions are explicit `regex_unicode_version` or `unsupported_regex_syntax` errors, not missing findings.

The authoritative [Unicode 15.1](https://www.unicode.org/Public/15.1.0/ucd/CaseFolding.txt) and [Unicode 17](https://www.unicode.org/Public/17.0.0/ucd/CaseFolding.txt) source hashes and affected ranges are recorded in `shared/fixtures/regex-dialect.json`. A qualification probe confirmed the Python engine accepts all 1,457 Unicode 15.1 simple-fold pairs. This does not claim equality of the engines' complete Unicode databases.

## Resource Bounds

- 512 pattern codepoints; 8 regex AST nodes; 16 selected fields; existing 100 AST nodes/depth 8.
- Shared precompile expansion ceiling of 1,024 structural units, including repeated group/class footprints. Both providers reject over-budget expressions before engine compilation.
- Engine memory option 1 MiB per compiled expression; defensive 32,768-instruction ceiling. JavaScript compilation cache holds 16 entries. Python's application cache holds 16 entries; the binding also has its own bounded 128-entry cache, so its theoretical engine cache ceiling is larger. These options are not a process RSS guarantee.
- Selected field ceiling 1 MiB UTF-8; aggregate 64 MiB and 64 million structural-work units per supplied shared query budget. Exceeding a budget fails the query, never silently truncates findings.
- Cancellation callbacks are checked before each field evaluation. The Local provider cooperatively yields during query preparation so worker cancellation messages can be delivered. The engine qualification separately verifies that an isolated worker can be terminated promptly; this does not certify every layout/import operation as cooperatively sliced.

## Executed Checks

Commands:

```text
node --test tests/client/filter-expression.test.mjs tests/client/scoped-filter-fields.test.mjs tests/client/regex-v2.test.mjs
.venv/Scripts/python.exe -m pytest tests/server/test_filters.py tests/server/test_regex_v2.py -q
node scripts/qualify-regex.mjs
```

The 60-case shared fixture covers exact membership, Unicode/NFC, sharp-s/dotted-I, astral characters, full/search anchors, newline flags, empty matches, malformed syntax, codepoint diagnostic offsets and shared expansion limits. Additional unit checks cover version gating, typed/missing/null behavior, bounded explanations, shared budgets, cancellation callbacks and injected engine failures.

Windows run: Node 24.13.0, Python 3.12, Chromium 153.0.8010.12 and Firefox 155.0. Both browsers executed all 60 cases from a minified, inline Blob worker in an offline `file://` page with zero HTTP/WebSocket requests. The isolated qualification worker was 157,828 bytes. Engine corpus execution took 11.4 ms in Chromium and 15 ms in Firefox on this run; worker-start-and-termination took 9.4 ms and 30 ms respectively. These are single-run diagnostic timings, not p95 performance evidence.

The offline check found and fixed an error-classification defect caused by minification renaming exception constructors; classification now uses the imported exception class. Fixture SHA-256: `a04bbfd1b4f9b9e4209a97876eb921b4f6d38e5a5424376ac356b9c7d5453223`.

`scripts/qualify-regex.mjs` writes reproducible current results under `artifacts/regex-qualification/`. The full application, platform matrix, memory measurements, screen-reader tasks and user study are separate release gates. No passing result is inferred for checks not run here.

## Notices

RE2JS carries MIT terms and is automatically included by the existing standalone notice collector. The Python binding retains its BSD-style third-party license; the project remains GPL-3.0-only. Unicode-derived ranges retain the existing Unicode license notice. No additional runtime download, CDN, WASM loader or network policy exception is required.
