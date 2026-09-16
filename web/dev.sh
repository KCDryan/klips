#!/bin/bash
# Local development for klips.pro: the React site and the Worker API together on http://localhost:5173
cd "$(dirname "$0")"
export PATH="$HOME/.local/node/bin:$PATH"
exec npm run dev -- --port 5173 --strictPort
