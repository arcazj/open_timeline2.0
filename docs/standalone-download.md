# OpenBEXI Timeline: Offline Preview

Extract the ZIP and open `index.html` in a current browser with WebGL2 enabled.
No installation, Python, Node.js, CDN, or local web server is required.

The application starts with a complete 48-record operations sample. Open the Help
icon, choose **Test local data**, and select any of the six complete datasets.
The complete library contains 2,349 records; row pagination does not discard data.

Drag the timeline, navigate using its overview, use the calendar, search records,
or switch between Timeline, Table, and Split. Import another JSON file through
Source and connection or drag and drop. Source and snapshot labels distinguish
imported/embedded records from current server data.

Changes to editable Local snapshots are in memory. Export complete JSON before
closing or reloading. Read-only historical snapshots and linked legacy archives
are not writable. Local changes never upload or synchronize automatically.

This is a development preview, not a production-qualified server release. Read
`RELEASE-NOTES.md`, `DATA-NOTICES.md`, and `THIRD-PARTY-NOTICES.json`. Dependency
notices do not assign a project license or clear third-party historical records.

Source and documentation: https://github.com/arcazj/open_timeline2.0

Verify the downloaded archive against the separately supplied `SHA256SUMS`:

```powershell
Get-FileHash .\openbexi-timeline-v0.1.0-preview.1-standalone.zip -Algorithm SHA256
```

On Linux, run `sha256sum -c SHA256SUMS` in the directory containing the release
ZIP, release manifest, and checksum file. Checksums detect a mismatched download;
they are not a code-signing or security certificate.
