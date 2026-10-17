@echo off
REM ---------------------------------------------------------------------------
REM  Owner lockout escape hatch - no app sign-in needed.
REM  Double-click this file, type the account email, and a new password is
REM  printed here. Use it when nobody can issue an in-app reset code.
REM ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0.."
echo.
echo   Reset a password directly in the local database
echo   ----------------------------------------------
echo   Example: mehedi06@akijresource.com
echo.
set /p SBM_EMAIL=Account email: 
if "%SBM_EMAIL%"=="" goto :cancelled
node scripts\reset-password.mjs "%SBM_EMAIL%"
echo.
pause
exit /b 0

:cancelled
echo Cancelled - nothing was changed.
pause
exit /b 1
