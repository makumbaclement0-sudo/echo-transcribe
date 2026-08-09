# Remove the funding bot's autostart task.  Run:  .\autostart-remove.ps1
$ErrorActionPreference = "SilentlyContinue"
Stop-ScheduledTask -TaskName "EchoFundingBot"
Unregister-ScheduledTask -TaskName "EchoFundingBot" -Confirm:$false
Write-Host "Removed the EchoFundingBot autostart task."
Write-Host "(The app/tunnel it started keep running until you close them or log off.)"
