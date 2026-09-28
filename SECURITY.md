# Security

## Intended boundary

Heapscape is a local diagnostic viewer for **trusted dumps**. The server binds to loopback and enforces same-origin API requests; it is not a multi-user service, authenticated hosting platform, or hardened parser for hostile input. Do not expose it through a network binding, proxy, tunnel, or shared public host.

ClrMD loads native DAC code. An analyzer worker provides crash containment, cancellation, and a timeout, **not a security sandbox**. Analyze only dumps and matching runtimes/DACs you trust. Cross-OS and cross-architecture analysis are not supported.

Dumps, exported graphs, previews, logs, and screenshots can contain secrets or personal data. Disabling previews is not sanitization. Temporary uploads live under a per-server `Heapscape` directory in the OS temporary location. Removal and graceful shutdown delete those files; forced termination may leave them behind. Deletion is not secure erasure.

The viewer does not upload data to cloud services or download symbols. Dependency installation contacts package registries. Keep the operating system, browser, runtimes, and dependencies maintained.

## Reporting a suspected vulnerability

Do not include exploit details, real dumps, secrets, or affected-user data in a public issue, pull request, or discussion.

If **Security > Advisories > Report a vulnerability** is available for this repository, use that private GitHub reporting channel. If it is unavailable, contact the repository owner through an existing private channel to agree on a confidential reporting route before sending sensitive details. No separate security contact or response-time commitment is currently published.

Provide the affected commit/version, platform, impact, and minimal reproduction steps using synthetic data. Share captured memory only through an explicitly agreed private process after reviewing its contents; a source-only reproducer is preferable.

## Current status

The CI baseline exercises builds and synthetic correctness checks; it is **not a full security audit** and does not establish safety for untrusted dumps. No supported-release/backport policy has been established. Before public release, the owner must select a private reporting route and review the [public-release checklist](docs/public-release-checklist.md).
