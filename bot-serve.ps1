# Funding bot — server keeper. Same pattern as serve.ps1 (Echo): run by the
# "FundingBot" logon scheduled task (see install-bot-autostart.cmd), builds
# the production bundle when needed, starts the site WITH the embedded
# trading engine (BOT_AUTOSTART) on port 3010, and restarts it if it drops.
# Calls node directly so PowerShell's script execution policy never matters.
$ErrorActionPreference = "SilentlyContinue"
$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
            [Environment]::GetEnvironmentVariable("Path", "User")

$app = $PSScriptRoot
Set-Location $app
New-Item -ItemType Directory -Force "$app\data" | Out-Null

$node = (Get-Command node).Source
$nextBin = "$app\node_modules\next\dist\bin\next"
$port = 3010

# --- Already running? (manual window or an earlier task run) ---
try {
  Invoke-WebRequest "http://localhost:$port/api/health" -UseBasicParsing -TimeoutSec 3 | Out-Null
  exit 0
} catch {}

# --- Build the production bundle if missing or older than the last commit ---
$buildId = "$app\.next\BUILD_ID"
$needBuild = -not (Test-Path $buildId)
if (-not $needBuild) {
  $lastCommit = [DateTime](& git -C $app log -1 --format=%cI)
  if ($lastCommit -and (Get-Item $buildId).LastWriteTime -lt $lastCommit) { $needBuild = $true }
}
if ($needBuild) {
  & $node $nextBin build *> "$app\data\bot-build.log"
}

# --- Keeper loop: run the server (site + engine), restart if it exits ---
$env:BOT_AUTOSTART = "true"
while ($true) {
  $p = Start-Process -FilePath $node `
    -ArgumentList $nextBin, "start", "-p", "$port", "-H", "0.0.0.0" `
    -WorkingDirectory $app -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput "$app\data\bot-app.out.log" `
    -RedirectStandardError  "$app\data\bot-app.err.log"
  if ($p) { $p.WaitForExit() }
  Start-Sleep -Seconds 5
}
