@echo off
setlocal
pushd "%~dp0" || goto :folder_error
set "ELECTRON_RUN_AS_NODE="
if not exist "node_modules\electron\dist\electron.exe" goto :runtime_error
if not exist "data\bo2-trainer" mkdir "data\bo2-trainer"
set "TRAINER_LAUNCH_LOG=%~dp0data\bo2-trainer\launch-%RANDOM%-%RANDOM%.log"
"%~dp0node_modules\electron\dist\electron.exe" "%~dp0desktop\trainer.cjs" > "%TRAINER_LAUNCH_LOG%" 2>&1
if errorlevel 1 goto :launch_error
if not exist "%TRAINER_LAUNCH_LOG%" goto :launch_error
popd
exit /b 0

:launch_error
echo The BO2 Zombies trainer could not start.
if exist "%TRAINER_LAUNCH_LOG%" type "%TRAINER_LAUNCH_LOG%"
echo.
echo Launch log: %TRAINER_LAUNCH_LOG%
pause
popd
exit /b 1

:runtime_error
echo The Electron runtime is missing from this copy of PS Neighborhood.
echo Run npm install in this folder, then open this launcher again.
pause
popd
exit /b 1

:folder_error
echo Cannot open the trainer folder: %~dp0
pause
exit /b 1
