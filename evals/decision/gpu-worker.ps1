param(
  [ValidateSet('Start','Snapshot','Stop')][string]$Operation = 'Start',
  [ValidateSet('reranker','minicpm','qwen-vl')][string]$Model = 'reranker',
  [string]$Root = (Join-Path $env:LOCALAPPDATA 'cdp-cli-eval'),
  [int]$Port = 8125
)
$ErrorActionPreference = 'Stop'
$serverExe = Join-Path $Root 'llama.cpp\build-cuda\bin\Release\llama-server.exe'
$recordPath = Join-Path $Root 'gpu-worker.json'
if ($Operation -eq 'Start') {
  if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { throw 'Benchmark port already has a listener' }
  $modelFile = switch ($Model) { 'reranker' {'reranker-q8.gguf'} 'minicpm' {'minicpm-q4.gguf'} 'qwen-vl' {'qwen-vl-q4.gguf'} }
  $serverArgs = @('-m', ('"'+(Join-Path $Root "models\$modelFile")+'"'), '--host','127.0.0.1','--port',"$Port",'-ngl','999','-c','8192','-t','4','-b','2048','-ub','512','-np','1','-lv','4')
  if ($Model -eq 'reranker') { $serverArgs += @('--embedding','--pooling','rank','--rerank') }
  else {
    $projector = if ($Model -eq 'minicpm') {'minicpm-mmproj.gguf'} else {'qwen-vl-mmproj.gguf'}
    $serverArgs += @('--mmproj', ('"'+(Join-Path $Root "models\$projector")+'"'))
    if ($Model -eq 'minicpm') { $serverArgs += @('--reasoning','off') }
  }
  $log = Join-Path $Root "gpu-$Model.log"
  $outLog = Join-Path $Root "gpu-$Model.stdout.log"
  $oldPath = $env:PATH
  try {
    $env:PATH = 'C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.8\bin;'+$env:PATH
    $startup = [Diagnostics.Stopwatch]::StartNew()
    $worker = Start-Process -FilePath $serverExe -ArgumentList $serverArgs -WindowStyle Hidden -RedirectStandardError $log -RedirectStandardOutput $outLog -PassThru
  } finally { $env:PATH = $oldPath }
  $ready = $false
  for ($attempt=0;$attempt -lt 150;$attempt++) {
    if ($worker.HasExited) { throw "GPU worker exited; inspect $log" }
    try { $health=Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 1; if ($health.status -eq 'ok') {$ready=$true;break} } catch {}
    Start-Sleep -Milliseconds 200
  }
  if (!$ready) { Stop-Process -Id $worker.Id; throw 'GPU worker readiness deadline exceeded' }
  $startup.Stop()
  $proof = Get-Content -LiteralPath $log | Select-String -Pattern 'CUDA|offloaded|offloading|buffer size|using.*GPU' | ForEach-Object {$_.Line}
  if (!($proof -match 'offloaded.*layers')) { Stop-Process -Id $worker.Id; throw 'GPU layer offload proof missing' }
  $record = @{model=$Model;pid=$worker.Id;executable=$serverExe;port=$Port;startupMs=$startup.Elapsed.TotalMilliseconds;args=$serverArgs;offloadProof=$proof;gpu=(& nvidia-smi --query-gpu=name,memory.total,memory.used,temperature.gpu,power.draw,utilization.gpu --format=csv,noheader);workingSetBytes=$worker.WorkingSet64;peakWorkingSetBytes=$worker.PeakWorkingSet64}
  $record | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $recordPath
  $record | ConvertTo-Json -Depth 5
} else {
  $record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
  $worker = Get-Process -Id $record.pid -ErrorAction Stop
  if ($worker.Path -ne $record.executable -or $worker.Path -ne $serverExe) { throw 'Worker identity mismatch' }
  $record | Add-Member -Force -NotePropertyName workingSetBytes -NotePropertyValue $worker.WorkingSet64
  $record | Add-Member -Force -NotePropertyName peakWorkingSetBytes -NotePropertyValue $worker.PeakWorkingSet64
  $record | Add-Member -Force -NotePropertyName gpu -NotePropertyValue (& nvidia-smi --query-gpu=name,memory.total,memory.used,temperature.gpu,power.draw,utilization.gpu --format=csv,noheader)
  $record | ConvertTo-Json -Depth 5
  if ($Operation -eq 'Stop') { Stop-Process -Id $worker.Id }
}
