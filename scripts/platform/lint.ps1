$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot '..\commands\lint.mjs')
exit $LASTEXITCODE
