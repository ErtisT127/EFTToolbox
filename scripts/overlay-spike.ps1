param()
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Push-Location $root
$process = $null
try {
    dotnet build overlay/Overlay.csproj --nologo --verbosity quiet
    if ($LASTEXITCODE -ne 0) { throw 'Overlay build failed' }
    $exe = Join-Path $root 'build/dotnet/Overlay/bin/Debug/net10.0-windows/win-x64/overlay.exe'
    if (-not (Test-Path -LiteralPath $exe)) { throw "Overlay executable not found: $exe" }
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $exe
    $start.Arguments = '--dev-stdin'
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $false
    $process = [Diagnostics.Process]::Start($start)
    while (-not $process.WaitForExit(200)) { }
    if ($process.ExitCode -ne 0) { throw "Overlay exited with code $($process.ExitCode)" }
} finally {
    if ($null -ne $process) {
        if (-not $process.HasExited) {
            $process.StandardInput.Close()
            if (-not $process.WaitForExit(5000)) {
                $process.Kill()
                $process.WaitForExit()
            }
        }
        $process.Dispose()
    }
    Pop-Location
}
