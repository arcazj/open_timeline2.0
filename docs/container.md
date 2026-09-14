# Local-Volume Container

The Dockerfile builds the same self-contained client and a Python 3.12 service
using locked npm/uv dependencies. The runtime uses UID/GID 10001, one writer, no
Node runtime and a separate local persistent data volume. Build context is
allowlisted; runtime data, credentials, editor files and browser artifacts are not
sent to the builder. No image is pushed or published by these commands.

```powershell
docker build --target runtime --tag openbexi-timeline:local .
docker volume create openbexi-timeline-data
$env:OPENBEXI_API_TOKEN = uv run python -c "import secrets; print(secrets.token_urlsafe(32))"
docker run --name openbexi-timeline --detach --read-only --tmpfs /tmp:rw,noexec,nosuid,size=128m --cap-drop ALL --security-opt no-new-privileges --publish 127.0.0.1:8765:8765 --mount source=openbexi-timeline-data,target=/var/lib/openbexi --env OPENBEXI_API_TOKEN openbexi-timeline:local
```

Retain that credential privately. On restart the existing JSON identity root is
authoritative; a newly generated environment value does not replace it. Connect
through `http://127.0.0.1:8765`. Readiness is `/health/ready`; process liveness is
`/health/live`. The health check does not certify the entire release.

Do not run two containers against the volume, use multiple workers, put data on a
network share, expose the port publicly without the remaining deployment review,
or mount a workspace containing credentials as static content. Bind-mount operators
must establish UID/GID 10001 permissions themselves; the entry point never runs a
recursive privileged ownership rewrite. Stop the container before inactive-root
backup, migration, restore or identity recovery. Follow [backup/restore](backup-restore.md)
and [identity recovery](identity.md); never remove metadata to bypass failures.

## Linux Verification Target

```powershell
docker build --target verification --tag openbexi-timeline:verification .
docker run --rm openbexi-timeline:verification
docker run --rm openbexi-timeline:verification npm test
docker run --rm openbexi-timeline:verification npm run test:parity
docker run --rm --shm-size=1g openbexi-timeline:verification npm run test:e2e
docker run --rm --shm-size=1g openbexi-timeline:verification npm run test:matrix
```

The separate target contains test dependencies and Linux Chromium/Firefox. Its
temporary fixture roots are not the production volume. Preserve reports by copying
`/app/artifacts` from an explicitly named test container before deleting that
container; `--rm` examples intentionally discard reports. Passing these commands
is evidence for that image only, not a Windows, screen-reader, power-loss or
controlled performance qualification.

Node/Python/uv base images are pinned by resolved multi-platform digest. Capture
the final image ID, lockfile hashes and standalone build manifest for every
candidate; base updates require an explicit digest change and a fresh test run.
uv integration follows its
[official container integration guidance](https://docs.astral.sh/uv/guides/integration/docker/).
No final image, container test or public-release qualification is implied merely
by this Dockerfile's existence.
