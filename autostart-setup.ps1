# Register a Windows scheduled task so the funding bot starts automatically
# at logon and survives PC restarts. Run once:  .\autostart-setup.ps1
# Undo with:  .\autostart-remove.ps1
$ErrorActionPreference = "Stop"

$app = $PSScriptRoot
$script = Join-Path $app "serve-bot.ps1"
$taskName = "EchoFundingBot"

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME `
  -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force | Out-Null

Write-Host "Registered '$taskName' — the bot now starts automatically every time you log in,"
Write-Host "including after a restart. Positions and settings persist in the data\ folder."
Write-Host ""
Write-Host "Start it right now (no reboot needed):"
Write-Host "    Start-ScheduledTask -TaskName $taskName"
Write-Host ""
Write-Host "Turn the auto-trader on from the /trade page, or set AUTO_TRADE=true in .env.local."
Write-Host "Remove autostart later with:  .\autostart-remove.ps1"
