@echo off
REM ============================================================
REM  Funding bot — ONE-TIME setup: auto-start at every logon.
REM  Double-click this file once. It registers a "FundingBot"
REM  scheduled task (same pattern as Echo's) that runs
REM  bot-serve.ps1 hidden: site + trading engine on port 3010,
REM  auto-restarting if they crash. Then it starts it right now.
REM
REM  Dashboard:  http://localhost:3010/bot   (on this PC)
REM              http://<this-PC's-IP>:3010/bot  (phone, same Wi-Fi)
REM
REM  To undo:    schtasks /Delete /TN "FundingBot" /F
REM ============================================================

cd /d "%~dp0"

echo Registering the FundingBot logon task...
schtasks /Create /TN "FundingBot" /SC ONLOGON /F ^
  /TR "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"%~dp0bot-serve.ps1\""
if errorlevel 1 (
  echo.
  echo Task creation failed. Right-click this file and "Run as administrator",
  echo or run the schtasks command above manually.
  pause
  exit /b 1
)

echo Starting it now (no reboot needed)...
schtasks /Run /TN "FundingBot"

echo.
echo ============================================================
echo  Done. The bot now starts by itself every time you log on,
echo  runs hidden (no windows), and restarts itself if it crashes.
echo.
echo  First start after an update builds the app - give it a few
echo  minutes, then open:  http://localhost:3010/bot
echo.
echo  Logs: data\bot-app.out.log / bot-app.err.log / bot-build.log
echo  To stop + remove:  schtasks /Delete /TN "FundingBot" /F
echo ============================================================
echo.
pause
