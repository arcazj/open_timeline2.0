# Help and sharing: UI and verification

These are screenshots of the running application, not mockups. The Help icon is immediately after Settings. Usage and privacy details are in [Help and sharing](help-and-sharing.md).

## Desktop

![Help menu at 1600 by 900](ui/help/desktop.png)

## Mobile

![Help menu at 390 by 844](ui/help/mobile.png)

## Share

![View sharing, image export, and reviewed import](ui/help/share.png)

## Exported PNG

![Actual exported timeline with main band, overview, zones, and labels](ui/help/timeline-export.png)

## Verification

Focused verification on 2026-09-13:

- 205 client unit tests passed with `node --test --test-concurrency=1 tests/client/*.test.mjs`. The default parallel run was intermittent in the existing 15-millisecond Live-refresh test; it passed earlier in parallel and in the final serial run. That unrelated timer-based test was not changed.
- 39 real Python/JavaScript integration tests passed.
- 30 server OpenAPI and legacy API tests passed; Ruff passed on the modified Python files.
- 22 browser tests passed with no skips or retries: Help, boot protection, and standalone regression suites.
- Browser checks include desktop/mobile layout, nonblank canvas/image pixels, offline Swagger with blocked internet access, read-only Live API and health, sanitized Markdown, clipboard denial and supported clipboard/native-share mocks, reviewed view restoration, missing sources, malformed links, and late-response guards.
- Desktop, mobile, and exported PNG screenshots were visually inspected. Native OS sharing and clipboard permission dialogs were not automated; supported success paths use browser API stubs.

The browser run and `dist/build-manifest.json` agree on standalone HTML SHA-256:

`aeb38fee31d454c16b4c4c8d00b390ad71e8b9611daa421c8a7fec8e8d486211`

This is focused feature verification, not full-release certification. The raw browser report is `artifacts/browser/results.json`; later Playwright runs replace it. The standalone build contains eleven Markdown documents, runtime dependency notices, and Swagger UI 5.32.15 with an embedded contract. Swagger displays its known warning for the contract's explicit JSON Schema 2020-12 dialect; the contract is not altered to suppress it.
