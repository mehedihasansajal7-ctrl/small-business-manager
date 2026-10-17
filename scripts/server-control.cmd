@echo off
REM ---------------------------------------------------------------------------
REM  Start / stop / restart / inspect the LAN server that the watchdog runs.
REM
REM    scripts\server-control.cmd status
REM    scripts\server-control.cmd start
REM    scripts\server-control.cmd stop      (watchdog stops and stays stopped)
REM    scripts\server-control.cmd restart
REM
REM  No admin rights are needed: "stop" drops data\server.stop and the watchdog
REM  honours it, so a deliberate stop is never fought by the restart loop.
REM ---------------------------------------------------------------------------
setlocal enabledelayedexpansion
cd /d "%~dp0.."
if not exist "data" mkdir "data"
set "ACTION=%~1"
if "%ACTION%"=="" set "ACTION=status"

if /i "%ACTION%"=="status" goto :status
if /i "%ACTION%"=="start" goto :start
if /i "%ACTION%"=="stop" goto :stop
if /i "%ACTION%"=="restart" goto :restart
echo Unknown action "%ACTION%". Use: start ^| stop ^| restart ^| status
exit /b 1

:status
echo.
echo   Server status
echo   -------------
powershell -NoProfile -Command "try { $h = Invoke-RestMethod 'http://127.0.0.1:8787/api/health' -TimeoutSec 5; Write-Host ('   API      : ' + $h.status) } catch { Write-Host '   API      : down' }"
if exist "data\watchdog.pid" (
  set /p WPID=<"data\watchdog.pid"
  echo    watchdog : running ^(pid !WPID!^)
) else (
  echo    watchdog : not running
)
echo    log      : %CD%\data\server.log
echo.
exit /b 0

:start
echo   Starting the watchdog...
powershell -NoProfile -Command "Start-Process -FilePath '%~dp0serve-lan-task.cmd' -WindowStyle Minimized"
ping -n 5 127.0.0.1 >nul
call "%~f0" status
exit /b 0

:stop
echo   Asking the watchdog to stop the server...
echo stop > "data\server.stop"
for /l %%i in (1,1,20) do (
  powershell -NoProfile -Command "try { $null = Invoke-RestMethod 'http://127.0.0.1:8787/api/health' -TimeoutSec 2; exit 1 } catch { exit 0 }"
  if not errorlevel 1 goto :stopped
  ping -n 2 127.0.0.1 >nul
)
echo   The API is still answering. Check data\server.log.
exit /b 1

:stopped
echo   Stopped. It will not restart until you run "start" (or sign in again).
exit /b 0

:restart
call "%~f0" stop
ping -n 3 127.0.0.1 >nul
call "%~f0" start
exit /b 0
