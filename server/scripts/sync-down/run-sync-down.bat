@echo off
setlocal
set NODE_EXE=C:\Program Files\nodejs\node.exe
set SCRIPT=C:\Users\Administrator\Desktop\UCS-CRM\UCS_CRM\backend\scripts\sync-down\sync-down.mjs
set LOG=C:\Users\Administrator\Desktop\UCS-CRM\UCS_CRM\database\logs\sync-down.log

if not exist "%~dp0..\..\..\..\database\logs" mkdir "C:\Users\Administrator\Desktop\UCS-CRM\UCS_CRM\database\logs"

echo ============================================================
echo   UCS CRM - Sync AWS to Local
echo   This will pull the latest AWS data (DB + media) down to
echo   this local server. A local pre-backup is taken first.
echo ============================================================
echo.

echo [%date% %time%] === sync-down (manual button) start === >> "%LOG%"
"%NODE_EXE%" "%SCRIPT%" >> "%LOG%" 2>&1
set EXIT=%errorlevel%
echo [%date% %time%] === sync-down end (exit %EXIT%) === >> "%LOG%"

echo.
if %EXIT% EQU 0 (
  echo [SUCCESS] Sync-down completed OK.
  echo See log: %LOG%
) else (
  echo [ERROR] Sync-down finished with errors (exit %EXIT%).
  echo Check the log for details: %LOG%
  echo It is usually the RDS security-group whitelist. Your public IP
  echo must be added to sg-0947f3d87e6807617 (port 5432).
)
echo.
pause
exit /b %EXIT%
