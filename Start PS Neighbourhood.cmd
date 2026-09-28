@echo off
setlocal
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="
if not exist "node_modules\electron\dist\electron.exe" (
  echo Run npm ci first. See README.md for setup instructions.
  pause
  exit /b 1
)
start "PS Neighbourhood" "node_modules\electron\dist\electron.exe" . %*
