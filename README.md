# Pi Deck Mobile Gateway

Pi Deck Mobile Gateway is a private, mobile-first web gateway for supervising
PiDeck tasks running on a Windows PC. The phone is a remote control and status
screen; all Pi work continues to execute on the PC.

The gateway listens only on `127.0.0.1` and is intended to be published to
devices in the same Tailscale tailnet with Tailscale Serve. It does not require
a public IP, router configuration, or a public server. On restricted networks,
Tailscale may use an encrypted DERP relay when a direct connection is not
available.

This repository is an unofficial downstream snapshot of the MIT-licensed Pi
monorepo. See [UPSTREAM.md](UPSTREAM.md) for attribution and scope.

## Features

- Mobile PWA for current, completed, failed, stopped, and historical PiDeck tasks
- Continue an existing PiDeck session from the phone
- Create tasks only in an explicit PC-side workspace allowlist
- One-time pairing code and persistent per-device authentication
- Loopback-only gateway with Host, Origin, and proxy header protections
- Tailscale Serve deployment without public exposure
- Compatibility handling for repeated prompts in PiDeck 0.7.0

## PiDeck 0.7.0 compatibility

PiDeck 0.7.0 reuses a session ID as the request ID in its `/api/chat` route.
Its runtime coordinator deduplicates that key, so a second prompt in the same
session can be recorded without being dispatched. This gateway avoids the
affected route: it opens the session stream and submits each prompt with a
unique request ID. It also handles an upstream stream that becomes quiet after
the assistant response is persisted but omits its terminal event.

The compatibility behavior is covered by regression tests in
`packages/server/test/deck.test.ts`.

## Requirements

- Windows 10 or Windows 11
- PiDeck 0.7.0 with its Web service available at `http://127.0.0.1:8765`
- Node.js 22.19.0 or newer
- Tailscale on the PC and phone, signed in to the same tailnet
- One or more local workspace directories that mobile-created tasks may use

Do not add inbound firewall rules for ports `8765` or `31415`.

## Install

Open PowerShell in the repository root:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\pideck-mobile\install.ps1
```

The installer runs `npm ci --ignore-scripts` and `npm run build:offline` to
build the complete monorepo from the committed lockfile and model-data snapshot.
Build output and dependencies are intentionally not committed.

## Start the gateway

Start PiDeck and its Web service first. Then pass every workspace that should
be available to mobile-created tasks:

```powershell
.\scripts\pideck-mobile\start-gateway.ps1 -WorkspacePath 'C:\work\project-a'
```

Multiple workspaces may be supplied:

```powershell
.\scripts\pideck-mobile\start-gateway.ps1 `
  -WorkspacePath 'C:\work\project-a','D:\work\project-b'
```

The script prints the local URL and a six-digit pairing code. The code is valid
for ten minutes and one use. Runtime logs and the PID file are written outside
the repository to `%LOCALAPPDATA%\PiDeckMobileGateway` by default.

## Publish privately with Tailscale

After signing in to Tailscale on the PC:

```powershell
.\scripts\pideck-mobile\configure-tailscale.ps1
.\scripts\pideck-mobile\health-check.ps1
```

Open the HTTPS `*.ts.net` URL printed by `tailscale serve status` on the phone.
Tailscale Serve is tailnet-only. Do not use Tailscale Funnel for this gateway.

On the first visit, enter the pairing code and a device name. In Android
Chrome, use **Install app** or **Add to Home screen**. Normal gateway restarts
do not require re-pairing. Clearing site data, changing browsers, revoking the
device, or deleting the gateway device store requires a new pairing code.

## Operate and diagnose

Check the local services and Serve mapping:

```powershell
.\scripts\pideck-mobile\health-check.ps1
```

Include the tailnet URL in the check when desired:

```powershell
.\scripts\pideck-mobile\health-check.ps1 `
  -TailnetUrl 'https://your-device.your-tailnet.ts.net/api/health'
```

Stop only the gateway process recorded by this deployment:

```powershell
.\scripts\pideck-mobile\stop-gateway.ps1
```

Stopping the gateway does not remove the persistent Serve configuration. To
remove it explicitly:

```powershell
tailscale serve reset
```

Common failures:

- `502`: Serve is configured but the local gateway is not running.
- `Cross-site request rejected`: open the Tailscale HTTPS URL directly; do not
  embed it in another site. Remove an obsolete installed PWA if necessary.
- Pairing code rejected: restart the gateway to issue a fresh code.
- Old UI after an update: close all tabs and the installed PWA, then reopen it
  so the service worker can update.

## Development

```powershell
npm ci --ignore-scripts
npm run check
npm run build:offline
Set-Location packages\server
node ..\..\node_modules\vitest\dist\cli.js --run test\deck.test.ts
```

`npm run build` refreshes provider model data from `models.dev` and therefore
requires external network access. It is not required to build this gateway.

The gateway must not be tested with real prompts unless the owner of those Pi
sessions explicitly authorizes it.

## License

MIT. See [LICENSE](LICENSE) and [UPSTREAM.md](UPSTREAM.md).
