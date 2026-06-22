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

# --- Start the tunnel keeper (unless cloudflared is already running) ---
# tunnel.ps1 keeps the Cloudflare tunnel alive (auto-restarts on drops) and
# writes the current public URL to the Desktop.
if (-not (Get-Process cloudflared -ErrorAction SilentlyContinue)) {
  Start-Process -FilePath "powershell.exe" `
    -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", "$app\tunnel.ps1" `
    -WorkingDirectory $app -WindowStyle Hidden
}
