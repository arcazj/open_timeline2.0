# Security Policy

## Current Scope

Version 0.1.0 is a development preview, not a qualified public-facing service. Run the Python server on loopback unless you have independently reviewed deployment security. Token-free legacy browsing is designed for local use only.

- Use one writer process per local JSON storage root. Do not use multiple Uvicorn workers or shared network filesystems.
- Legacy archive sources are read-only and constrained by configured allowed roots. Never expose arbitrary filesystem paths to an untrusted client.
- Writable API credentials belong in the process environment or a secret manager, not committed profiles, HTML, URLs, exports, logs, or screenshots.
- Treat a standalone HTML file as a data export: every embedded record is readable by anyone receiving it. A static demo has no server authorization boundary.
- Local edits remain in browser memory until explicitly exported. A snapshot is not an operational backup.

Read the [identity guide](docs/identity.md), [backup/restore guide](docs/backup-restore.md), and [implementation limitations](docs/implementation-status.md) before deployment.

## Reporting a Vulnerability

Do not open a public issue containing credentials, personal records, or an exploit against a live installation. Private vulnerability reporting is enabled for this repository. Use [Report a vulnerability](https://github.com/arcazj/open_timeline2.0/security/advisories/new) to send a confidential report. If that option is unavailable, contact the repository owner privately through an established channel; do not assume a public issue is private.

Include affected versions, a minimal reproduction using synthetic data, impact, and suggested mitigations. There is no published support SLA or security certification. If credentials were exposed, revoke them and follow the identity recovery/rotation procedure; removing the visible file or Git commit alone does not revoke access.
