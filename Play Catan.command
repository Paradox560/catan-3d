#!/bin/bash
set -e
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo "Install Node.js 22.12 or newer from https://nodejs.org, then open this launcher again."
  read -r -p "Press Return to close."
  exit 1
fi
if [ ! -d node_modules ]; then npm ci; fi
npm run build
node scripts/play.mjs
