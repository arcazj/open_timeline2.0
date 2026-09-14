# Standalone Mode

Open only dist/index.html in a supported desktop browser. The file includes the client, Three.js, approved font variants, CSS, complete initial sample data and the Local worker program. No server, internet, CDN, sibling JSON file, runtime module download or browser database is required.

Use Open JSON in the source dialog to select a complete snapshot. Import validates before activation; an invalid file must leave the current source usable. A query page is not a complete source. Every admitted record remains reachable through time navigation, filters and vertical row pages even though only visible projections are rendered.

Local editing changes memory. Export the complete JSON source to preserve changes, then reimport to verify the saved copy. A download request cannot prove that the browser wrote a file, and closing/reloading may lose unexported changes. Nothing overwrites the original HTML/JSON automatically. Browser storage does not become an alternative database.

## Local Execution

The browser factory uses one classic Blob Web Worker per active or explicitly retained Local branch. Its JavaScript is already embedded in the HTML, with no fetch, importScripts, module URL or network bootstrap. Strict JSON parsing, validation, filtering, complete-range density, global row packing, model commands and record commands run through the existing LocalProvider inside that worker. Only requested results cross the message boundary. Import passes the raw JSON string to the worker; a partial page or duplicate-key file is still rejected before source activation.

When Worker/Blob support is unavailable or worker startup is blocked, the same LocalProvider runs directly. The startup handshake has a two-second bound; expensive snapshot initialization has its own longer request bound. Status reports execution.mode as worker or direct and a direct fallback reason. Direct mode preserves functionality but can block the browser while large operations run. Worker mode does not eliminate every main-thread cost: file reading, message cloning, rendering and downloaded JSON serialization still occur there.

Fallback is allowed only before an initialized worker source is accepted. A later worker crash does not silently reopen the original bundle or discard edits in favor of a fresh direct provider. After a dispatched write is canceled, times out or loses its worker, the command outcome is unknown, not failed. Keep the original Local branch alive and check its original command identity; no automatic retry, second command or upload occurs. If the worker is terminated or the page closes, its unsaved memory and outcome registry are lost. Disposing a provider is intentional branch destruction, not safe write cancellation.

Read cancellation rejects promptly and discards late responses; any late allocated query/layout is released. Pending transport work is bounded to 64 requests. The wrapper captures commands and caller signal options before awaiting initialization, and forwards the same immutable query, pagination and model metadata contracts as direct LocalProvider. Node tests continue to use the direct provider.

Server mode is a separate authenticated source. The source panel distinguishes source origin, timestamp, completeness and record count. A genuine outage can use a complete local source; authentication failure does not authorize showing restricted cached server content. Reconnect does not merge or upload Local changes. Lost server write responses remain uncertain until reconciled with the original server command identity.

The file build is tested through desktop Edge/Chromium and narrow viewport emulation. Focused worker tests exercise copied file URLs with HTTP blocked, complete JSON/model/record operations, rejected strict imports, startup-denied direct fallback, cancellation and uncertain outcomes. A single-run 25,000-record responsiveness observation is not a p95 performance gate. Other mandatory browsers and full release gates must not be inferred from these checks. Consult the implementation report and recorded test artifacts for actual evidence.
