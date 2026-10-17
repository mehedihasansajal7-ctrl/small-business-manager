@echo off
REM ---------------------------------------------------------------------------
REM  Reach the app over HTTPS from outside the house/office Wi-Fi.
REM
REM  This uses a Cloudflare tunnel: no port forwarding, no router changes, and
REM  nothing is published except the app itself. Two ways to run it:
REM
REM   QUICK (no account, perfect for a test)
REM     scripts\tunnel.cmd
REM     -> prints a random https://<something>.trycloudflare.com address.
REM        The address changes every time this is restarted.
REM
REM   PERMANENT (your own domain, survives restarts - this is the production one)
REM     cloudflared tunnel login
REM     cloudflared tunnel create sbm
REM     cloudflared tunnel route dns sbm sbm.yourdomain.com
REM     cloudflared tunnel run --url http://127.0.0.1:8787 sbm
REM
REM  Install cloudflared once:  winget install --id Cloudflare.cloudflared
REM
REM  Before you expose this outside, read the note at the bottom of README.md:
REM  a public URL means the internet can reach the sign-in page. The app has
REM  rate-limited sign-in and one owner account; for a finance app, a private
REM  network (Tailscale) is the safer default.
REM ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0.."

where cloudflared >nul 2>nul
if errorlevel 1 (
  echo.
  echo   cloudflared is not installed.
  echo.
  echo   Install it once with an elevated-or-user PowerShell:
  echo       winget install --id Cloudflare.cloudflared
  echo.
  echo   Then run this file again.
  echo.
  exit /b 1
)

echo.
echo   Starting a quick HTTPS tunnel to http://127.0.0.1:8787
echo   Copy the https://....trycloudflare.com address printed below into the
echo   phone app: sign-in screen -^> "Advanced: which server?" -^> paste -^> Test and save.
echo   Press Ctrl+C here to close the tunnel.
echo.
cloudflared tunnel --url http://127.0.0.1:8787 --no-autoupdate
