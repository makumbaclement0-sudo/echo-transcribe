# Echo — tunnel keeper. Keeps a Cloudflare quick tunnel alive, restarting it
# if it drops (quick tunnels exit on any network blip). Writes the current
# public URL to the Desktop whenever it (re)connects. Runs forever.
$ErrorActionPreference = "SilentlyContinue"
$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
            [Environment]::GetEnvironmentVariable("Path", "User")

$app = "C:\Users\cleme\transcribe-app"
$cf = (Get-Command cloudflared).Source
$desktop = [Environment]::GetFolderPath("Desktop")
$tunLog = "$app\data\tunnel.log"

while ($true) {
  Remove-Item $tunLog -ErrorAction SilentlyContinue
  $p = Start-Process -FilePath $cf `
    -ArgumentList "tunnel", "--url", "http://localhost:3000", "--no-autoupdate", "--protocol", "http2" `
    -WindowStyle Hidden -PassThru `
    -RedirectStandardError  $tunLog `
    -RedirectStandardOutput "$app\data\tunnel.out.log"

  # Wait for the URL to appear, then publish it to the Desktop.
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    $log = Get-Content $tunLog -Raw -ErrorAction SilentlyContinue
    if ($log -match "https://[a-z0-9-]+\.trycloudflare\.com") {
      $url = $matches[0]
      $msg = @"
Your Echo transcription site is LIVE at:

    $url

Log in with the username and password you set.
Open or share that link from any device.

Note: this address can change when your PC restarts or the
connection drops. Re-open this file to get the current link.

(Site is only reachable while this PC is on and awake.)
"@
      Set-Content -Path (Join-Path $desktop "Echo Public URL.txt") -Value $msg -Encoding UTF8
      break
    }
  }

  # Block until cloudflared exits, then loop to restart it.
  if ($p) { $p.WaitForExit() }
  Start-Sleep -Seconds 3
}
