@echo off
rem ============================================================
rem  AutoMark one-click launcher (Windows)
rem  Double-click this file: auto install deps -> start Electron.
rem ============================================================
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js 20+ first.
  pause
  exit /b 1
)

if not exist "launcher\node_modules\electron\dist\electron.exe" (
  echo First run: installing dependencies, please wait...
  call pnpm install
  if errorlevel 1 (
    echo [ERROR] Dependency install failed. Please install pnpm via: npm i -g pnpm
    pause
    exit /b 1
  )
  call pnpm approve-builds --all >nul 2>&1
)

echo Starting AutoMark...
start "" "%~dp0launcher\node_modules\electron\dist\electron.exe" "%~dp0launcher"
exit /b 0
