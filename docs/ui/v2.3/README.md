# SIMILE-Style Visual Targets

Revision 2.3, 12 September 2026. The two newly supplied SIMILE screenshots are the primary visual references. The five new images below are **static document-design mockups, not application screenshots or evidence of implemented interactions**. Their purpose is to make the proposed layout and states inspectable before code generation.

The default keeps a light main timeline above a smaller synchronized overview, bottom time axes, compact colored markers/bars, reusable readable tracks and translucent vertical zones. A compact legacy menu remains, with model/filter/search management and optional descriptor access. Earlier Classic blue and dark images remain compatibility references, not the current default. See the [main specification](../../../OpenBEXI_Timeline_Rebuild_Prompt.md), [scale contract](../../adaptive-scale-contract.md), [query contract](../../adaptive-query-contract.md) and [integration plan](../../integration-test-plan.md).

## V09: Uniform Scale

![SIMILE-style two-band timeline with Uniform scale](ui-simile-uniform.png)

Auto scale is off. Detail covers 08:00-17:00 on 12 September 2026 UTC; overview covers the full day. Of 48 illustrative records, 23 occupy the first 15 authored logical rows. There are 40 logical rows in total, so this height gives three pages. Labels and duration bars retain readable spacing. Long sessions show continuation at the viewport boundaries.

## V10: Adaptive Scale, First Row Page

![Locally magnified SIMILE-style timeline, rows 1-15](ui-simile-adaptive-page-1.png)

The accepted AS-UI-01 illustration gives 12:00-13:00 four times the local scale of the surrounding context. This map is deliberately specified for visual comparison; it is not a claimed output of a functioning density solver. The first 23 detail records remain, as do all 48 overview records. Bottom ticks and reserved scale brackets identify the nonuniform spacing. A separate top strip keeps the two zone labels away from records.

## V11: Adaptive Scale, Second Row Page

![Same nonlinear interval and zones, rows 16-30](ui-simile-adaptive-page-2.png)

The next 15 records appear on rows 16-30. The time interval, map, axis positions, zone boundaries, reference time, overview marks and overview viewport are unchanged. The fixture's authored row numbers demonstrate the view contract, not server allocation. A future implementation must compute complete global rows before paging them.

## V12: Search Across All Pages

![Yellow Telemetry matches and findings-only overview](ui-simile-search.png)

The query Telemetry matches OPS-002, OPS-010, OPS-018, OPS-026 and OPS-034. Only the first two are on the loaded 23-record page and receive yellow label backgrounds. All five appear in the overview. The other contextual detail records remain, and search does not change the context-based map or row placement. Zones and viewport chrome are not findings and remain visible.

## V13: Narrow View

![Narrow SIMILE-style timeline with visible overview and row controls](ui-simile-mobile.png)

390 x 844 CSS pixels, with an explicitly focused 12:00-13:00 detail window and unchanged full-day overview. That window contains 40 records; 12 appear on this authored page. The overview retains all 48 records in its own broader scope. One label is ellipsized; its required keyboard/touch/descriptor full-text path must be implemented and tested, not inferred from this static image. Settings provide a compact entry point for the overflowed workflows.

## E04: Primary Duration Reference

![Unmodified SIMILE duration-band reference](evidence-simile-durations.png)

User attachment `ai-chat-custom-attachment-temp-file-417d9068-640b-486b-b6d6-b7260786de48-2817999764077794512.png`, copied unchanged. Historical titles/dates are reference content, not application data. No historical SIMILE runtime was launched to obtain it.

## E05: Primary Zone Reference

![Unmodified SIMILE colored-zone reference](evidence-simile-zones.png)

User attachment `ai-chat-custom-attachment-temp-file-417d9068-640b-486b-b6d6-b7260786de48-14869588286837011505.png`, copied unchanged. The orange time region is visible in both bands at different scales. Its location in this second attachment is identified directly rather than assuming attachment order from prose.

## Fixture and Verification Scope

`design-fixture.json` contains 48 synthetic operational records with display aliases, UTC minute-of-day values, two annotation zones and an illustrative accepted map. It is specification data, not canonical application JSON or a runtime database. Future test adapters supply stable UUIDs and schemas. Production views must use actual authorized server records; do not ship this data as an implicit fallback or recreate the historical reference content.

For AS-UI-01 the full-day map has knots `(00:00,0)`, `(12:00,12/27)`, `(13:00,16/27)`, `(24:00,1)`. At W=08:00-17:00, 12:00 and 13:00 occupy one-third and two-thirds of plot width. Reference 12:30 is centered. Orange Maintenance spans 12:10-12:45; cyan Verification window spans 12:30-13:20. Each band projects those endpoints independently. The separate AS-MAP-01 fixture, not this image, tests the exact automatic density formula.

Captures use Playwright/headless Edge at device scale 2 from temporary static document markup outside the project. Desktop is 1600 x 900; main-band height is fixed at 600 with 64 px top reservation, 32 px bottom axis and 32 px row pitch, allowing 15 rows. Mobile keeps both bands and derives a 12-row capacity. Lucide supplies controls. No application, dev server or application dependencies were created.

`capture-verification.json` records actual artifact checks: viewport/scroll bounds, visible control overflow, icon resolution, label-label/label-mark/zone-label intersections, detail/overview IDs and exact equality of axes, zone boxes, viewport and overview records across the two desktop pages. Search membership is checked separately from loaded counts. These checks do not verify a density engine, server pagination, full accessibility, persistence, live synchronization or executable controls. Those require the real integration gates before code delivery.
