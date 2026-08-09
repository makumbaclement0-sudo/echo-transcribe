@echo off
setlocal
REM ============================================================
REM  Echo — start the app AND a public Cloudflare tunnel.
REM  Double-click this file (or run it) to go live.
REM  Two windows open: the app, and the tunnel (shows your URL).
REM  Keep BOTH windows open. Close a window to stop that part.
REM ============================================================

REM ---- Port to serve on. Change this if the port is already in use. ----
set "PORT=4300"

cd /d "%~dp0"

echo Starting the Echo app server on port %PORT% ...
start "Echo App (keep open)" cmd /k "npm run dev -- -p %PORT%"

echo Waiting for the app to boot...
timeout /t 9 /nobreak >nul

echo Starting the public Cloudflare tunnel...
start "Echo Public URL (keep open)" cmd /k "cloudflared tunnel --url http://localhost:%PORT%"

echo.
echo ============================================================
echo  Two windows opened.
echo  Local:  http://localhost:%PORT%/funding
echo  Public: the https://...trycloudflare.com link appears in
echo          the "Echo Public URL" window — add /funding to it.
echo  Keep both windows open for the site to stay live.
echo ============================================================
echo.
pause
