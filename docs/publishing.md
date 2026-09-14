# Publishing to GitHub

Target repository: [arcazj/open_timeline2.0](https://github.com/arcazj/open_timeline2.0).

See [publication verification](publication-verification.md) for the checks actually run during preparation and the work not yet performed.

## Publication Boundaries

Commit source, locked dependencies, shared contracts, tests, reviewed fixtures, screenshots, and documentation. Do not commit installed dependencies, the standalone build, runtime identities, local archives, tokens, private source exports, browser traces, or temporary PDF tooling.

`.gitignore` excludes the entire `runtime/`, `var/`, `tmp/`, and `artifacts/` trees, IDE state, and private YAML overrides. Under `output/`, only five explicitly named documentation PDFs are included. The duplicate rebuild-prompt PDF remains local; the root specification and archived reference documents remain preserved. Cleanup excludes files from publication; it does not delete the user's local data.

`npm run check:repo` checks publication paths, common credential patterns, portable filenames, and local links in the entry documentation. `--staged` reads the Git index instead of the working tree; `--build` checks that first-party standalone build inputs are included. These checks cannot prove the absence of every secret or establish redistribution rights. Review screenshots and PDFs manually as well.

Original fixtures use `-text` Git attributes so that cloning on another OS does not change source hashes. Other text uses LF line endings. Existing screenshot verification JSON and PDFs describe the build captured at that time, not every later commit.

## Before the First Public Push

1. Choose an explicit project license with the owner. None has been assigned automatically.
2. Review rights and attribution for `data/original/`, normalized historical datasets, supplied PNGs, legacy assets, and documentation/reference PDFs. Do not infer permissions from the old repository or from JavaScript dependency licenses.
3. Inspect the staged diff, filenames, and file sizes. Keep real server exports and identity state out of Git.
4. Run the commands below from the repository root. Review failing/skipped cases before calling a release qualified.

```sh
npm ci
npm run check:repo
npm run build:demo
npm run check:repo -- --build
npx playwright install chromium
npm run test:demo
git status --short
git diff --cached --stat
npm run check:repo -- --staged --build
```

Stage only reviewed files. When the publication review is complete:

```sh
git commit -m "Prepare OpenBEXI Timeline 2.0 development preview"
git push -u origin main
```

Do not force-push. If GitHub has acquired commits since preparation, fetch and reconcile them first. The intended remote is `https://github.com/arcazj/open_timeline2.0.git`. A prepared index is not a pushed commit, and a configured URL is not a live deployment.

## Enable the Live Demo

The [Standalone Demo workflow](../.github/workflows/demo.yml) builds on pull requests and pushes to `main`, with manual dispatch available. It runs client tests and a project-path browser smoke suite before creating an `openbexi-standalone` artifact. This contains only `index.html` and third-party notices, plus the Pages `.nojekyll` marker. It does not upload the checkout, Python service, `var/`, source exports, or credential files.

The standalone HTML embeds all six local fixtures and the three supplied visual references. The demo therefore needs their redistribution review even though the original source files are not copied as separate web assets.

After completing that review:

1. Open repository **Settings > Pages** and choose **GitHub Actions** as the publishing source.
2. Under **Settings > Secrets and variables > Actions > Variables**, add `PUBLIC_DEMO_APPROVED` with value `true`. This is an approval flag, not a credential. No personal access token is required by the workflow.
3. Optionally require owner approval on the `github-pages` deployment environment, and restrict it to `main`.
4. Run **Actions > Standalone Demo > Run workflow** on `main`, or push a reviewed commit to `main`.
5. Wait for both build and deployment to succeed. Open the deployment URL and test it before removing the README's **Deployment pending** notice.

Expected address: [https://arcazj.github.io/open_timeline2.0/](https://arcazj.github.io/open_timeline2.0/). The URL is a deployment target until the workflow succeeds. A custom domain or changed repository name changes it.

The workflow uses GitHub's documented [custom Pages workflow](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages), with pinned action commits and write/OIDC permissions confined to the deployment job. Pull requests never deploy. With the approval variable absent, the build/download remains available and the deploy job is skipped.

## Verify the Hosted Site

- Open the project URL in a fresh browser profile. Confirm Local mode and the default timeline/overview, with no Python service running.
- Switch through all six datasets from Help, search, move time, change row pages, and inspect a record.
- Test at desktop and mobile sizes. Check the browser console and make sure canvases and labels are nonblank.
- Disconnect networking after loading and continue navigating. For a durable offline copy, download the standalone artifact and open its `index.html` directly.
- Confirm server credentials and private archives are not in the HTML. Local JSON imports are processed in-browser; a user can still explicitly choose to connect to a server.

`npm run build:demo` and `npm run test:demo` exercise this packaging locally under `/open_timeline2.0/`. Browser evidence goes to ignored `artifacts/browser/`; it does not overwrite the documentation captures.

## Release Versus Demo

A green static-demo build is not a full Python/API or production release certificate. The separate [Candidate Verification workflow](../.github/workflows/verify.yml), [release checklist](release-checklist.md), [implementation status](implementation-status.md), and platform evidence retain their independent scope. Do not tag a stable release until its required gates and licensing work are closed.

## Repository Controls

Private vulnerability reporting is enabled and its state has been read back from GitHub. Weekly reviewed dependency updates are configured in `.github/dependabot.yml` for npm, uv, GitHub Actions, and Docker. No automatic merging is configured. Dependabot's supported uv version may lag the developer tool version; review any lockfile update failures instead of bypassing the lock.

After the first approved push creates `main`, apply the checked-in branch policy:

```sh
uv run python scripts/configure-github.py --protection --apply
```

It requires the `Candidate checks` and `Standalone demo checks` aggregate jobs, including for administrators. Force-pushes and branch deletion are disabled. Linear history and conversation resolution are required; an additional human reviewer is not mandatory for this single-maintainer repository. Each aggregate fails if its required jobs fail, cancel, or skip. Repository settings are read back after applying them.

The helper uses an existing Git credential or `GH_TOKEN`/`GITHUB_TOKEN` in memory, never writes it to a file, and refuses credential-bearing redirects. Without `--apply`, it only prints the intended policy. It does not push code, select a license, or invent publication approval.

## Package and Publish a Preview

```sh
npm run build:demo
npm run test:demo
uv run python scripts/package-preview.py --tag v0.1.0-preview.1
```

The ZIP uses fixed metadata and sorted files for reproducibility. It includes the complete HTML, notices, offline instructions, and release notes. `SHA256SUMS` covers the ZIP and the commit-linked `release-manifest.json`. A stale HTML/build-manifest mismatch fails packaging.

Once the owner completes [the licensing/data review](data-licensing.md), set `PUBLIC_RELEASE_APPROVED=true` in repository Actions variables and configure approval on the `preview-release` environment. Push a reviewed `v0.1.0-preview.N` tag that matches the package version and release-notes filename. The [Preview Release workflow](../.github/workflows/preview-release.yml) runs the reusable full candidate matrix and standalone demo tests, then creates a GitHub **prerelease**, not a stable/latest release. Manual dispatch must select an existing preview tag.

The release workflow never runs from an unapproved tag or bypasses failed qualification checks. A locally generated ZIP is not proof of a published GitHub release. Keep `PUBLIC_RELEASE_APPROVED` and `PUBLIC_DEMO_APPROVED` unset until review is complete.

## Measure Startup

```sh
npm run build:demo
npm run measure:demo -- --runs 3
```

The benchmark serves the real bundle with gzip under a project-site path and uses fresh browser contexts/cache-disabled requests. It records desktop and simulated 1.6 Mbps, 150 ms latency, 4x CPU mobile results, verifies nonblank canvas pixels, and captures screenshots. These are small-sample observations on the current machine, not percentile certification or real-device measurements.

After Pages is actually deployed, use `npm run measure:demo -- --hosted --runs 3` for the real URL. It fails on a non-200 response instead of recording a 404 page as a fast application load. Results stay in ignored `artifacts/performance/` and do not rewrite reviewed README screenshots.
