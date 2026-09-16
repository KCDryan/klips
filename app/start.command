#!/bin/bash
# AI Clipper for macOS / Linux: double-click (macOS) or run ./start.command
# The first run installs everything into .venv (a few minutes). Later runs start straight away.
cd "$(dirname "$0")"

PY=""
for candidate in python3.12 python3.11 python3.10 python3; do
  if command -v "$candidate" >/dev/null 2>&1; then PY="$candidate"; break; fi
done
if [ -z "$PY" ]; then
  echo "Python 3.10, 3.11 or 3.12 is required. Download it from https://www.python.org/downloads/"
  read -r -p "Press Return to close"
  exit 1
fi

if [ ! -x .venv/bin/python ]; then
  echo "First run: installing AI Clipper with $PY (this takes a few minutes)..."
  if ! "$PY" -m venv .venv || ! .venv/bin/python -m pip install --upgrade pip || ! .venv/bin/python -m pip install -r requirements.txt; then
    rm -rf .venv
    echo "Install failed. Check the messages above (Python 3.10-3.12 is required)."
    read -r -p "Press Return to close"
    exit 1
  fi
fi

( sleep 4; open https://klips.pro/studio/ 2>/dev/null || xdg-open https://klips.pro/studio/ 2>/dev/null ) &
echo "Klips Engine is starting. Klips Studio opens at https://klips.pro/studio/ (close this window to stop the engine)"
.venv/bin/python app.py
