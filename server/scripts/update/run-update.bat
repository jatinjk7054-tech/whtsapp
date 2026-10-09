@echo off
setlocal
set POWERSHELL=C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe
set SCRIPT=C:\Users\Administrator\Desktop\UCS-CRM\UCS_CRM\backend\scripts\update\update.ps1

"%POWERSHELL%" -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"
exit /b %errorlevel%
