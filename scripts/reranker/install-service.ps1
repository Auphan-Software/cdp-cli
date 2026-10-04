param(
  [string]$Root = 'C:\ProgramData\cdp-reranker',
  [string]$BindAddress = '192.168.1.140',
  [string]$OfficeNetwork = '192.168.0.0/16'
)
$ErrorActionPreference = 'Stop'
$modelHash = '18f099b292864fde542713d7c41aa4464860e11bc07b045b51543e9e59e6e7e7'
if ((Get-FileHash -LiteralPath (Join-Path $Root 'reranker-q8.gguf') -Algorithm SHA256).Hash.ToLowerInvariant() -ne $modelHash) { throw 'Pinned model hash mismatch' }
foreach ($name in @('runtime\llama-server.exe','service.mjs','run-service.ps1','service.json')) {
  if (!(Test-Path -LiteralPath (Join-Path $Root $name))) { throw "Missing deployment file $name" }
}
$config = Get-Content -LiteralPath (Join-Path $Root 'service.json') -Raw | ConvertFrom-Json
if ($config.host -ne $BindAddress -or $config.port -ne 8125 -or $config.modelRevision -ne $modelHash) { throw 'Deployment config mismatch' }
$existing = Get-ScheduledTask -TaskName 'CDP-Reranker' -ErrorAction SilentlyContinue
if ($existing) { throw 'CDP-Reranker already registered; inspect and stop that exact task before an authorized upgrade' }
if (Get-NetTCPConnection -State Listen -LocalPort 8125,8126 -ErrorAction SilentlyContinue) { throw 'Reranker ports already occupied' }
New-NetFirewallRule -DisplayName 'CDP Reranker Office LAN' -Direction Inbound -Action Allow -Protocol TCP -LocalAddress $BindAddress -LocalPort 8125 -RemoteAddress $OfficeNetwork -Profile Any | Out-Null
$action = New-ScheduledTaskAction -Execute 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$(Join-Path $Root 'run-service.ps1')`" -Root `"$Root`"" -WorkingDirectory $Root
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName 'CDP-Reranker' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Idle-capacity Qwen classifier for owned CDP browser evidence; transcription has admission priority.' | Out-Null
Start-ScheduledTask -TaskName 'CDP-Reranker'
Get-ScheduledTask -TaskName 'CDP-Reranker' | Select-Object TaskName,State
