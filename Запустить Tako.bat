@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem VS Code sets this for its child processes; it makes Electron start as plain Node
set ELECTRON_RUN_AS_NODE=
if not exist node_modules (
  echo Первый запуск: устанавливаю зависимости...
  call npm install --no-audit --no-fund
)
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0." %*
