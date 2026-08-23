# @earendil-works/pi-server

Experimental. This package is under active development and may change or be removed without notice. Its CLI, APIs, and behavior are not yet stable.

Server package for pi.

## CLI

```bash
server --help
```

## Pi Deck over Tailscale

Pi Deck is a mobile-first private web UI for supervising Pi tasks that continue to run on this PC. It binds only to `127.0.0.1`; do not expose the port with router forwarding or a public reverse proxy.

Start it from PowerShell with one or more explicitly allowed workspaces:

```powershell
server deck --port 31415 --workspace "C:\work\my-project" --workspace "C:\work\another-project"
```

The process prints a six-digit, single-use pairing code valid for ten minutes. On both the PC and phone, sign in to the same Tailscale tailnet, then publish the loopback service privately:

```powershell
tailscale serve --bg http://127.0.0.1:31415
tailscale serve status
```

Open the HTTPS URL reported by `tailscale serve status` on the phone. Direct UDP connectivity is optional: when a school network blocks it, Tailscale can fall back to an encrypted DERP relay without a public IP or router access. The PC must remain powered on, connected to Tailscale, and past any campus captive-portal login. Follow school network policy and use only equipment you are authorized to access.

To stop publishing the service:

```powershell
tailscale serve reset
```

Deck never accepts a path from the phone. New tasks can use only the `--workspace` allowlist. Browser device tokens are stored as SHA-256 hashes in `PI_SERVER_DIR\deck-devices.json` (or the default `~\.pi\server` directory), and paired devices can be listed and revoked through the authenticated API.

Deck task records and their Pi session references persist in `instances.json`. Finished, failed, stopped, and interrupted tasks remain visible until explicitly deleted. A restart marks tasks that had a live RPC process as interrupted and never replays their pending prompt. Continuing a task starts a new RPC process and restores only the session file already saved for that task, after its session ID and workspace header have been validated. Deleting a Deck task removes only its Deck record; the Pi session JSONL is retained.
