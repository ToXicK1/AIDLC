# Launches AI-DLC Studio on Windows: checks prerequisites, installs
# dependencies and builds the client when needed, then starts the server and
# opens the browser.
#
#   .\start.ps1            # start (build if needed)
#   .\start.ps1 -Rebuild   # force a client rebuild first
#   .\start.ps1 -Port 4400 # use another port
#   .\start.ps1 -NoOpen    # do not open the browser

param(
  [int]$Port = 4317,
  [switch]$Rebuild,
  [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

function Require-Command([string]$Name, [string]$Hint) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    Write-Host "Missing prerequisite: $Name. $Hint" -ForegroundColor Red
    exit 1
  }
}

Require-Command 'node' 'Install Node.js 22.18 or later from https://nodejs.org'
Require-Command 'npm' 'It ships with Node.js.'
Require-Command 'bun' 'Install Bun from https://bun.sh (needed to build the client and to run the AI-DLC engine).'

$nodeVersion = [version]((node --version).TrimStart('v'))
if ($nodeVersion -lt [version]'22.18.0') {
  Write-Host "Node.js $nodeVersion is too old. AI-DLC Studio needs 22.18 or later." -ForegroundColor Red
  exit 1
}

if (-not (Test-Path -LiteralPath 'node_modules')) {
  Write-Host 'Installing dependencies...'
  npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$needsBuild = $Rebuild -or -not (Test-Path -LiteralPath 'dist\index.html')
if (-not $needsBuild) {
  $built = (Get-Item -LiteralPath 'dist\assets\main.js').LastWriteTimeUtc
  $newest = Get-ChildItem -LiteralPath 'web' -Recurse -File | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  if ($newest -and $newest.LastWriteTimeUtc -gt $built) { $needsBuild = $true }
}
if ($needsBuild) {
  Write-Host 'Building the client...'
  node scripts/build.mjs
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$env:AIDLC_STUDIO_PORT = "$Port"
if ($NoOpen) { node server/src/index.ts } else { node server/src/index.ts --open }
