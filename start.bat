@echo off
cd /d "%~dp0"
if not exist node_modules (
  where npm >nul 2>nul
  if errorlevel 1 (
    echo Node.js not found. Install it from https://nodejs.org and run this file again.
    pause
    exit /b 1
  )
  echo Installing dependencies, this takes a few minutes...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)
wscript //nologo "%~dp0start-hidden.vbs"
exit /b 0
