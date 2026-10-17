@echo off
REM ---------------------------------------------------------------------------
REM  Started automatically at logon by the "SBM-API-Server" scheduled task.
REM  Keeps the API (and the web app) available at http://<this PC>:8787 without
REM  anyone having to remember a command. Logs to data\server.log.
REM ---------------------------------------------------------------------------
cd /d "%~dp0.."
if not exist "data" mkdir "data"
echo. >> "data\server.log"
echo ===== %DATE% %TIME% starting ===== >> "data\server.log"
call npm run api:lan >> "data\server.log" 2>&1
echo ===== %DATE% %TIME% stopped (exit %ERRORLEVEL%) ===== >> "data\server.log"
