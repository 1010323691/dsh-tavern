@echo off
setlocal
chcp 65001 >nul
node "%~dp0..\shared\tavern.mjs" stop
set "DSH_TAVERN_LAUNCH_STATUS=%ERRORLEVEL%"
echo.
pause
exit /b %DSH_TAVERN_LAUNCH_STATUS%
