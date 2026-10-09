@echo off
setlocal
set NODE_EXE=C:\Program Files\nodejs\node.exe
set SCRIPT=C:\Users\Administrator\Desktop\UCS-CRM\UCS_CRM\backend\scripts\local-backup\local-backup.mjs
set LOG=C:\Users\Administrator\Desktop\UCS-CRM\UCS_CRM\database\logs\local-backup.log

if not exist "%~dp0..\..\..\..\database\logs" mkdir "C:\Users\Administrator\Desktop\UCS-CRM\UCS_CRM\database\logs"

echo [%date% %time%] === UCS CRM local backup start === >> "%LOG%"
"%NODE_EXE%" "%SCRIPT%" >> "%LOG%" 2>&1
echo [%date% %time%] === UCS CRM local backup end (exit %errorlevel%) === >> "%LOG%"
exit /b %errorlevel%
