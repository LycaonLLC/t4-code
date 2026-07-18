#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "perf:vps requires a Linux host" >&2
  exit 1
fi
if [[ "$(id -u)" == "0" ]]; then
  echo "perf:vps refuses to run Electron as root; use an unprivileged VPS account" >&2
  exit 1
fi
for command_name in node pnpm unzip xvfb-run; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "missing required command: $command_name" >&2
    exit 1
  fi
done

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$node_major" != "24" ]]; then
  echo "T4 benchmarks require Node 24; found $(node --version)" >&2
  exit 1
fi

pnpm install --frozen-lockfile
node scripts/perf/ensure-electron.mjs
sandbox_path="$(find node_modules/.pnpm -path '*/electron@*/node_modules/electron/dist/chrome-sandbox' -print -quit)"
if [[ -z "$sandbox_path" ]]; then
  echo "Electron chrome-sandbox helper is missing" >&2
  exit 1
fi
if [[ "$(stat -c '%u:%a' "$sandbox_path")" != "0:4755" ]]; then
  if ! sudo -n true 2>/dev/null; then
    echo "Electron sandbox needs root ownership and mode 4755: $sandbox_path" >&2
    exit 1
  fi
  sudo chown root:root "$sandbox_path"
  sudo chmod 4755 "$sandbox_path"
fi
pnpm exec playwright install chromium
pnpm perf:core
pnpm build:web
pnpm build:desktop
node scripts/perf/ui.mjs
xvfb-run -a -s "-screen 0 1440x900x24" node scripts/perf/electron.mjs

echo "VPS benchmark reports: $repo_root/${T4_PERF_OUTPUT_DIR:-test-results/perf}"
