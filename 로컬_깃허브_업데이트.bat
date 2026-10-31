@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Threads Reply - GitHub Pull
if not exist ".git" (
  echo [ERROR] This folder is not a Git clone.
  echo Use GitHub Desktop to clone your repository first.
  pause
  exit /b 1
)
where git.exe >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Git not found. Install GitHub Desktop or Git for Windows.
  pause
  exit /b 1
)
echo Checking for updates on GitHub...
git pull --ff-only
if errorlevel 1 (
  echo [ERROR] Update not applied. Check local changes and connection.
  pause
  exit /b 1
)
echo.
echo [OK] Your local files are updated.
echo Close the running SERVER window and start start_windows.bat again.
echo Your .env and data folder are NOT uploaded by git.
pause
