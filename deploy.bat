@echo off
setlocal enabledelayedexpansion

set PORT=3000

REM Parse arguments
:parse_args
if "%~1"=="" goto :start
if "%~1"=="--port" (
    set PORT=%~2
    shift
    shift
    goto :parse_args
)
if "%~1"=="-p" (
    set PORT=%~2
    shift
    shift
    goto :parse_args
)
shift
goto :parse_args

:start
echo ========================================
echo    School Wall - Deploy Tool
echo ========================================
echo.

REM Check Node.js
echo [1/5] Checking Node.js...
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Node.js not found
    echo Please install Node.js 18+ from https://nodejs.org
    pause
    exit /b 1
)
echo OK: Node.js found

REM Install server dependencies
echo.
echo [2/5] Installing server dependencies...
if exist "%~dp0server\node_modules" (
    echo OK: Server dependencies exist, skipping
) else (
    cd /d "%~dp0server"
    call npm install --production
    if %ERRORLEVEL% NEQ 0 (
        echo ERROR: Failed to install server dependencies
        pause
        exit /b 1
    )
    echo OK: Server dependencies installed
)

REM Install client dependencies
echo.
echo [3/5] Installing client dependencies...
if exist "%~dp0client\node_modules" (
    echo OK: Client dependencies exist, skipping
) else (
    cd /d "%~dp0client"
    call npm install
    if %ERRORLEVEL% NEQ 0 (
        echo ERROR: Failed to install client dependencies
        pause
        exit /b 1
    )
    echo OK: Client dependencies installed
)

REM Build frontend
echo.
echo [4/5] Building frontend...
cd /d "%~dp0client"
call npm run build
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Frontend build failed
    pause
    exit /b 1
)
if not exist "%~dp0client\dist" (
    echo ERROR: Build output not found
    pause
    exit /b 1
)
echo OK: Frontend built

REM Check if port is in use
echo.
echo [5/5] Starting server...
netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo WARNING: Port %PORT% is already in use
    echo Please stop the existing server first or use a different port
    echo.
    echo To stop existing server: taskkill /F /IM node.exe
    echo To use different port: deploy.bat --port 8080
    pause
    exit /b 1
)

REM Start server
cd /d "%~dp0server"
set PORT=%PORT%
start "School Wall" cmd /k "set PORT=%PORT% && node index.js"
echo OK: Server started

timeout /t 3 /nobreak >nul

REM Verify server is running
netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo WARNING: Server may not have started correctly
    echo Check the server window for errors
)

REM Output info
echo.
echo ========================================
echo    Deploy Complete!
echo ========================================
echo.
echo URLs:
echo   Frontend:  http://localhost:%PORT%
echo   API:       http://localhost:%PORT%/api
echo   Dashboard: http://localhost:%PORT%/dashboard
echo.
echo Admin Account:
echo   Username: admin
echo   Password: 123456
echo.
echo Port: %PORT%
echo.
echo Server is running in a new window.
echo Close that window to stop the server.
echo.
echo To use custom port: deploy.bat --port 8080
echo.
pause
