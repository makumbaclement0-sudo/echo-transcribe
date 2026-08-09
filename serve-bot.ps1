# Echo Funding Bot — start the app + public tunnel and keep them alive.
# Runs from its own folder (portable), so it works wherever you cloned the repo.
# Launched automatically at logon by the EchoFundingBot scheduled task
# (see autostart-setup.ps1). Safe to run by hand too:  .\serve-bot.ps1
$ErrorActionPreference = "SilentlyContinue"
$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
            [Environment]::GetEnvironmentVariable("Path", "User")

$app = $PSScriptRoot
Set-Location $app
$port = if ($env:BOT_PORT) { $env:BOT_PORT } else { "4300" }
New-Item -ItemType Directory -Force "$app\data" | Out-Null

function AppUp {
  try { Invoke-WebRequest "http://localhost:$port" -UseBasicParsing -TimeoutSec 3 | Out-Null; return $true }
  catch { return $false }
}

function StartApp {
  Start-Process -FilePath "cmd.exe" `
    -ArgumentList "/c", "npm run dev -- -p $port" `
    -WorkingDirectory $app -WindowStyle Hidden
}

# --- Start the app ---
if (-not (AppUp)) { StartApp }
for ($i = 0; $i -lt 60; $i++) { if (AppUp) { break }; Start-Sleep 2 }

# --- Start a Cloudflare quick tunnel (if cloudflared is installed) and write
#     the public URL to the Desktop so you can open/share it from any device. ---
if (Get-Command cloudflared -ErrorAction SilentlyContinue) {
  if (-not (Get-Process cloudflared -ErrorAction SilentlyContinue)) {
    $tunLog = "$app\data\tunnel.log"
    Remove-Item $tunLog -ErrorAction SilentlyContinue
    Start-Process -FilePath (Get-Command cloudflared).Source `
      -ArgumentList "tunnel", "--url", "http://localhost:$port", "--no-autoupdate" `
      -WindowStyle Hidden -RedirectStandardError $tunLog `
      -RedirectStandardOutput "$app\data\tunnel.out.log"
    $desktop = [Environment]::GetFolderPath("Desktop")
    for ($i = 0; $i -lt 30; $i++) {
      Start-Sleep 1
      $log = Get-Content $tunLog -Raw -ErrorAction SilentlyContinue
      if ($log -match "https://[a-z0-9-]+\.trycloudflare\.com") {
        Set-Content -Path (Join-Path $desktop "Funding Bot URL.txt") `
          -Value "Funding bot is live at:`r`n`r`n    $($matches[0])/trade`r`n`r`nScanner: $($matches[0])/funding" `
          -Encoding UTF8
        break
      }
    }
  }
}

Write-Host "Funding bot running on http://localhost:$port/trade  (auto-trader resumes if it was left on)."

# --- Keep alive: relaunch the app if it ever stops. This loop keeps the
#     scheduled task running, so the whole thing stays up until you log off. ---
while ($true) {
  if (-not (AppUp)) { StartApp }
  Start-Sleep 30
}
