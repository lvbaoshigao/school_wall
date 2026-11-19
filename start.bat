@echo off
setlocal DisableDelayedExpansion
echo School Wall - Development
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\windows.ps1" -Mode Dev -Port 3000
exit /b %ERRORLEVEL%
