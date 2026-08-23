[CmdletBinding()]
param(
	[ValidateRange(1, 65535)]
	[int]$GatewayPort = 31415
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Find-TailscaleCommand {
	$command = Get-Command tailscale -ErrorAction SilentlyContinue
	if ($command) {
		return $command.Source
	}
	$candidate = Join-Path $env:ProgramFiles "Tailscale\tailscale.exe"
	if (Test-Path -LiteralPath $candidate -PathType Leaf) {
		return $candidate
	}
	throw "Tailscale CLI was not found. Install Tailscale and log in first."
}

$tailscaleCommand = Find-TailscaleCommand

try {
	$response = Invoke-WebRequest -Uri "http://127.0.0.1:$GatewayPort/api/health" -UseBasicParsing -TimeoutSec 5
	if ($response.StatusCode -ne 200) {
		throw "Unexpected HTTP status $($response.StatusCode)."
	}
} catch {
	throw "Gateway is not healthy on port $GatewayPort. Run start-gateway.ps1 first. $($_.Exception.Message)"
}

Write-Host "Configuring tailnet-only Tailscale Serve for http://127.0.0.1:$GatewayPort ..."
& $tailscaleCommand serve --bg "http://127.0.0.1:$GatewayPort"
if ($LASTEXITCODE -ne 0) {
	throw "tailscale serve failed with exit code $LASTEXITCODE."
}

& $tailscaleCommand serve status
if ($LASTEXITCODE -ne 0) {
	throw "Tailscale Serve was configured, but its status could not be read."
}

Write-Host "Open the HTTPS tailnet URL shown above on the phone. Do not enable Funnel."
