
@echo off
rem Metal Detector Studio — one-click launcher.
rem Opens the Electron app, which itself starts the backend (uvicorn) and the
rem frontend (next dev) and then shows the UI. This console window shows their logs;
rem close the app window (or this console) to stop everything.
rem chcp 65001 = UTF-8 console so Next/uvicorn box-drawing & symbols render instead of mojibake.
chcp 65001 >nul
title Metal Detector Studio
cd /d "%~dp0frontend"
call pnpm run app
