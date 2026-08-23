[CmdletBinding()]
param(
	[Parameter(Mandatory = $true)]
	[ValidateNotNullOrEmpty()]
	[string[]]$WorkspacePath,
	[string]$RepositoryPath,
	[string]$RuntimePath,
	[ValidateRange(1, 65535)]
	[int]$Port = 31415,
	[ValidateRange(1, 65535)]
	[int]$PiDeckPort = 8765
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $RepositoryPath) {
	$RepositoryPath = Join-Path $PSScriptRoot "..\.."
}
if (-not $RuntimePath) {
	$localAppData = [Environment]::GetFolderPath("LocalApplicationData")
	if (-not $localAppData) {
		throw "The LocalApplicationData directory could not be resolved. Pass -RuntimePath explicitly."
	}
	$RuntimePath = Join-Path $localAppData "PiDeckMobileGateway"
}

function Assert-NodeVersion {
	$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
	if (-not $nodeCommand) {
		throw "Node.js was not found. Run install.ps1 after installing Node.js 22.19.0 or newer."
	}
	$versionText = (& node --version).Trim().TrimStart("v")
	if ($LASTEXITCODE -ne 0) {
		throw "node --version failed with exit code $LASTEXITCODE."
	}
	$version = [version]$versionText
	if ($version -lt [version]"22.19.0") {
		throw "Node.js $version is too old. Version 22.19.0 or newer is required."
	}
	return $nodeCommand
}

function Test-LocalHttp {
	param([string]$Uri)
	try {
		$response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 3
		return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
	} catch {
		return $false
	}
}

$nodeCommand = Assert-NodeVersion
$resolvedRepository = (Resolve-Path -LiteralPath $RepositoryPath).Path
$gatewayCli = Join-Path $resolvedRepository "packages\server\dist\cli.js"
if (-not (Test-Path -LiteralPath $gatewayCli -PathType Leaf)) {
	throw "Gateway build output is missing: $gatewayCli. Run install.ps1 first."
}

$resolvedWorkspaces = @()
foreach ($candidate in $WorkspacePath) {
	$resolved = (Resolve-Path -LiteralPath $candidate).Path
	if (-not (Test-Path -LiteralPath $resolved -PathType Container)) {
		throw "Workspace is not a directory: $candidate"
	}
	$resolvedWorkspaces += $resolved
}

if (-not (Test-LocalHttp "http://127.0.0.1:$PiDeckPort/api/state")) {
	throw "Desktop PiDeck is not responding at http://127.0.0.1:$PiDeckPort/api/state. Start PiDeck and its Web service first."
}

$portOwner = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
if ($portOwner) {
	throw "Port $Port is already in use by process $($portOwner[0].OwningProcess)."
}

New-Item -ItemType Directory -Path $RuntimePath -Force | Out-Null
$resolvedRuntime = (Resolve-Path -LiteralPath $RuntimePath).Path
$pidPath = Join-Path $resolvedRuntime "gateway.pid"
$stdoutPath = Join-Path $resolvedRuntime "gateway.stdout.log"
$stderrPath = Join-Path $resolvedRuntime "gateway.stderr.log"

if (Test-Path -LiteralPath $pidPath) {
	$existingId = 0
	if ([int]::TryParse((Get-Content -LiteralPath $pidPath -Raw).Trim(), [ref]$existingId)) {
		$existingProcess = Get-Process -Id $existingId -ErrorAction SilentlyContinue
		if ($existingProcess) {
			throw "The PID file points to a running process ($existingId). Run stop-gateway.ps1 first."
		}
	}
	Remove-Item -LiteralPath $pidPath -Force
}

$argumentParts = @("`"$gatewayCli`"", "deck", "--port", "$Port")
foreach ($workspace in $resolvedWorkspaces) {
	$argumentParts += @("--workspace", "`"$workspace`"")
}
$argumentLine = $argumentParts -join " "

$gatewayProcess = Start-Process `
	-FilePath $nodeCommand.Source `
	-ArgumentList $argumentLine `
	-WorkingDirectory $resolvedRepository `
	-WindowStyle Hidden `
	-RedirectStandardOutput $stdoutPath `
	-RedirectStandardError $stderrPath `
	-PassThru

$gatewayProcess.Id | Set-Content -LiteralPath $pidPath -Encoding ascii

$healthy = $false
for ($attempt = 0; $attempt -lt 50; $attempt++) {
	Start-Sleep -Milliseconds 200
	if ($gatewayProcess.HasExited) {
		break
	}
	if (Test-LocalHttp "http://127.0.0.1:$Port/api/health") {
		$healthy = $true
		break
	}
}

if (-not $healthy) {
	if (-not $gatewayProcess.HasExited) {
		Stop-Process -Id $gatewayProcess.Id -Force
	}
	Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
	$stderr = if (Test-Path -LiteralPath $stderrPath) { Get-Content -LiteralPath $stderrPath -Raw } else { "" }
	throw "Gateway failed to become healthy. $stderr"
}

$pairingLine = Get-Content -LiteralPath $stdoutPath -ErrorAction SilentlyContinue |
	Where-Object { $_ -match "^Pairing code:" } |
	Select-Object -Last 1

Write-Host "Gateway started. PID: $($gatewayProcess.Id)"
Write-Host "Local URL: http://127.0.0.1:$Port/"
if ($pairingLine) {
	Write-Host $pairingLine
} else {
	Write-Host "Pairing code will appear in: $stdoutPath"
}
Write-Host "Runtime directory: $resolvedRuntime"
Write-Host "Next: run configure-tailscale.ps1 after logging in to Tailscale."
