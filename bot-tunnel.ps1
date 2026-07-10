# Bot — tunnel keeper. Same idea as tunnel.ps1 (Echo), but a SECOND quick
# tunnel with its own separate URL, published to the Desktop as
# "Bot Public URL.txt" (link points straight at /bot). Echo's tunnel and URL
# are untouched — run both keepers side by side.
#
# Note: serve.ps1 skips starting Echo's tunnel if ANY cloudflared process is
# already running. Start Echo first (logon task does this), then the bot.
$ErrorActionPreference = "SilentlyContinue"
$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
            [Environment]::GetEnvironmentVariable("Path", "User")

$app = $PSScriptRoot
$cf = (Get-Command cloudflared).Source
$desktop = [Environment]::GetFolderPath("Desktop")
$tunLog = "$app\data\bot-tunnel.log"
New-Item -ItemType Directory -Force "$app\data" | Out-Null

while ($true) {
  Remove-Item $tunLog -ErrorAction SilentlyContinue
  $p = Start-Process -FilePath $cf `
    -ArgumentList "tunnel", "--url", "http://localhost:3000", "--no-autoupdate", "--protocol", "http2" `
    -WindowStyle Hidden -PassThru `
    -RedirectStandardError  $tunLog `
    -RedirectStandardOutput "$app\data\bot-tunnel.out.log"

  # Wait for the URL to appear, then publish it to the Desktop.
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    $log = Get-Content $tunLog -Raw -ErrorAction SilentlyContinue
    if ($log -match "https://[a-z0-9-]+\.trycloudflare\.com") {
      $url = $matches[0]
      Write-Host "Bot dashboard is LIVE at: $url/bot"
      $msg = @"
Your funding-rate arbitrage bot dashboard is LIVE at:

    $url/bot

This is a SEPARATE link from your Echo one — Echo keeps its own.
Log in with the username and password you set (same as Echo).

Note: this address can change when your PC restarts or the
connection drops. Re-open this file to get the current link.

(Dashboard is only reachable while this PC is on and awake.
 The bot ENGINE must also be running: npm run bot)
"@
      Set-Content -Path (Join-Path $desktop "Bot Public URL.txt") -Value $msg -Encoding UTF8
      break
    }
  }

  # Block until cloudflared exits, then loop to restart it.
  if ($p) { $p.WaitForExit() }
  Start-Sleep -Seconds 3
}
