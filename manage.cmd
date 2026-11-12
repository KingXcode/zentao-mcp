@echo off
setlocal
chcp 65001 >nul
where node >nul 2>&1
if errorlevel 1 (
  echo Please install Node.js 20 or newer: https://nodejs.org/
  pause
  exit /b 1
)
node "%~dp0scripts\manage-agents.mjs" %*
set "zentao_exit=%errorlevel%"
if not "%zentao_exit%"=="0" pause
exit /b %zentao_exit%
