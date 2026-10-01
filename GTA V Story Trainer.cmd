@echo off
setlocal
set "ELECTRON_RUN_AS_NODE="
cd /d "%~dp0"
if not "%~1"=="" set "PSN_DATA=%~1"
"%~dp0node_modules\electron\dist\electron.exe" "%~dp0desktop\gta-story.cjs"
if errorlevel 1 pause
