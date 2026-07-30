@echo off
setlocal EnableDelayedExpansion
title Homer - Launcher
set "ROOT=%~dp0"

echo.
echo  ============================================
echo   Homer - starting up
echo  ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found. Install it from https://nodejs.org and try again.
  pause
  exit /b 1
)

REM ---- First run: install dependencies if missing ----
if not exist "%ROOT%apps\server\node_modules" (
  echo [SETUP] First run: installing server dependencies - this takes a few minutes...
  pushd "%ROOT%apps\server"
  call npm install
  if errorlevel 1 ( popd & goto :fail )
  echo [SETUP] Downloading the PDF/apply browser - Chromium...
  call npx playwright install chromium
  popd
)
if not exist "%ROOT%apps\dashboard\node_modules" (
  echo [SETUP] First run: installing dashboard dependencies...
  pushd "%ROOT%apps\dashboard"
  call npm install
  if errorlevel 1 ( popd & goto :fail )
  popd
)

REM ---- Prepare database (idempotent - safe on every start) ----
pushd "%ROOT%apps\server"
call npm run --silent db:migrate >nul 2>nul
popd

REM ---- Start the server unless it is already running ----
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing http://127.0.0.1:4750/api/health -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
if not errorlevel 1 (
  echo [OK] Server already running on port 4750.
) else (
  echo [RUN] Starting server on http://127.0.0.1:4750 ...
  start "Homer - Server" cmd /k "cd /d "%ROOT%apps\server" && npm run dev"
)

REM ---- Start the dashboard unless it is already running ----
powershell -NoProfile -Command "$c = New-Object Net.Sockets.TcpClient; try { $c.Connect('127.0.0.1', 5173); exit 0 } catch { exit 1 } finally { $c.Dispose() }" >nul 2>nul
if not errorlevel 1 (
  echo [OK] Dashboard already running on port 5173.
) else (
  echo [RUN] Starting dashboard on http://localhost:5173 ...
  start "Homer - Dashboard" cmd /k "cd /d "%ROOT%apps\dashboard" && npm run dev"
)

REM ---- Wait until both respond, up to ~90 seconds ----
echo [WAIT] Waiting for both apps to come up...
set /a tries=0
:waitloop
set /a tries+=1
if !tries! gtr 45 (
  echo [WARN] Timed out waiting. Check the two "Homer" windows for errors.
  pause
  exit /b 1
)
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing http://127.0.0.1:4750/api/health -TimeoutSec 2 | Out-Null } catch { exit 1 }; $c = New-Object Net.Sockets.TcpClient; try { $c.Connect('127.0.0.1', 5173) } catch { exit 1 } finally { $c.Dispose() }" >nul 2>nul
if errorlevel 1 (
  timeout /t 2 /nobreak >nul
  goto :waitloop
)

echo [OK] Everything is up. Opening Homer...
start "" http://localhost:5173
echo.
echo  The two console windows titled "Homer - Server" and
echo  "Homer - Dashboard" keep the app alive - minimize them,
echo  but close them when you want to shut everything down.
echo.
timeout /t 8 >nul
exit /b 0

:fail
echo.
echo [ERROR] Dependency installation failed. See the messages above.
pause
exit /b 1
