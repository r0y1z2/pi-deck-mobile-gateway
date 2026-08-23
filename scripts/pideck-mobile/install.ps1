[CmdletBinding()]
param(
	[string]$RepositoryPath,
	[switch]$SkipBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $RepositoryPath) {
	$RepositoryPath = Join-Path $PSScriptRoot "..\.."
}

function Assert-LastExitCode {
	param([string]$Operation)
	if ($LASTEXITCODE -ne 0) {
		throw "$Operation failed with exit code $LASTEXITCODE."
	}
}

function Assert-NodeVersion {
	$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
	if (-not $nodeCommand) {
		throw "Node.js was not found. Install Node.js 22.19.0 or newer."
	}
	$versionText = (& node --version).Trim().TrimStart("v")
	Assert-LastExitCode "node --version"
	try {
		$version = [version]$versionText
	} catch {
		throw "Could not parse Node.js version '$versionText'."
	}
	if ($version -lt [version]"22.19.0") {
		throw "Node.js $version is too old. Version 22.19.0 or newer is required."
	}
	Write-Host "Node.js $version"
}

Assert-NodeVersion
$resolvedRepository = (Resolve-Path -LiteralPath $RepositoryPath).Path
if (-not (Test-Path -LiteralPath (Join-Path $resolvedRepository "package-lock.json") -PathType Leaf)) {
	throw "package-lock.json was not found in '$resolvedRepository'."
}

Push-Location $resolvedRepository
try {
	Write-Host "Installing locked dependencies without lifecycle scripts..."
	& npm.cmd ci --ignore-scripts
	Assert-LastExitCode "npm ci --ignore-scripts"

	if (-not $SkipBuild) {
		Write-Host "Building the workspace from committed model data..."
		& npm.cmd run build:offline
		Assert-LastExitCode "npm run build:offline"
	}
} finally {
	Pop-Location
}

$gatewayCli = Join-Path $resolvedRepository "packages\server\dist\cli.js"
if (-not (Test-Path -LiteralPath $gatewayCli -PathType Leaf)) {
	throw "Gateway build output is missing: $gatewayCli"
}

Write-Host "Installation completed."
