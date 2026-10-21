@echo off
REM MeetFlow v0.2 - Windows local start (Docker Desktop)
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\init-env.ps1"
if errorlevel 1 exit /b 1
docker compose up -d --build
if errorlevel 1 exit /b 1
echo [MeetFlow] status: docker compose ps   /   curl http://localhost:3000/api/health
echo [MeetFlow] browser: http://localhost:3000
