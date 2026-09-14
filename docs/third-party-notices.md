# Third-Party Notices

Project code and authored documentation use [GNU GPL version 3](../LICENSE)
(`GPL-3.0-only`). The same full license is embedded in the standalone notices and
available from Help > Licenses. Source and build instructions are available in the
[source repository](https://github.com/arcazj/open_timeline2.0); use the matching
release tag or the commit recorded in `release-manifest.json` for a downloaded ZIP.

The standalone build includes full license/notice text for all locked JavaScript
runtime packages, their transitive dependencies, the embedded Noto Sans fonts and
the Unicode case-folding data. These notices are embedded as inert JSON in
`dist/index.html` under `third-party-notices`; they remain present when that file is
copied alone and used offline. The build also emits a readable
`dist/THIRD-PARTY-NOTICES.json` for distribution review. No runtime fetch is needed.

The build fails when a runtime dependency has no bundled license, the installed
package version differs from the lockfile, or a bundled package is absent from the
notice inventory. `dist/build-manifest.json` hashes the notice text and its inputs.
This is attribution inventory and dependency closure, not a legal compatibility
opinion or a malware/security certification.

Font attribution is retained verbatim in `client/assets/FONT-LICENSE.txt`.
The unmodified legacy hazard icons retain their supplied GPL-3.0-or-later
notice in `client/assets/legacy-hazards/LEGACY-LICENSE.txt`, also embedded in
the standalone build. The project license does not replace their existing notices.
`docs/licenses/UNICODE-LICENSE.txt` records the
[Unicode License V3](https://www.unicode.org/license.txt), retrieved September 13,
2026 UTC, for the vendored 15.1 case-folding data and derived lookup tables.
The original data header and source version remain unchanged.

The npm package is marked private to prevent accidental registry publication; this
does not mean the GitHub repository is private. These third-party permissions do not
relicense the user's historical source and documents. See the owner's
[dataset/image redistribution approval](data-licensing.md). A future bundled
Python runtime needs its own packaging notice inventory; the standalone preview
does not distribute a Python interpreter or installed Python packages.
