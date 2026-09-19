#!/usr/bin/env bash
set -euo pipefail

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$project_root"
port=${1:-47831}
rebuild=${2:-}

echo '[1/4] Checking dependencies'
if [ ! -d node_modules/.pnpm ] || [ ! -d dashboard/node_modules ]; then
  pnpm install --frozen-lockfile
else
  echo 'Using installed dependencies (run pnpm install --frozen-lockfile after dependency changes).'
fi
if [ ! -f data/upstream/catalog.json ]; then
  echo 'Map cache missing; run pnpm toolbox data refresh first.' >&2
  exit 1
fi
echo '[2/4] Checking dashboard build'
if [ "$rebuild" != '--rebuild' ] && node scripts/cli.mjs cache check dashboard; then
  echo 'Dashboard unchanged; using cached build.'
else
  pnpm build
  node scripts/cli.mjs cache save dashboard
fi
mkdir -p build
echo '[3/4] Checking Go backend build'
if [ "$rebuild" != '--rebuild' ] && node scripts/cli.mjs cache check backend; then
  echo 'Backend unchanged; using cached executable.'
else
  echo 'Building Go backend (the first build can take longer)'
  go build -v -o build/EFTToolbox.exe ./backend/cmd/EFTToolbox
  node scripts/cli.mjs cache save backend
fi

dotnet publish overlay/Overlay.csproj -c Release -o build/overlay --no-self-contained

# Keep the server in the foreground; do not leave a background process.
echo "[4/4] Starting http://127.0.0.1:$port (Ctrl+C to stop)"
exec ./build/EFTToolbox.exe -port "$port" -assets "$project_root/build/dashboard" -data "$project_root/data"
