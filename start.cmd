@echo off
setlocal
chcp 65001 >nul
title 絮桥 Xuqiao
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 24 or newer, then run this script again.
  pause
  exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)"
if errorlevel 1 (
  echo Node.js 24 or newer is required.
  pause
  exit /b 1
)
if not exist "node_modules\ws\package.json" (
  echo First setup: run npm ci in this directory, then start again.
  pause
  exit /b 1
)
node scripts/launch.mjs %*
set "QQ_BOT_EXIT_CODE=%errorlevel%"
if not "%QQ_BOT_EXIT_CODE%"=="0" pause
exit /b %QQ_BOT_EXIT_CODE%
