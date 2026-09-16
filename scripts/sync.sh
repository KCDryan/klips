#!/bin/bash
# Klips auto-sync: keeps GitHub, klips.pro and the app downloads in step with this Mac.
#
#   1. A new installer release on GitHub? -> copy it to klips.pro's download storage.
#   2. Nothing changed locally?            -> stop here.
#   3. Run the website and app tests; if anything fails, stop (nothing is pushed or deployed).
#   4. Commit and push to GitHub.
#   5. Website changed?                    -> build and deploy klips.pro.
#   6. App version number changed?         -> tag a release; GitHub builds the installers,
#                                             and step 1 publishes them on a later run.
#
# Runs every 10 minutes via ~/Library/LaunchAgents/pro.klips.sync.plist. Run it by hand any time:
#   ~/klips/scripts/sync.sh
# Log: ~/Library/Logs/klips-sync.log

set -uo pipefail

REPO="$HOME/klips"
LOG="$HOME/Library/Logs/klips-sync.log"
LOCK="/tmp/klips-sync.lock"
PYTHON="${KLIPS_PYTHON:-$HOME/ai-clipper/.venv/bin/python}"
export PATH="$HOME/.local/node/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }

# One run at a time.
if ! mkdir "$LOCK" 2>/dev/null; then
  exit 0
fi
trap 'rmdir "$LOCK"' EXIT

cd "$REPO" || { log "repo missing at $REPO"; exit 1; }

# --- 1. publish the newest installer release to klips.pro downloads ---
publish_release() {
  local latest done_file tmp
  latest=$(gh release view --json tagName -q .tagName 2>/dev/null) || return 0
  done_file="$REPO/.git/klips-published-release"
  [ -z "$latest" ] && return 0
  [ "$latest" = "$(cat "$done_file" 2>/dev/null)" ] && return 0
  tmp=$(mktemp -d)
  if gh release download "$latest" --dir "$tmp" --pattern "Klips-mac.dmg" --pattern "Klips-windows-setup.exe" >>"$LOG" 2>&1 \
    && [ -f "$tmp/Klips-mac.dmg" ] && [ -f "$tmp/Klips-windows-setup.exe" ] \
    && "$PYTHON" "$REPO/scripts/upload_installer.py" --version "$latest" "$tmp/Klips-windows-setup.exe" "$tmp/Klips-mac.dmg" >>"$LOG" 2>&1; then
    echo "$latest" > "$done_file"
    log "published $latest installers to klips.pro/download"
  else
    log "release $latest isn't ready to publish yet; will retry next run"
  fi
  rm -rf "$tmp"
}
publish_release

# --- 2. anything to sync? ---
git fetch -q origin main 2>>"$LOG" || { log "can't reach GitHub; will retry next run"; exit 0; }

CHANGES=$(git status --porcelain)
UNPUSHED=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)
if [ -z "$CHANGES" ] && [ "$UNPUSHED" = "0" ]; then
  exit 0
fi

log "changes found (uncommitted: $([ -n "$CHANGES" ] && echo yes || echo no), unpushed commits: $UNPUSHED)"

# --- 3. checks: never push or deploy something broken ---
if ! (cd web && npm run typecheck >>"$LOG" 2>&1 && npm test >>"$LOG" 2>&1); then
  log "website checks failed; nothing pushed. See the log above."
  exit 1
fi
if ! (cd app && CLIPPER_DATA="$(mktemp -d)" "$PYTHON" -m pytest -q tests >>"$LOG" 2>&1); then
  log "app tests failed; nothing pushed. See the log above."
  exit 1
fi

# --- 4. commit and push ---
if [ -n "$CHANGES" ]; then
  git add -A
  git commit -q -m "Update Klips ($(date '+%Y-%m-%d %H:%M'))

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>" >>"$LOG" 2>&1
fi

WEB_CHANGED=$(git diff --name-only origin/main HEAD -- web | head -1)
if ! git push -q origin HEAD:main >>"$LOG" 2>&1; then
  log "push to GitHub failed; will retry next run"
  exit 1
fi
log "pushed $(git rev-parse --short HEAD) to GitHub"

# --- 5. deploy the website when it changed ---
if [ -n "$WEB_CHANGED" ]; then
  if (cd web && npm run build >>"$LOG" 2>&1 && npx wrangler deploy >>"$LOG" 2>&1); then
    log "deployed klips.pro"
  else
    log "website deploy failed; see the log above"
  fi
fi

# --- 6. tag a release when the app version number changes ---
VERSION=$(sed -n 's/^APP_VERSION = "\(.*\)"/\1/p' app/clipper/pipeline.py | head -1)
if [ -n "$VERSION" ] && ! git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null; then
  if git ls-remote --exit-code --tags origin "refs/tags/v$VERSION" >/dev/null 2>&1; then
    git fetch -q origin "refs/tags/v$VERSION:refs/tags/v$VERSION"
  else
    git tag "v$VERSION" && git push -q origin "v$VERSION" >>"$LOG" 2>&1 \
      && log "tagged v$VERSION; GitHub is building the installers"
  fi
fi

exit 0
