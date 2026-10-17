@echo off
REM ---------------------------------------------------------------------------
REM  Started automatically at logon by the "SBM-API-Server" Startup entry.
REM  Runs the watchdog, which keeps the API (and the web app) available at
REM  http://<this PC>:8787 without anyone remembering a command:
REM    - if the server crashes it restarts with backoff
REM    - if it stops answering /api/health it is restarted
REM    - scripts\server-control.cmd stop stops it for good (no restart loop)
REM  Everything is appended to data\server.log.
REM ---------------------------------------------------------------------------
cd /d "%~dp0.."
if not exist "data" mkdir "data"
echo. >> "data\server.log"
echo ===== %DATE% %TIME% watchdog starting ===== >> "data\server.log"
call node scripts\server-watchdog.mjs >> "data\server.log" 2>&1
echo ===== %DATE% %TIME% watchdog stopped (exit %ERRORLEVEL%) ===== >> "data\server.log"
