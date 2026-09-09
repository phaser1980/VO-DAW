@echo off
setlocal
cd /d "%~dp0"

if exist "dist\StateVO.exe" (
    start "StateVO" "dist\StateVO.exe"
    exit /b 0
)

if not exist ".venv\Scripts\pythonw.exe" (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup-StateVO.ps1"
    if errorlevel 1 (
        echo.
        echo StateVO setup failed. Review the message above.
        pause
        exit /b 1
    )
)

start "StateVO" ".venv\Scripts\pythonw.exe" -m statevo.app
