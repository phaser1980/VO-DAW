$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

$existingExe = Join-Path $PSScriptRoot "dist\StateVO.exe"
if (Test-Path -LiteralPath $existingExe) {
    $running = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $existingExe }
    if ($running) {
        throw "StateVO is currently open. Close it before rebuilding the executable."
    }
}

if (-not (Test-Path -LiteralPath ".venv\Scripts\python.exe")) {
    & "$PSScriptRoot\Setup-StateVO.ps1"
}

& .\.venv\Scripts\python.exe -m PyInstaller --noconfirm --clean packaging\statevo.spec
if ($LASTEXITCODE -ne 0) { throw "The StateVO executable build failed." }

Write-Host ""
Write-Host "Standalone app created at: $PSScriptRoot\dist\StateVO.exe" -ForegroundColor Green
