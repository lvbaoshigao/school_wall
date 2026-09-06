@echo off
setlocal

set PORT=3000

REM Parse arguments
if "%~1"=="--port" set PORT=%~2
if "%~1"=="-p" set PORT=%~2

echo ========================================
echo    School Wall - Stop Service
echo ========================================
echo.

REM Check if port is in use
netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo No service running on port %PORT%
    pause
    exit /b 0
)

echo Found service on port %PORT%
echo.

REM Get PID and kill
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING"') do (
    echo Stopping process PID: %%a
    taskkill /F /PID %%a >nul 2>&1
)

echo.
echo Service stopped!
echo.
pause
