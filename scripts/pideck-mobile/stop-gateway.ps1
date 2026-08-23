[CmdletBinding()]
param(
	[string]$RepositoryPath,
	[string]$RuntimePath,
	[ValidateRange(1, 65535)]
	[int]$Port = 31415
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

$pidPath = Join-Path $RuntimePath "gateway.pid"
if (-not (Test-Path -LiteralPath $pidPath -PathType Leaf)) {
	Write-Host "Gateway PID file was not found. Nothing was stopped."
	exit 0
}

$gatewayProcessId = 0
$pidText = (Get-Content -LiteralPath $pidPath -Raw).Trim()
if (-not [int]::TryParse($pidText, [ref]$gatewayProcessId)) {
	throw "Gateway PID file is invalid: $pidPath"
}

$process = Get-CimInstance Win32_Process -Filter "ProcessId = $gatewayProcessId" -ErrorAction SilentlyContinue
if (-not $process) {
	Remove-Item -LiteralPath $pidPath -Force
	Write-Host "Removed a stale PID file. Gateway was not running."
	exit 0
}

$resolvedRepository = (Resolve-Path -LiteralPath $RepositoryPath).Path
$gatewayCli = Join-Path $resolvedRepository "packages\server\dist\cli.js"
$expectedCli = [regex]::Escape($gatewayCli)
$expectedPort = "--port $Port"
if (
	$process.Name -notmatch "^node(\.exe)?$" -or
	$process.CommandLine -notmatch $expectedCli -or
	$process.CommandLine -notlike "*$expectedPort*"
) {
	throw "PID $gatewayProcessId does not look like this Pi Deck gateway. It was not stopped."
}

Stop-Process -Id $gatewayProcessId
for ($attempt = 0; $attempt -lt 100; $attempt++) {
	if (-not (Get-CimInstance Win32_Process -Filter "ProcessId = $gatewayProcessId" -ErrorAction SilentlyContinue)) {
		Remove-Item -LiteralPath $pidPath -Force
		Write-Host "Gateway process $gatewayProcessId stopped."
		exit 0
	}
	Start-Sleep -Milliseconds 100
}

throw "Gateway process $gatewayProcessId did not stop within 10 seconds."
