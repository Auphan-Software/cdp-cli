param(
  [string]$Url = 'http://192.168.1.140:8125',
  [string]$ConfigPath = "$env:ProgramData\cdp-cli\reranker.json",
  [switch]$UserCompatibility,
  [switch]$Replace
)
$ErrorActionPreference = 'Stop'
if (![IO.Path]::IsPathRooted($ConfigPath) -or $ConfigPath -match '^\\[^\\]') { throw 'Absolute shared configuration path required' }
$endpoint = [uri]$Url
if ($endpoint.Scheme -notin @('http','https') -or $endpoint.UserInfo) { throw 'HTTP(S) endpoint without credentials required' }
$model = '18f099b292864fde542713d7c41aa4464860e11bc07b045b51543e9e59e6e7e7'
$runtime = '11fe02151f79c41d0d4af7da708755d73b9c0da6'
$health = Invoke-RestMethod -Uri "$($endpoint.GetLeftPart([System.UriPartial]::Authority))/health" -TimeoutSec 5
if ($health.status -ne 'ok' -or $health.modelRevision -ne $model -or $health.runtimeRevision -ne $runtime) { throw 'Endpoint or pinned revisions mismatch' }
$config = @{ url=$Url; timeoutMs=2500; modelRevision=$model; runtimeRevision=$runtime } | ConvertTo-Json
$targets = @($ConfigPath)
# Run this option from an unpackaged managed client, never from Codex's redirected AppData.
if ($UserCompatibility) { $targets += Join-Path $env:LOCALAPPDATA 'cdp-cli\reranker.json' }
$writes = @()
foreach ($target in $targets) {
  if (![IO.Path]::IsPathRooted($target) -or $target -match '^\\[^\\]') { throw 'Absolute configuration path required' }
  if ((Test-Path -LiteralPath $target) -and !$Replace) {
    $prior = Get-Content -LiteralPath $target -Raw | ConvertFrom-Json
    if ($prior.url -ne $Url -or $prior.modelRevision -ne $model -or $prior.runtimeRevision -ne $runtime) {
      throw "Existing configuration at $target differs; inspect it before using -Replace"
    }
    Write-Output "Existing matching config: $target"
    continue
  }
  $writes += $target
}
foreach ($target in $writes) {
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($target))) | Out-Null
  if (Test-Path -LiteralPath $target) { Copy-Item -LiteralPath $target -Destination "$target.$([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffffff')).bak" }
  [IO.File]::WriteAllText($target, $config, [Text.UTF8Encoding]::new($false))
  Write-Output "Installed config: $target"
}
Write-Output 'Run cdp-cli reranker-status from each actual consumer; health alone does not prove ranking.'
