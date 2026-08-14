@echo off
setlocal
cd /d "%~dp0"

rem ============================================
rem  BepInEx Manager - launcher
rem  First run: installs dependencies if needed
rem  Close this window to stop the app
rem ============================================

if not exist "node_modules\electron\dist\electron.exe" (
    echo [BepInEx Manager] First run: installing dependencies, please wait...
    call pnpm install
    if errorlevel 1 (
        echo [BepInEx Manager] Dependency install failed. Check network and retry.
        pause
        exit /b 1
    )
)

echo [BepInEx Manager] Starting...
call pnpm dev
if errorlevel 1 (
    echo [BepInEx Manager] Failed to start. See messages above.
)
pause
