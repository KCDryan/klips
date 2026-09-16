@echo off
rem AI Clipper for Windows: double-click this file.
rem The first run installs everything into .venv (a few minutes). Later runs start straight away.
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo First run: installing AI Clipper, this takes a few minutes...
  py -3.12 -m venv .venv 2>nul || py -3.11 -m venv .venv 2>nul || py -3.10 -m venv .venv 2>nul || python -m venv .venv
  if not exist ".venv\Scripts\python.exe" (
    echo Python 3.10, 3.11 or 3.12 is required. Download it from https://www.python.org/downloads/
    pause
    exit /b 1
  )
  ".venv\Scripts\python.exe" -m pip install --upgrade pip
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt
  if errorlevel 1 (
    rmdir /s /q .venv
    echo Install failed. Check the messages above - Python 3.10 to 3.12 is required.
    pause
    exit /b 1
  )
)

start "" cmd /c "timeout /t 5 >nul & start http://localhost:5055"
echo AI Clipper is starting at http://localhost:5055 - close this window to stop it.
".venv\Scripts\python.exe" app.py
pause
