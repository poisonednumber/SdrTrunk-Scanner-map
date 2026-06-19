@echo off
REM ============================================================
REM  Scanner Map launcher (Windows)
REM  Double-click this file to run Scanner Map.
REM  It auto-restarts into the full app after first-time setup.
REM ============================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed or not on your PATH.
  echo   Download the LTS version from https://nodejs.org then run this again.
  echo.
  pause
  exit /b 1
)

REM Tell the app it was started by the launcher so it can self-restart (exit 75).
set SCANNER_LAUNCHER=1

:loop
node start.js
set EC=!ERRORLEVEL!

if "!EC!"=="75" (
  echo.
  echo === Restarting Scanner Map to apply setup... ===
  echo.
  goto loop
)

if not "!EC!"=="0" (
  echo.
  echo Scanner Map exited with code !EC!.
  echo Review the messages above, then close this window.
  pause
)

endlocal
