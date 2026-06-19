# Echo — start the production app + a public Cloudflare tunnel.
# Run automatically at logon by the "EchoTranscribe" scheduled task.
# Writes the current public URL to a file on the Desktop.
$ErrorActionPreference = "SilentlyContinue"
$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
            [Environment]::GetEnvironmentVariable("Path", "User")

$app = "C:\Users\cleme\transcribe-app"
Set-Location $app
New-Item -ItemType Directory -Force "$app\data" | Out-Null

$node = (Get-Command node).Source
$cf = (Get-Command cloudflared).Source

# --- Start the production Next.js server (if not already up) ---
$up = $false
try { Invoke-WebRequest "http://localhost:3000" -UseBasicParsing -TimeoutSec 3 | Out-Null; $up = $true } catch {}
if (-not $up) {
  Start-Process -FilePath $node `
    -ArgumentList "node_modules\next\dist\bin\next", "start", "-p", "3000", "-H", "0.0.0.0" `
    -WorkingDirectory $app -WindowStyle Hidden `
    -RedirectStandardOutput "$app\data\app.out.log" `
    -RedirectStandardError  "$app\data\app.err.log"
}

# Wait for the app to answer.
for ($i = 0; $i -lt 60; $i++) {
  try { Invoke-WebRequest "http://localhost:3000" -UseBasicParsing -TimeoutSec 3 | Out-Null; break }
  catch { Start-Sleep -Seconds 2 }
}

# --- Start the Cloudflare quick tunnel (unless one is already running) ---
$tunLog = "$app\data\tunnel.log"
if (-not (Get-Process cloudflared -ErrorAction SilentlyContinue)) {
  Remove-Item $tunLog -ErrorAction SilentlyContinue
  Start-Process -FilePath $cf `
    -ArgumentList "tunnel", "--url", "http://localhost:3000", "--no-autoupdate" `
    -WorkingDirectory $app -WindowStyle Hidden `
    -RedirectStandardError  $tunLog `
    -RedirectStandardOutput "$app\data\tunnel.out.log"
}

# --- Capture the public URL and drop it on the Desktop ---
$desktop = [Environment]::GetFolderPath("Desktop")
$url = $null
for ($i = 0; $i -lt 45; $i++) {
  Start-Sleep -Seconds 1
  $log = Get-Content $tunLog -Raw -ErrorAction SilentlyContinue
  if ($log -match "https://[a-z0-9-]+\.trycloudflare\.com") { $url = $matches[0]; break }
}
if ($url) {
  $msg = @"
Your Echo transcription site is LIVE at:

    $url

Open or share that link from any device.

Note: this address changes every time your PC restarts.
After a reboot, re-open this file to get the new link.

(Site is only reachable while this PC is on and awake.)
"@
  Set-Content -Path (Join-Path $desktop "Echo Public URL.txt") -Value $msg -Encoding UTF8
}
