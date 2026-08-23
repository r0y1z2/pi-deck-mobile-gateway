# Security Policy

## Intended network boundary

Pi Deck Mobile Gateway is designed for private tailnet access only.

- The gateway binds to `127.0.0.1` and must not be changed to a LAN or public
  interface.
- Publish it with Tailscale Serve, not Tailscale Funnel, router port forwarding,
  or a public reverse proxy.
- Do not create Windows Firewall allow rules for PiDeck port `8765` or gateway
  port `31415`. PiDeck 0.7.0 may listen on `0.0.0.0:8765`, so the host firewall
  remains an important boundary.
- Both devices must be in the same trusted tailnet. Remove lost or retired
  devices from both the gateway device list and the Tailscale admin console.

## Authentication and local data

The six-digit pairing code is valid for ten minutes and one use. It appears in
the gateway console and local stdout log, so protect the Windows account and
the runtime directory.

Paired device tokens are stored as SHA-256 hashes in
`PI_SERVER_DIR\deck-devices.json`, or in the default Pi server directory under
the current user's profile. Browser cookies use `Secure`, `HttpOnly`, and
`SameSite=Strict` attributes.

Task records and Pi session references may contain private workspace names and
metadata. Pi session JSONL files contain conversation content and must never be
committed or attached to a public issue.

This repository intentionally excludes:

- device stores, task databases, sessions, cookies, and pairing tokens
- API keys, model credentials, OAuth tokens, and private npm configuration
- Tailscale node identity or state
- runtime logs, PID files, local paths, and machine-specific URLs
- dependencies and build output

## Gateway protections

- Mobile-created tasks are restricted to the workspace allowlist supplied on
  the PC command line.
- The gateway validates Host and Origin values for write requests.
- Phone cookies, authorization headers, and Origin headers are not forwarded to
  the PiDeck loopback service.
- PiDeck response cookies, permissive CORS headers, and hop-by-hop headers are
  not returned to the phone.
- A task path supplied by the phone is never trusted as a workspace path.

These controls reduce exposure but do not sandbox Pi. Pi and PiDeck run with
the permissions of the Windows user that launched them. Use a dedicated OS
account, container, or sandbox when stronger isolation is required.

## Dependency audit baseline

As of 2026-08-23, `npm audit --omit=dev` reports high-severity advisories in
the inherited monorepo lockfile:

- `brace-expansion@5.0.7`, through the coding-agent `glob` dependency
- `undici@8.5.0`, a direct coding-agent dependency, and nested `undici@6.27.0`
- `shell-quote@1.8.4`, through the included sandbox example workspace

These are inherited dependencies, not packages introduced by the mobile
gateway. They must be updated in a separate reviewed lockfile change with the
full workspace test suite. Until then, keep this service tailnet-only, do not
enable Funnel, and do not treat the gateway as an Internet-facing service.

## Reporting a vulnerability

Use GitHub private vulnerability reporting when it is enabled for the
repository. Do not include live credentials, session transcripts, pairing
codes, device tokens, or Tailscale identity material in a report. Revoke and
rotate any credential that may have been exposed.

For vulnerabilities that affect upstream Pi independently of this gateway,
follow the upstream reporting process described in
[UPSTREAM_SECURITY.md](UPSTREAM_SECURITY.md).
