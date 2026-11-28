@echo off
setlocal DisableDelayedExpansion
set "SW_PORT=3000"
set "SW_CLIENT_PORT=5173"
set "SW_BACKEND_ONLY="
set "SW_SKIP_INSTALL="

:parse_args
if "%~1"=="" goto run
if /i "%~1"=="--port" goto read_port
if /i "%~1"=="-p" goto read_port
if /i "%~1"=="--client-port" goto read_client_port
if /i "%~1"=="--backend-only" goto backend_only
if /i "%~1"=="--api-only" goto backend_only
if /i "%~1"=="--skip-install" goto skip_install
echo ERROR: Unknown argument. Usage: start.bat [--port PORT] [--client-port PORT] [--backend-only] [--skip-install]
exit /b 1

:read_port
if "%~2"=="" (
    echo ERROR: A backend port value is required.
    exit /b 1
)
set "SW_PORT=%~2"
shift /1
shift /1
goto parse_args

:read_client_port
if "%~2"=="" (
    echo ERROR: A frontend port value is required.
    exit /b 1
)
set "SW_CLIENT_PORT=%~2"
shift /1
shift /1
goto parse_args

:backend_only
set "SW_BACKEND_ONLY=-BackendOnly"
shift /1
goto parse_args

:skip_install
set "SW_SKIP_INSTALL=-SkipInstall"
shift /1
goto parse_args

:run
echo School Wall - Development
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\windows.ps1" -Mode Dev -Port "%SW_PORT%" -ClientPort "%SW_CLIENT_PORT%" %SW_BACKEND_ONLY% %SW_SKIP_INSTALL%
exit /b %ERRORLEVEL%
