@echo off
REM ============================================================
REM  Funding-rate arbitrage bot — start the ENGINE and a public
REM  tunnel with its OWN URL (separate from Echo's).
REM  Double-click this file to go live.
REM
REM  Two windows open:
REM    1. Bot Engine  — the trading loop (paper mode by default)
REM    2. Bot Tunnel  — keeps the public link alive; the link is
REM       written to your Desktop as "Bot Public URL.txt"
REM  Keep BOTH windows open. The website itself must also be
REM  running (your normal Echo app / start-public.cmd covers it).
REM ============================================================

cd /d "%~dp0"

echo Starting the bot engine (paper mode unless LIVE_TRADING=true)...
start "Bot Engine (keep open)" cmd /k "npm run bot"

echo Starting the bot's own public tunnel...
start "Bot Tunnel (keep open)" powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0bot-tunnel.ps1"

echo.
echo ============================================================
echo  Two windows opened.
echo  Your bot link appears in the "Bot Tunnel" window and is
echo  saved to your Desktop as "Bot Public URL.txt".
echo  It ends in /bot and is DIFFERENT from your Echo link.
echo ============================================================
echo.
pause
