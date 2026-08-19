# Releasing cdp-cli

This checklist is for maintainers. The Claude Code plugin documents how users
install `cdp-cli`; release construction and S3 publication are owned by this
repository.

## 1. Finalize and verify the release

Complete the version and changelog changes first, then commit and push them.
The executable embeds the current commit and dirty-tree state, so build it only
from the final clean release commit.

```powershell
Set-Location Q:\apps\cdp-cli
git status --short --branch
npm test
npm run test:coverage
npm run test:live
npm run test:live:headful
npm audit
npm run build:exe
.\bundle\cdp-cli.exe --version
```

The version output must identify the intended release commit. Do not publish an
executable stamped `dirty` or built from a different commit.

## 2. Publish the standalone executable

The installer always downloads the same public object:

<https://auphan-updates.s3.amazonaws.com/cdp-cli/cdp-cli.exe>

Upload `bundle\cdp-cli.exe` to that object with the saved WinSCP
`S3 versions` profile. The profile is stored in the maintainer's WinSCP INI and
must never be copied into this repository.

```powershell
$winScp = 'C:\Program Files (x86)\WinSCP\WinSCP.com'
$winScpIni = Join-Path $env:USERPROFILE 'OneDrive\Documents\WinSCP.ini'

& $winScp "/ini=$winScpIni" /command `
  'option batch abort' `
  'option confirm off' `
  'open S3%20versions' `
  'put Q:\apps\cdp-cli\bundle\cdp-cli.exe /auphan-updates/cdp-cli/cdp-cli.exe' `
  'exit'

if ($LASTEXITCODE -ne 0) {
  throw "WinSCP upload failed with exit code $LASTEXITCODE"
}
```

The destination replaces the current installer artifact. WinSCP must exit zero;
a build or release is not complete merely because the Git commit was pushed.

## 3. Verify the public artifact independently

Do not verify only with an S3 listing or HTTP `HEAD`. Download through the same
anonymous URL used by the installer, compare the full SHA-256 hash, and execute
the downloaded bytes. The cache-busting query prevents a stale intermediary
from producing a false result.

```powershell
$releaseExe = 'Q:\apps\cdp-cli\bundle\cdp-cli.exe'
$verifyExe = Join-Path $env:TEMP "cdp-cli-publish-verify-$([guid]::NewGuid().ToString('N')).exe"
$verifyUrl = "https://auphan-updates.s3.amazonaws.com/cdp-cli/cdp-cli.exe?verify=$([guid]::NewGuid())"

try {
  Invoke-WebRequest -Uri $verifyUrl -OutFile $verifyExe -UseBasicParsing `
    -Headers @{ 'Cache-Control' = 'no-cache' }

  $releaseHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $releaseExe).Hash
  $publicHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $verifyExe).Hash
  if ($releaseHash -ne $publicHash) {
    throw "Published executable hash mismatch: local=$releaseHash public=$publicHash"
  }

  & $verifyExe --version
} finally {
  Remove-Item -LiteralPath $verifyExe -Force -ErrorAction SilentlyContinue
}
```

The downloaded executable's version, build stamp, and commit must match the
local release. This proves that the public object is readable and contains the
intended bytes.

## 4. Verify installation resolution

Run the installer or `npm run install:exe`, then verify that Windows callers do
not resolve a stale executable:

```powershell
cdp-cli doctor
cdp-cli status
```

The callers reported by `doctor` must agree on the release commit. Record the
public SHA-256 hash in the release handoff.
