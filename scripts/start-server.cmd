@echo off
REM ---------------------------------------------------------------------------
REM  Start the Small Business Manager server for phones on this Wi-Fi.
REM  Just double-click this file. Leave the window open while people use the app.
REM ---------------------------------------------------------------------------
cd /d "%~dp0.."
title Small Business Manager server (do not close while using the app)
echo Starting the server...
echo.
call npm run api:lan
echo.
echo The server has stopped. Press any key to close this window.
pause >nul
