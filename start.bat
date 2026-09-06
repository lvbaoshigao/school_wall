@echo off
echo ========================================
echo    School Wall - Dev Start
echo ========================================
echo.

echo [1/2] Starting backend (port 3000)...
cd /d "%~dp0server"
start "Wall-Backend" cmd /k "node index.js"
timeout /t 2 /nobreak >nul

echo [2/2] Starting frontend (port 5173)...
cd /d "%~dp0client"
start "Wall-Frontend" cmd /k "npm run dev"
timeout /t 3 /nobreak >nul

echo.
echo ========================================
echo    Done!
echo    Frontend:  http://localhost:5173
echo    Backend:   http://localhost:3000
echo    Dashboard: http://localhost:3000/dashboard
echo    Admin:     admin / 123456
echo ========================================
echo.
echo Press any key to open browser...
pause >nul
start http://localhost:5173
