[CmdletBinding()]
param(
	[ValidateRange(1, 65535)]
	[int]$PiDeckPort = 8765,
	[ValidateRange(1, 65535)]
	[int]$GatewayPort = 31415,
	[string]$TailnetUrl
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$failures = [System.Collections.Generic.List[string]]::new()

[Net.ServicePointManager]::SecurityProtocol =
	[Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Test-HttpEndpoint {
	param(
		[string]$Name,
		[string]$Uri
	)
	try {
		$response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 10
		if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) {
			Write-Host "[OK] $Name - HTTP $($response.StatusCode)"
			return
		}
		$failures.Add("$Name returned HTTP $($response.StatusCode)")
	} catch {
		$failures.Add("$Name failed: $($_.Exception.Message)")
	}
}

function Find-TailscaleCommand {
	$command = Get-Command tailscale -ErrorAction SilentlyContinue
	if ($command) {
		return $command.Source
	}
	$candidate = Join-Path $env:ProgramFiles "Tailscale\tailscale.exe"
	if (Test-Path -LiteralPath $candidate -PathType Leaf) {
		return $candidate
	}
	return $null
}

Test-HttpEndpoint "Desktop PiDeck" "http://127.0.0.1:$PiDeckPort/api/state"
Test-HttpEndpoint "Gateway health" "http://127.0.0.1:$GatewayPort/api/health"

$tailscaleCommand = Find-TailscaleCommand
if (-not $tailscaleCommand) {
	$failures.Add("Tailscale CLI was not found")
} else {
	$serveStatus = (& $tailscaleCommand serve status 2>&1 | Out-String).Trim()
	if ($LASTEXITCODE -ne 0) {
		$failures.Add("tailscale serve status failed")
	} elseif ($serveStatus -notmatch [regex]::Escape("proxy http://127.0.0.1:$GatewayPort")) {
		$failures.Add("Tailscale Serve is not proxying to http://127.0.0.1:$GatewayPort")
	} else {
		Write-Host "[OK] Tailscale Serve targets gateway port $GatewayPort"
		Write-Host $serveStatus
	}
}

if ($TailnetUrl) {
	$tailnetUri = [uri]$TailnetUrl
	if ($tailnetUri.Scheme -ne "https") {
		throw "TailnetUrl must use HTTPS."
	}
	Test-HttpEndpoint "Tailnet URL" $tailnetUri.AbsoluteUri
}

if ($failures.Count -gt 0) {
	foreach ($failure in $failures) {
		Write-Error "[FAIL] $failure"
	}
	exit 1
}

Write-Host "All requested health checks passed."
