# Preview Startup Measurements

Measured on the development Windows machine using Edge, fresh browser contexts,
disabled cache, and the complete standalone application served with gzip under
`/open_timeline2.0/`. This is a local simulation, not a live GitHub Pages benchmark
or a real-phone certification. The machine/browser and exact bundle hash are in
[the raw results](demo-startup-results.json).

| Profile | Three first-ready samples | Navigation round trip |
| --- | --- | --- |
| Desktop, no throttling, 1600 x 900 | 1.14 s, 1.07 s, 1.06 s | 152-157 ms |
| Mobile viewport 390 x 844; 1.6 Mbps; 150 ms latency; 4x CPU slowdown | 16.51 s, 16.37 s, 16.66 s | 2.25-2.31 s |

The HTML is approximately 8.39 MiB uncompressed and 2.15 MiB with gzip. At the
simulated download rate, transferring that compressed payload alone requires
roughly eleven seconds before protocol, parsing, and rendering overhead. Every
sample verified Local mode, nonblank canvas pixels, and no horizontal page overflow.
Navigation timings include browser-driver overhead and are not frame-time metrics.

The slower mobile result is a limitation. Three samples do not establish p95/p99
performance. No hard performance gate is declared passed by this report.

## Hosted Measurement: September 14, 2026

The actual [GitHub Pages demo](https://arcazj.github.io/open_timeline2.0/) was also
measured after [deployment 34821760189](https://github.com/arcazj/open_timeline2.0/actions/runs/34821760189).
Three fresh-context samples used the same desktop/mobile emulation profiles:

| Profile | First-ready samples | Navigation round trip |
| --- | --- | --- |
| Desktop | 2.43 s, 1.71 s, 2.24 s | 149-151 ms |
| Mobile slow-4G, 4x CPU | 16.77 s, 17.03 s, 16.96 s | 2.22-2.41 s |

The downloaded HTML was 8,833,809 bytes (2,310,258 encoded transfer bytes).
Its SHA-256 was `70d1bbfb766d0fcb4a6cff0fcbf7aea5b8454b9ecc76af54c52aedc15c63914d`,
matching the clean build from commit `e5af7cbbe3f531766b4523e49849bd6e65de6100`.
Every sample checked nonblank canvas pixels, Local mode, and absence of horizontal
overflow. The raw local benchmark report is
`artifacts/performance/demo-startup-hosted.json`; its `localBundleSha256` field
describes the separate working-copy reference, not the hosted response.
These are observations, not a passed performance budget or a real-device test.

## Reproduce

```sh
npm run build:demo
npm run measure:demo -- --runs 3
```

Results and screenshots are written under `artifacts/performance/`. Once the public
demo is deployed, add `--hosted` to measure the actual GitHub Pages URL under the
same emulation settings. A failed/missing site produces a failed result, not an
apparently fast successful load.

## Next Optimization Work

Keep the complete, single-file offline edition unchanged as a supported deliverable.
Before adding a separate optimized hosted build, profile parsing and initialization
and measure which embedded documentation, API help, and dataset payloads dominate
transfer. A hosted-only lazy asset strategy would need independent offline/error
tests and must never silently turn a complete local snapshot into a last-page cache.
The current preview does not introduce a second, divergent application.
