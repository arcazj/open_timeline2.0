# Timeline Design Gallery

Revision 2.4 documentation assets for OpenBEXI Timeline 2.0. All eight images are proposed static design mockups. They are not screenshots of an implemented application, a running provider, or completed import/synchronization tests. No application code, dependency installation or development server was produced to capture them.

## Current Targets

| ID | Asset | Proposed State |
| --- | --- | --- |
| V09 | [Uniform timeline](ui-timeline-uniform.png) | Server source, Uniform scale, rows 1-15 of 40; 23 loaded records and 48 in the overview. |
| V10 | [Adaptive page one](ui-timeline-adaptive-page-1.png) | Same time interval and data, with a fourfold local magnification from 12:00-13:00. |
| V11 | [Adaptive page two](ui-timeline-adaptive-page-2.png) | Rows 16-30, containing 15 records; horizontal geometry, zones and the full overview are unchanged. |
| V12 | [Search findings](ui-timeline-search.png) | Contextual search for Telemetry: two highlighted loaded records, five global findings, and exactly those five records in the overview. |
| V13 | [Narrow timeline](ui-timeline-mobile.png) | 390 x 844 CSS pixels; focused 12:00-13:00 window, 12 loaded records, 40 in range and 48 in the overview. |
| V14 | [Local snapshot status](ui-standalone-source.png) | A complete 48-record local JSON source is active in memory, with source scope, origin, import summary, Open JSON and Export JSON controls. The server is unavailable, not required to display the source. |
| V15 | [Reconnect comparison](ui-reconnect.png) | Local remains active after a server becomes available. Two local records are modified and not exported. Different local/server scopes make membership comparison unavailable; no automatic upload or source switch is implied. |
| V16 | [Scale settings](ui-scale-settings.png) | Compact scale panel with Uniform/Automatic modes, all eleven units from Millisecond through Millennium, ratio/bin settings, time zone and overview scale. |

## Fixture and Geometry

[design-fixture.json](design-fixture.json) contains 48 generic operational records for 12 September 2026 UTC, two independent annotation zones and authored presentation metadata. It is specification data, not the application's runtime store. Production must display the user's actual authorized source or an honest empty state, not silently fall back to this fixture.

The overview domain is 00:00-24:00. Desktop detail shows 08:00-17:00; mobile explicitly focuses 12:00-13:00. The accepted illustrative map has relative slopes 1, 4 and 1, with changes at 12:00 and 13:00. It preserves the published mapping oracle and centers 12:30 in both desktop Uniform and Adaptive examples. This map is hand specified, not claimed output of an automatic density solver.

Forty logical rows are authored solely to illustrate reusable tracks and vertical page boundaries. Desktop capacity is 15 rows after reserving scale, zone-label and axis space; mobile capacity is 12. Page one contains 23 canonical records because some tracks contain more than one record. Page two contains 15. The provider and allocator contracts, not these authored positions, define the eventual global layout implementation.

Maintenance covers 12:10-12:45; Verification window covers 12:30-13:20. Each band projects its own zone endpoints, with translucent fills behind records and reserved label space. A selected overview interval is navigation chrome, not a record or a search finding.

## Provider Display States

The three panels preserve the visible main timeline and the entire overview. Their opaque popovers intentionally cover part of the detail canvas; this is a declared tool-overlay state, not missing records or a second layout. Closing a panel must restore unobstructed access in implementation.

The Local target's Ready/import summary is an authored state. No JSON import or validation engine was run. Browser memory is explicitly distinguished from durable JSON export, and Server unavailable is not shown as Connected. Authentication failures must not later be relabeled connection outages.

The reconnect comparison uses illustrative origin revisions 104 and 108, 48 local records and 51 currently authorized server records. These totals do not establish three additions or any deletions because the scopes differ. Two local modifications are display metadata, not executed mutations of the fixture file. Export local JSON, Switch source and Stay local are separate intended commands; switching must follow the provider contract's explicit draft/export/discard decision. No implicit merge, background upload or automatic source replacement is represented.

The scale panel displays the complete unit menu. Its current fourfold ratio and 128 bins are proposed configuration values; the image does not prove unit handling, calendar semantics, numeric validation or density computation. Those remain executable requirements in the main specification and companion contracts.

## Capture Verification

The temporary document-authoring helper is outside the application workspace, under the task's temporary `ui-v24` directory. It uses static HTML/CSS, the existing Lucide icon package and the existing Playwright/Edge installation. Captures use device scale 2: seven desktop images are 1600 x 900 CSS pixels, and one mobile image is 390 x 844. No application service is started.

[capture-verification.json](capture-verification.json) records the checks from the final capture pass. All eight passed:

- Expected detail and overview IDs, page separation, exact search membership and stable page-to-page zone/axis/overview geometry.
- No detected label-label, label-mark, same-record label-mark, zone-label/record or zone-label/zone-label intersection.
- No detected panel text intersection, offscreen control/panel, overflowing button or unresolved icon; all panels remain above the overview.
- Non-button source, mode, connection and footer text ranges fit their elements and viewport. Both Local connection labels end at x=1580 in the 1600 px desktop viewport, leaving 20 px of right clearance.
- All eleven scale-unit options fit in the visible selector; the mobile settings target is 44 x 44 CSS pixels.
- Exact viewport dimensions, zero page errors, and distinct Local status without a connected-server claim.

The mobile record OPS-007 has one deliberate compact-label ellipsis. Its complete text is retained in the static title/accessibility metadata, but focus/touch/descriptor access still needs real browser interaction tests. Geometric checks use DOM bounds; they are not proof of a production layout algorithm, pixel-perfect contrast, accessibility conformance, network behavior, JSON durability, or provider parity. All eight final captures also received visual inspection.
