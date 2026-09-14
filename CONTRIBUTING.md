# Contributing

OpenBEXI Timeline 2.0 is a development preview. Discuss large changes in an issue before changing storage, provider contracts, migration behavior, or interaction semantics. The project license is undecided; do not assume that dependency licenses license this repository's code or data.

## Development

Use Node.js 22+ and Python 3.12/3.13. From the repository root:

```sh
npm ci
uv sync --locked
npm run dev
```

For Python-backed browsing, follow the [README](README.md). The included `yaml/test-data/` profiles need no external legacy installation. Place private profiles in ignored `yaml/local/` or `config/local/` directories. Configure your IDE interpreter for this checkout's virtual environment; the shared `.run` configuration is a Windows example.

## Change Checklist

- Keep client rendering independent of server availability. Do not duplicate the application for offline use.
- Keep linked legacy files read-only. Do not add SQL/database storage or execute legacy converter classes.
- Update shared schemas and provider parity tests together when changing contracts.
- Test labels, zones, overview, selection, and pagination when changing timeline geometry. Include desktop/mobile screenshots for visual changes.
- Preserve original fixture bytes under `data/original/`. Change the catalog or converter, run `scripts/normalize-test-data.py`, and review the generated reports.
- Avoid real source exports, private paths, credentials, or customer data in tests, screenshots, issues, and commits.
- Keep changes focused and describe the behavior, tests, and remaining limitations in the pull request.

Run the [test commands](README.md#testing) relevant to your change. For a candidate-wide verification, use `uv run python scripts/verify-candidate.py --matrix --output artifacts/verification/my-candidate` with a new output directory. Skipped cases and unresolved release gates are not passes.

Before committing, run `npm run check:repo`. After staging, run `npm run check:repo -- --staged --build` against a fresh build. This checks the actual staged files and their publication dependencies; it is not a substitute for manual secret and license review.

## Reports

For a bug, include the build/version, browser/OS, operating mode, minimal sanitized JSON example, expected behavior, actual behavior, and reproduction steps. Use **Help and sharing** for sanitized diagnostics. Report security issues privately as described in [SECURITY.md](SECURITY.md).
