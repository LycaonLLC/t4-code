#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$repo_root"

if [[ "$(node -p 'process.versions.node.split(".")[0]')" != "24" ]]; then
  echo "autoresearch requires Node 24; found $(node --version)" >&2
  exit 1
fi
for command_name in pnpm timeout; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "missing required command: $command_name" >&2
    exit 1
  fi
done
if [[ ! -d node_modules ]]; then
  echo "dependencies are missing; run pnpm install --frozen-lockfile before autoresearch" >&2
  exit 1
fi

entry_count="${T4_PERF_ENTRY_COUNT:-10000}"
event_count="${T4_PERF_EVENT_COUNT:-100000}"
repetitions="${T4_PERF_REPETITIONS:-7}"
warmups="${T4_PERF_WARMUPS:-1}"
timeout_seconds="${T4_AUTORESEARCH_TIMEOUT_SECONDS:-120}"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
output_dir="test-results/perf/autoresearch/$run_id"
mkdir -p "$output_dir"

runner=()
cpu_affinity="unbound"
if command -v taskset >/dev/null 2>&1; then
  cpu_affinity="${T4_AUTORESEARCH_CPU:-6}"
  runner=(taskset -c "$cpu_affinity")
fi

export CI=1
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--expose-gc"
export T4_PERF_ENTRY_COUNT="$entry_count"
export T4_PERF_EVENT_COUNT="$event_count"
export T4_PERF_REPETITIONS="$repetitions"
export T4_PERF_WARMUPS="$warmups"
export T4_PERF_MACHINE_LABEL="${T4_PERF_MACHINE_LABEL:-linux-vps-x64}"
export T4_PERF_OUTPUT_DIR="$output_dir"

"${runner[@]}" timeout "$timeout_seconds" pnpm exec vp test run packages/client/test/projection.test.ts
"${runner[@]}" timeout "$timeout_seconds" pnpm exec vp test run scripts/perf/core.test.ts
node scripts/perf/autoresearch-report.mjs "$output_dir/latest-core.json"
printf 'ASI timeout_seconds=%s\n' "$timeout_seconds"
printf 'ASI cpu_affinity=%s\n' "$cpu_affinity"
