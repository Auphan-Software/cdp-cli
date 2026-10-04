param([string]$Root = 'C:\ProgramData\cdp-reranker')
$ErrorActionPreference = 'Stop'
$env:PATH = (Join-Path $Root 'runtime') + ';' + $env:PATH
Set-Location -LiteralPath $Root
& 'C:\Program Files\nodejs\node.exe' (Join-Path $Root 'service.mjs') (Join-Path $Root 'service.json') *>> (Join-Path $Root 'service.log')
exit $LASTEXITCODE
