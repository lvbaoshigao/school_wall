@echo off
setlocal DisableDelayedExpansion
set "SW_PORT=3000"

:parse_args
if "%~1"=="" goto run
if /i "%~1"=="--port" goto read_port
if /i "%~1"=="-p" goto read_port
echo ERROR: Unknown argument. Usage: stop.bat [--port PORT]
exit /b 1

:read_port
if "%~2"=="" (
    echo ERROR: A port value is required.
    exit /b 1
)
set "SW_PORT=%~2"
shift
shift
goto parse_args

:run
echo School Wall - Stop
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\windows.ps1" -Mode Stop -Port "%SW_PORT%"
exit /b %ERRORLEVEL%
