# OpenBEXI Timeline 2.0

**Explore events and sessions across time, from milliseconds to millennia.**

A JavaScript and Three.js timeline with a Python API, JSON-file storage, and a complete offline edition. Navigate a detailed timeline and its synchronized overview, inspect overlapping sessions, and switch between Timeline, Table, and Split views without changing your data source.

[Live demo](#live-demo) | [Quick start](#quick-start) | [Screenshots](#screenshots) | [Documentation](#documentation) | [Contributing](CONTRIBUTING.md)

![OpenBEXI Timeline with event markers, duration bars, colored zones, synchronized overview, and vertical pagination](docs/ui/test-data/default-dataset.png)

*Actual application capture using the bundled operations dataset, not a design mockup.*

> **Status: development preview, version 0.1.0.** Useful, tested workflows are implemented, but full legacy parity, production hardening, and all release qualification gates are not complete. See [implementation status](docs/implementation-status.md) and [verification evidence](docs/preview-commit-verification.md).

## Live Demo

**Demo address:** [arcazj.github.io/open_timeline2.0](https://arcazj.github.io/open_timeline2.0/)

**Live on GitHub Pages.** The [first deployment](https://github.com/arcazj/open_timeline2.0/actions/runs/34821760189) passed on September 14, 2026. The [demo workflow](.github/workflows/demo.yml) builds and tests the real application, then publishes it without a Python server. A working demo is not full production qualification; see the [publishing guide](docs/publishing.md) and [verification evidence](docs/preview-commit-verification.md).

The demo is the standalone application, not a video or a server-backed service. It includes six complete local datasets. Open **Help and sharing > Test local data**, select a dataset, and choose **Open dataset**. Importing JSON is local to the browser; connecting to a server is an explicit, separate action. Changes to editable snapshots live in memory: export JSON before closing. Historical fixture snapshots are read-only.

For an immediately usable offline copy, follow the two-command build below and open `dist/index.html`. A successful demo workflow also provides an `openbexi-standalone` download under its run's **Artifacts** section.

### Downloadable Preview

The [preview release workflow](.github/workflows/preview-release.yml) packages a standalone ZIP, `SHA256SUMS`, and a commit-linked release manifest. Public releases require owner approval and successful Windows/Linux candidate checks. See [Preview 1 release notes](docs/releases/v0.1.0-preview.1.md); this is not a stable release announcement.

To generate the package locally after building:

```sh
uv run python scripts/package-preview.py --tag v0.1.0-preview.1
```

The output is `artifacts/releases/v0.1.0-preview.1/`. Extract the ZIP and open `index.html`; no Python or Node.js installation is needed to use the downloaded application.

## What You Can Do

- **Navigate time naturally.** Drag with momentum, stop movement with a click, use the calendar, or move the overview's selected range. Browse past and future within the supported date domain.
- **Keep crowded intervals readable.** Density-aware local magnification, manual 1x-32x controls, measured label placement, and vertical row pagination work together. Changing row pages preserves the time range.
- **See context.** Duration bars, point markers, translucent zones, search highlights, and a right-hand descriptor keep individual records connected to the broader timeline.
- **Filter precisely.** The opt-in version-2 workflow adds safe field-scoped regex, typed conditions, parent/family context, natural ordering, group collapse, reviewed migration and version-pinned saved views. [Workflow and qualification status](docs/sorting-filtering/implementation-status.md).
- **Combine or separate sources.** Browse sources together with ALL, or organize lanes by NAMESPACE. Select multiple server paths and keep favorites in the toolbar.
- **Customize the workspace.** Versioned visual models, schemas, filters, views, settings, and configurable bands share the same provider contracts.
- **Work online or offline.** Use a Python-backed view, a complete bundled snapshot, or an imported JSON file. The source and snapshot status remain visible.
- **Share a view.** Export a timeline PNG, share view settings, export a complete permitted snapshot, or inspect embedded documentation and OpenAPI help.

Legacy archives remain **read-only**. The separate writable JSON workspace API supports event/session and configuration commands; it never turns a linked legacy directory into a write target.

Legacy browsing can save application-owned filters, views and preferences in a separate JSON directory under the server state root. It cannot modify legacy records, models or descriptors. Selecting an item opens its metadata immediately and loads an available descriptor sidecar safely; missing sidecars do not block navigation.

## Quick Start

### Offline Application

Prerequisite for building: **Node.js 22+** with npm. Python is not required.

```sh
git clone https://github.com/arcazj/open_timeline2.0.git
cd open_timeline2.0
npm ci
npm run build
```

Open **`dist/index.html`** in a current browser with WebGL2 enabled. The single file contains JavaScript, Three.js, CSS, fonts, workers, help, and the complete local dataset library. No CDN, internet connection, module server, or local web server is needed at runtime.

For development, run `npm run dev`. The terminal prints the URL, normally `http://127.0.0.1:4173`; it chooses another port if necessary. Source changes rebuild the standalone application. `/api` requests proxy to the Python service on port 8765.

### Python Server: Read-Only Local Data

Prerequisites: **Python 3.12 or 3.13** and [uv](https://docs.astral.sh/uv/). Run commands from the repository root.

```sh
uv sync --locked
npm ci
npm run build
uv run python scripts/serve-legacy.py --yaml yaml/test-data/default-dataset.yml
```

Open the **client URL printed in the terminal**, normally `http://127.0.0.1:8781` for this profile. This is a complete, included example with no external archive dependency. It binds to loopback and needs no pasted bearer token.

Change just the YAML argument to browse another fixture:

| Dataset | Records | YAML profile | Presentation |
| --- | ---: | --- | --- |
| Default dataset | 48 | `yaml/test-data/default-dataset.yml` | Operations, zones, dense intervals |
| Ephemeris | 127 | `yaml/test-data/ephemeris.yml` | Hour-scale events |
| JFK | 130 | `yaml/test-data/jfk.yml` | Minute-scale detail and broader overview |
| Monet | 27 | `yaml/test-data/monet.yml` | Single band and relative age axis |
| Religions | 730 | `yaml/test-data/religions.yml` | Multiple bands and BC dates |
| Space exploration | 1,287 | `yaml/test-data/space_exploration.yml` | Long-range history |

All **2,349 records** are also available without Python through the Help panel. Each dataset opens as a separate complete source with its own preset. **Reset reference view** restores its initial presentation.

### Your Legacy JSON Archives

Edit a launch profile to match paths accessible **from the server**, then run:

```sh
uv run python scripts/serve-legacy.py --yaml yaml/multiple_sources_test.yml
```

The supplied archive profiles are templates for the author's local layout, not bundled data:

| Profile | Expected archive |
| --- | --- |
| `yaml/multiple_sources_test.yml` | SOURCE1 and SOURCE2 under `C:/data` |
| `yaml/earthquake_volcano_data.yml` | Earthquake and volcano files under `C:/data` |
| `yaml/default_test.yml` | Test archives in a sibling `openbexi_timeline` checkout |

Legacy sources support `<path>/yyyy/mm/dd` partitions. The server reads the visible interval and a small buffer first, then loads more on navigation. Sessions overlapping the interval are included even when they begin earlier. Background discovery reports provisional coverage until older partitions are verified; it does not claim an incomplete window is a complete archive.

Keep private launch overrides in `yaml/local/` or `config/local/`, which are excluded from Git. See [source paths and favorites](docs/local-source-paths.md), [legacy JSON compatibility](docs/legacy-json-sources.md), and [on-demand loading](docs/on-demand-loading.md).

### Writable Python API

The writable workspace is separate from read-only archive browsing. On PowerShell:

```powershell
uv sync --locked
npm run build
$env:OPENBEXI_DATA_ROOT = "$PWD/runtime/data"
$env:OPENBEXI_API_TOKEN = uv run python -c "import secrets; print(secrets.token_urlsafe(32))"
uv run uvicorn server.app.main:app --host 127.0.0.1 --port 8765
```

Open `http://127.0.0.1:8765` and connect through **Source and connection** using that token. Keep it privately for subsequent starts: generating a new value does not replace an existing identity root's credentials. Never put credentials in YAML committed to Git, URLs, exported snapshots, or screenshots.

Use **one process and one writer per JSON root on local disk**. Multiple Uvicorn workers and shared network storage are unsupported. Do not expose this development service publicly without completing deployment hardening. See [API reference](docs/api.md), [identity](docs/identity.md), [backup and restore](docs/backup-restore.md), and [container setup](docs/container.md).

## Screenshots

These images were captured from the implemented application. Reference-inspired layouts are not a claim of pixel-identical legacy rendering. Click an image to inspect it at full size.

### Detailed Events, Zones, and Overview

[![Minute-scale events with labels and an orange time zone above a synchronized overview](docs/ui/test-data/jfk.png)](docs/ui/test-data/jfk.png)

### Multiple Bands and Historical Scales

[![Religions dataset showing separate bands, BC dates, duration bars, and a magnified overview](docs/ui/test-data/religions.png)](docs/ui/test-data/religions.png)

### Legacy Record Descriptors

[![Selected session with a read-only linked descriptor beside the timeline and overview](docs/ui/sorting-v2/descriptor-desktop.png)](docs/ui/sorting-v2/descriptor-desktop.png)

The sorting/filtering candidate retains the legacy right-hand descriptor, including linked sidecar metadata. See the [desktop and offline mobile gallery](docs/sorting-filtering/implementation-status.md#actual-candidate-screenshots), [capture provenance](docs/ui/sorting-v2/screenshots.json), and [illustrated candidate guide (PDF)](output/pdf/sorting-filtering-candidate.pdf). These captures document the candidate build, not the currently deployed main-branch demo or a stable release.

More: [six-dataset gallery and mobile captures](docs/local-test-data.md), [earthquake and volcano rendering](docs/hazard-rendering-parity.md), [namespace lanes and search](docs/legacy-json-preview.md), and [screenshot PDF](output/pdf/local-test-data.pdf). The screenshot PDF records its own capture build; rebuilding the application does not retroactively requalify that evidence.

## How It Fits Together

```text
client/                 JavaScript, Three.js rendering, HTML controls, providers
data/                   Complete fixtures, originals, presets, conversion reports
server/app/             Python HTTP API, services, JSON repositories
shared/                 JSON Schema, OpenAPI, cross-language fixtures
yaml/                   Server launch profiles; test-data/ works out of the box
scripts/                Build, export, migration, verification, publishing tools
tests/                  Client, server, integration, and browser tests
docs/                   Architecture, contracts, screenshots, operational guides
.github/workflows/      Candidate verification and opt-in demo deployment
dist/                   Generated standalone output; not committed
```

The renderer talks to one data-provider interface. Server mode retrieves bounded records and metadata for the current view; Local mode queries the complete selected snapshot in a browser worker. Both use consistent interval, filter, layout, density, and pagination rules. Data persists as JSON files, not SQL, MongoDB, or another database.

## Testing

```sh
npm run check:repo
npm test
uv run pytest tests/server
npm run test:parity
uv run python scripts/normalize-test-data.py --check
uv run python scripts/export-openapi.py --check
npm run build
npx playwright install chromium firefox
npm run test:e2e
npm run test:matrix
```

The default Windows browser suite uses installed Microsoft Edge; the focused matrix also exercises Chromium and Firefox. See [testing setup and evidence](docs/testing.md). CI verifies Windows/Linux and Python 3.12/3.13; the existence of a workflow is not proof that its latest run passed.

`npm run build:demo` prepares only the intended static files under `artifacts/demo/`. `npm run test:demo` checks the application at a project-site URL, including offline behavior, mobile layout, and nonblank canvas rendering. See [publishing](docs/publishing.md) for the separate public deployment gate.

`npm run measure:demo -- --runs 3` measures uncached desktop and simulated slow-4G/mobile startup, compressed transfer sizes, and navigation responsiveness. Results and screenshots go to `artifacts/performance/`; local simulation is not a measurement of the hosted GitHub Pages site.

The [initial measurements](docs/demo-performance.md) were about 1.1 seconds on desktop and 16.4-16.7 seconds under slow-4G/mobile emulation. The slower profile remains an optimization target, not a passed performance gate.

## Documentation

| Topic | Guide |
| --- | --- |
| Architecture and data | [Architecture](docs/architecture.md), [data model](docs/data-model.md), [provider contracts](docs/provider-standalone-contract.md) |
| Navigation and presentation | [Calendar and momentum](docs/calendar-navigation.md), [local scaling](docs/local-scaling.md), [models](docs/model-management.md), [filters and search](docs/filters-and-search.md) |
| Sorting/filtering candidate | [Implemented workflow and descriptor gallery](docs/sorting-filtering/implementation-status.md), [candidate PDF](output/pdf/sorting-filtering-candidate.pdf), [read-only source preferences](docs/sorting-filtering/legacy-preferences.md), [regex qualification](docs/sorting-filtering/regex-qualification.md) |
| Sorting/filtering design and evidence | [Illustrated implementation prompt](OpenBEXI_Timeline_Sorting_Filtering_Prompt.md), [legacy analysis and executable evidence](docs/sorting-filtering/analysis.md), [acceptance plan](docs/sorting-filtering/acceptance.md), [original design PDF](output/pdf/OpenBEXI_Timeline_Sorting_Filtering_Prompt.pdf) |
| Data sources | [Standalone](docs/standalone-mode.md), [local datasets](docs/local-test-data.md), [legacy migration](docs/migration-from-tomcat.md) |
| API and operations | [API](docs/api.md), [OpenAPI contract](docs/api-contract.md), [identity](docs/identity.md), [backup](docs/backup-restore.md) |
| Project health | [Implementation status](docs/implementation-status.md), [performance](docs/performance.md), [release checklist](docs/release-checklist.md) |
| Publishing and contribution | [Publishing guide](docs/publishing.md), [contributing](CONTRIBUTING.md), [security policy](SECURITY.md) |

## Limits and Licensing

Local imports are currently bounded to **25,000 records / 64 MiB** and reject oversized datasets instead of truncating them. Local edits are not a durable server backup and do not synchronize automatically. Cross-platform accessibility, full legacy behavior, large-dataset performance, and production deployment still have open qualification work.

Project code and authored documentation are licensed under [GNU GPL version 3](LICENSE) (`GPL-3.0-only`). Existing third-party licenses, including the legacy assets' GPL-3.0-or-later notices, remain intact. The owner approved publication of the bundled datasets and images on September 14, 2026; this does not relicense third-party material. See the [redistribution record](docs/data-licensing.md), [third-party notices](docs/third-party-notices.md), and [dataset provenance](data/README.md).

The [data and asset review](docs/data-licensing.md) identifies the outstanding permissions separately. Dependency update PRs are configured for npm, uv, GitHub Actions, and Docker; they are reviewed rather than automatically merged. [Private vulnerability reporting](SECURITY.md) is enabled.
