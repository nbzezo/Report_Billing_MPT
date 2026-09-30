@echo off
setlocal
cd /d "%~dp0"

for /f "delims=" %%P in ('where pythonw.exe 2^>nul') do (
  start "" "%%P" "%~dp0scripts\mpt_dashboard_app.py"
  exit /b 0
)

where pyw.exe >nul 2>nul
if %errorlevel%==0 (
  start "" pyw.exe -3 "%~dp0scripts\mpt_dashboard_app.py"
  exit /b 0
)

powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\run-app.ps1"
