#!/usr/bin/env sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_root"
port=${1:-47831}

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    powershell.exe -NoProfile -File "$(cygpath -w "$project_root/scripts/dev.ps1")" -Port "$port" &
    launcher=$!
    trap 'kill "$launcher" 2>/dev/null || :; wait "$launcher" 2>/dev/null || :' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    trap 'exit 129' HUP
    wait "$launcher"
    exit $?
    ;;
esac

pnpm install --frozen-lockfile
pnpm build
mkdir -p build
go build -o build/EFTToolbox.exe ./backend/cmd/EFTToolbox

# Keep the server in the foreground; do not leave a background process.
exec ./build/EFTToolbox.exe -port "$port"
