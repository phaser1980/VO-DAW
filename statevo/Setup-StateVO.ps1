$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

$pythonLauncher = Get-Command py -ErrorAction SilentlyContinue
if (-not $pythonLauncher) {
    throw "Python's 'py' launcher was not found. Install Python 3.12 from python.org, then run this again."
}

& py -3.12 -c "import sys; assert sys.version_info[:2] == (3, 12)"
if ($LASTEXITCODE -ne 0) {
    throw "Python 3.12 is required. Install it from python.org, including the Python launcher."
}

if (-not (Test-Path -LiteralPath ".venv\Scripts\python.exe")) {
    & py -3.12 -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw "Could not create StateVO's Python environment." }
}

& .\.venv\Scripts\python.exe -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { throw "Could not update pip." }

& .\.venv\Scripts\python.exe -m pip install -e ".[dev,noise]"
if ($LASTEXITCODE -ne 0) { throw "Could not install StateVO's dependencies." }

& .\.venv\Scripts\python.exe -m pytest -q
if ($LASTEXITCODE -ne 0) { throw "StateVO installed, but its self-tests failed." }

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Warning "FFmpeg is not on PATH. Clean WAV export works, but AAC export needs FFmpeg. Run: winget install Gyan.FFmpeg"
}

Write-Host ""
Write-Host "StateVO is ready. Double-click Start-StateVO.cmd to launch it." -ForegroundColor Green
