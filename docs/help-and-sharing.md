# Help and sharing

Open the question-mark Help icon immediately after Settings in the menu bar.

## Help

README, release history, source/YAML guidance, scaling, standalone instructions, testing, and license notices are bundled into the generated HTML. They work without a server or internet connection. GitHub and documentation links not included in the bundle open externally and require network access.

**Swagger (offline)** displays the build's OpenAPI contract in a sandboxed, read-only viewer. It cannot execute API requests or contact an online validator. The current Swagger version warns about the contract's explicit JSON Schema 2020-12 dialect; the authoritative contract is retained unchanged. **Swagger MD** opens the Markdown API guide. **Live API** reads the active server's authenticated OpenAPI endpoint; it is unavailable in standalone mode. Explicitly private routes such as local source-path discovery are excluded from that contract. Neither action changes records. Download OpenAPI exports the bundled contract as JSON.

Licenses includes the bundled dependencies' license and notice texts. These notices do not assign a license to the project's own code.

## Test Local Data

The dataset selector opens a complete embedded fixture, not a downloaded server page. Choose Default dataset, Ephemeris, JFK, Monet, Religions, or Space exploration. Opening a fixture resets its range, filters and model to the catalog preset; unsaved changes require confirmation. Reset reference view restores only presentation settings. Original records, date-review findings, missing image notices, and supplied reference PNGs are available in the panel. See [local test data](local-test-data.md) for normalization rules and verified rendering captures.

## Share

Copy link captures the visible time range, overview range, filters, search, display settings, view mode, and selected record ID. It does not export records, credentials, server connection settings, or filesystem paths. Search and filter values remain readable in the link: review them before sharing. The image preview includes whatever is visible, including the selected record's descriptor.

HTTP links contain the application's URL with a view fragment; credentials and query parameters are removed. For a local `file:` application, only the fragment is shared, never the local file path. Recipients must open the appropriate application/snapshot, paste the fragment in **Open a shared view**, review it, and apply it. Incoming view fragments open for review, not automatic application.

Applying a view uses the current data provider, checks filters against it, and never connects to a source or writes records. Missing source IDs are rejected. Records outside the active dataset cannot be restored; a selected record unavailable in the resulting view is not selected. A different snapshot generation is explicitly flagged. Pagination and layout are recalculated for the recipient's screen size.

**Preview image** captures the current application, including the main timeline, overview, labels, and open descriptor, as PNG. Download or copy the preview after checking its content. Native sharing and image clipboard depend on browser support and permissions; disabled actions and errors reflect these limitations. Text copying provides a selectable fallback when clipboard access is denied.

## Diagnostics

Copy/download diagnostics contains version, provider mode, counts, view/layout metrics, and browser capabilities. It omits credentials, paths, record contents, and search/filter values. Review the report before attaching it to an issue. Check server health performs a bounded read-only request against the active server; it is unavailable offline.

All content is generated from the same modular client build. Rebuild with `npm run build` after documentation or code changes.
