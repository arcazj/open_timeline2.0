# Architecture

## Decision ADR-001

Implementation started from specification revision 2.4. Python/FastAPI/Pydantic/Uvicorn is the service stack; JavaScript/Three.js is the shared browser client. Node/esbuild bundles one modular application into the standalone file. Runtime versions and exact resolved dependencies are recorded in package-lock.json and uv.lock.

The client renderer consumes provider results without direct HTTP. LocalProvider owns a complete validated in-memory source and computes density/global rows. ServerProvider translates the same operations to authenticated Python routes, which prepare immutable server-side query/layout snapshots. Pagination changes rows, not the horizontal interval or map. Source epochs and request intent guard against obsolete results.

`createLocalProvider` in `client/src/data/worker-provider.js` selects an embedded Blob worker in supported browsers, with the direct LocalProvider retained for Node and worker-unavailable/startup-blocked environments. `local-worker.js` is an RPC boundary around that same LocalProvider, not a second query or CRUD implementation. Raw imported JSON is parsed and validated in the worker. Queries, tables, layouts, model catalogs and idempotent outcomes remain worker-owned; the client receives bounded requested pages and explicit exports. The worker wrapper retains provider identity/generation/revision, change subscriptions and the full async provider API.

The transport freezes command intent before its first await, limits pending requests to 64, forwards cancellation and releases late read allocations. A dispatched mutation without a confirmed response is unknown and must be reconciled by original command identity against the same surviving worker. Startup-only fallback cannot replace a modified worker branch after a crash. Worker termination loses its memory; no automatic replay or synchronization is performed. Main-thread rendering, structured cloning and export serialization are separate costs and are not claimed to be offloaded. See [standalone-mode.md](standalone-mode.md) for the operational limits.

The admitted render profiles use bundled Noto Sans Latin 400/700, normal/italic, with measured glyph metrics generated from the exact fonts. Browser labels disable kerning and ligatures for deterministic shared advances. These profiles are an explicit scope, not universal shaping or all-model compatibility. Unsupported glyph/model/profile cases require visible diagnostics and are tracked in implementation status.

The exact piecewise mapping, positive density weights, overlapping-session membership and decimal-view arithmetic follow the existing normative companions. Decimal.js and Python Decimal preserve local projection accuracy inside large domains. Calendar tick generation uses the Temporal polyfill; no Python runtime is embedded in the browser.

## Build Boundary

`scripts/build-standalone.mjs` validates the embedded snapshot, first bundles the Local worker as an IIFE, embeds that exact source into the main application, bundles dependencies/assets/fonts and writes dist/index.html. Both build graphs reject external imports. The manifest records input/lockfile/dataset/HTML hashes and the embedded worker's hash/byte count; the dependency graph includes both build inputs. No separate worker file is required at runtime, and no second domain implementation is maintained. External build-time package acquisition is separate from zero-network local-file runtime use.

The development server only serves the generated HTML and proxies API requests; it cannot read arbitrary workspace files. The Python deployment serves the same HTML. Single-file use requires neither service. Server connection is explicit and uses a token held in memory, never embedded in the artifact.

## Visual Model Catalog

Model definitions use shared JSON schemas and a versioned catalog envelope. Local and Server providers expose the same validation, draft, publication, lifecycle and apply commands. Publication appends an immutable definition; only explicit application changes the workspace's pinned version. The nine required fields plus optional versioned presentation are recorded in [model-catalog-contract.md](model-catalog-contract.md) and [presentation-contract.md](presentation-contract.md). Applying an old definition without presentation removes prior presentation settings rather than retaining stale overrides.

Preview owns a separate query, layout, renderer and cancellation lifecycle. It reads the active source but never replaces the main timeline's query or settings. Catalog mutations use the same source generation, optimistic revision and idempotent outcome rules as record mutations.

Complete snapshots carry model history and pins. Original flat presets normalize only after validating the original snapshot's integrity; an authorized server mutation persists that normalization through the JSON repository transaction. Python's RFC 8785 implementation and the JavaScript canonical serializer are checked against shared numeric/Unicode vectors. The pinned `tzdata` package and Node ICU intersection generate the explicit named-zone registry in `shared/fixtures/time-zones.json`; regenerating it is a compatibility change, not a startup side effect.

## Evidence and Release Scope

The old listener remains navigation/inspection evidence, not a model for implicit persistent drag edits. Existing audits and the 17-page brief remain compatibility inputs. The current increment adds supported visual-model lifecycle management; the full file-by-file M0 inventory, all legacy visual/data-model capabilities, migration matrix, production security and G0-G5 release certification remain separate tracked work. No untested gate is called complete.

Primary references used during implementation: [Three.js orthographic camera](https://threejs.org/docs/pages/OrthographicCamera.html), [esbuild bundling API](https://esbuild.github.io/api/), [FastAPI typed request bodies](https://fastapi.tiangolo.com/tutorial/body/) and [lifespan handling](https://fastapi.tiangolo.com/advanced/events/).
