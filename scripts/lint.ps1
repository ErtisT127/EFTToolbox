$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'lint.mjs')
exit $LASTEXITCODE
