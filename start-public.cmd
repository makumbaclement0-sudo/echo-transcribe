@echo off
REM ============================================================
REM  Echo — start the app AND a public Cloudflare tunnel.
REM  Double-click this file (or run it) to go live.
REM  Two windows open: the app, and the tunnel (shows your URL).
REM  Keep BOTH windows open. Close a window to stop that part.
REM ============================================================

cd /d "%~dp0"

echo Starting the Echo app server...
start "Echo App (keep open)" cmd /k "npm run dev"

echo Waiting for the app to boot...
timeout /t 9 /nobreak >nul

echo Starting the public Cloudflare tunnel...
start "Echo Public URL (keep open)" cmd /k "cloudflared tunnel --url http://localhost:3000"

echo.
echo ============================================================
echo  Two windows opened.
echo  Your public https://...trycloudflare.com link appears in
echo  the "Echo Public URL" window. Share that link.
echo  Keep both windows open for the site to stay live.
echo ============================================================
echo.
pause
