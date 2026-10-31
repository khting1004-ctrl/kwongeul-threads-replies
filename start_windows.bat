@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Threads Event Reply v1.4.1

echo ========================================
echo Threads Event Reply - Windows v1.4.1
echo ========================================

if not exist "server.js" goto missing_files
if not exist "lib\store.js" goto missing_files
if not exist "public\index.html" goto missing_files
where node.exe >nul 2>nul
if errorlevel 1 goto missing_node
node --version

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup_windows.ps1"
if errorlevel 1 goto setup_error

echo.
echo If a new password was generated, open LOGIN_PASSWORD.txt.
echo Sign in with username admin and the password from that file.
echo.
echo Starting the server. Keep the server window OPEN.
start "Threads Reply SERVER - KEEP OPEN" /D "%~dp0" cmd.exe /k "node server.js"

echo Checking http://localhost:3000/health ...
for /L %%I in (1,1,12) do (
  powershell.exe -NoProfile -NonInteractive -Command "try { $r=Invoke-WebRequest 'http://127.0.0.1:3000/health' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } } catch {} ; exit 1" >nul 2>nul
  if not errorlevel 1 goto ready
  timeout /t 1 /nobreak >nul
)
echo.
echo [ERROR] Server failed to start.
echo Read the error in the other window (Threads Reply SERVER).
echo You can also run: node server.js
echo.
pause
exit /b 1

:ready
echo [OK] Server is running. Opening dashboard.
start "" "http://localhost:3000"
echo Keep Threads Reply SERVER window open.
echo.
pause
exit /b 0

:missing_node
echo [ERROR] Node.js 20+ was not found.
echo Install LTS from https://nodejs.org/en/download
pause
exit /b 1
:missing_files
echo [ERROR] Project files are missing. Extract the ENTIRE ZIP.
pause
exit /b 1
:setup_error
echo [ERROR] Could not prepare .env. Check setup_windows.ps1.
pause
exit /b 1
