# Data and Asset Publication Review

This is a provenance inventory, not a legal opinion or a grant of redistribution
rights. No project license has been selected. Owner confirmation is required
before publishing the historical library or choosing the new project's license.

| Material | Evidence retained | Publication review |
| --- | --- | --- |
| Project code and authored documentation | Repository source/history | Owner must select a license; not inferred from dependency notices |
| Default operations dataset | Complete synthetic operations sample; original and conversion hash | Owner confirmation pending |
| Ephemeris | 127 supplied records referencing Intelsat public ephemeris pages | A public URL is not a dataset license; permission/terms review pending |
| JFK | Supplied historical event markup with source links | Dataset and linked-material rights unverified |
| Monet | Supplied historical markup referencing encyclopedia and biography material | Text/artwork rights unverified |
| Religions | Supplied historical markup with encyclopedia links | Text and aggregation rights unverified |
| Space exploration | Supplied JSON with NASA, encyclopedia, news, and other references | Mixed provenance; do not treat the entire file as government public-domain material |
| Three supplied comparison PNGs | Original `data/*.png` retained | Ownership/redistribution confirmation pending |
| Legacy hazard icons | Eight unchanged PNGs and supplied GPL-3.0-or-later notice | Notice preserved; per-image provenance review remains open |
| Noto Sans | Embedded OFL-1.1 notice | Attribution retained |
| Unicode case-folding data | Unicode-3.0 notice and source header | Attribution retained |
| JavaScript dependencies | Lockfile inventory and complete bundled notices | Notice closure checked; not an overall license-compatibility opinion |
| Archived specifications and screenshots | Original/reference PDFs and capture metadata | Owner publication review required; inspect for private data as well |

`data/reports/` records source hashes, record counts, uncertainties, and missing
assets. Conversion preserves unknown fields and source text; it does not confer
new permissions. The full standalone HTML embeds the six datasets and three
supplied PNGs, even when only the default sample is currently visible.

Public Pages deployment requires `PUBLIC_DEMO_APPROVED=true`; public preview
releases require `PUBLIC_RELEASE_APPROVED=true`. Leave both unset until the owner
has completed the review. Their approval is operational authorization, not a
replacement for the underlying licenses or required notices.

The existing legacy asset notice must not be replaced with MIT, Apache, or another
project license. Record the selected project license and any distinct dataset
licenses separately, preserving attribution and reviewing compatibility as needed.
