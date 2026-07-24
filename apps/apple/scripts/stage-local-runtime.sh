#!/bin/sh
set -eu

fail() {
  printf '%s\n' "stage-local-runtime: $*" >&2
  exit 1
}

script_input="${SCRIPT_INPUT_FILE:-}"
if [ -z "$script_input" ]; then
  script_input="${SCRIPT_INPUT_FILE_0:-}"
fi

if [ -n "$script_input" ]; then
  script_dir="$(CDPATH= cd -- "$(dirname -- "$script_input")" 2>/dev/null && pwd -P)" || fail "cannot resolve SCRIPT_INPUT_FILE"
  repo_root="$(CDPATH= cd -- "$script_dir/../../.." 2>/dev/null && pwd -P)" || fail "cannot resolve repository root"
else
  project_path="${PROJECT_DIR:-${SRCROOT:-}}"
  [ -n "$project_path" ] || fail "SCRIPT_INPUT_FILE or project path is required"
  project_dir="$(CDPATH= cd -- "$project_path" 2>/dev/null && pwd -P)" || fail "cannot resolve project path"
  repo_root="$(CDPATH= cd -- "$project_dir/../.." 2>/dev/null && pwd -P)" || fail "cannot resolve repository root"
fi

[ -f "$repo_root/package.json" ] || fail "repository root is missing package.json"
[ -f "$repo_root/pnpm-lock.yaml" ] || fail "repository root is missing pnpm-lock.yaml"
[ -f "$repo_root/scripts/stage-omp-runtime.mjs" ] || fail "repository root is missing runtime staging script"
[ -f "$repo_root/packages/host-daemon/package.json" ] || fail "repository root is missing host-daemon package"

host_binary="$repo_root/packages/host-daemon/dist/t4-host"
host_package="$repo_root/packages/host-daemon/package.json"
host_lockfile="$repo_root/pnpm-lock.yaml"
host_stale=0

if [ ! -f "$host_binary" ] || [ ! -x "$host_binary" ]; then
  host_stale=1
else
  for dependency in \
    "$host_package" \
    "$host_lockfile" \
    "$repo_root/packages/host-daemon/tsconfig.json" \
    "$repo_root/packages/host-service/package.json" \
    "$repo_root/packages/host-wire/package.json"
  do
    if [ -f "$dependency" ] && [ "$dependency" -nt "$host_binary" ]; then
      host_stale=1
      break
    fi
  done

  if [ "$host_stale" -eq 0 ]; then
    for source_root in \
      "$repo_root/packages/host-daemon" \
      "$repo_root/packages/host-service" \
      "$repo_root/packages/host-wire"
    do
      if [ -d "$source_root" ] && [ -n "$(find "$source_root" -type f -newer "$host_binary" -print -quit)" ]; then
        host_stale=1
        break
      fi
    done
  fi
fi

if [ "$host_stale" -eq 1 ]; then
  pnpm_bin="$(command -v pnpm 2>/dev/null || true)"
  [ -n "$pnpm_bin" ] || fail "pnpm is required to build t4-host"
  (
    cd "$repo_root"
    "$pnpm_bin" --filter @t4-code/host-daemon build:binary
  ) || fail "failed to build t4-host"
fi

[ -f "$host_binary" ] && [ -x "$host_binary" ] || fail "t4-host is not an executable"

node_bin="$(command -v node 2>/dev/null || true)"
[ -n "$node_bin" ] || fail "node is required to stage omp"
"$node_bin" "$repo_root/scripts/stage-omp-runtime.mjs" \
  --platform darwin \
  --arch arm64 \
  --runtime verified

omp_binary="$repo_root/.artifacts/omp-runtime/omp"
[ -f "$omp_binary" ] && [ -x "$omp_binary" ] || fail "omp is not an executable"

built_products_dir="${BUILT_PRODUCTS_DIR:-}"
contents_folder_path="${CONTENTS_FOLDER_PATH:-}"
[ -n "$built_products_dir" ] || fail "BUILT_PRODUCTS_DIR is required"
[ -n "$contents_folder_path" ] || fail "CONTENTS_FOLDER_PATH is required"

resources_dir="$built_products_dir/$contents_folder_path/Resources/T4Runtime"
mkdir -p "$resources_dir"
install -m 755 "$host_binary" "$resources_dir/t4-host"
install -m 755 "$omp_binary" "$resources_dir/omp"

[ -f "$resources_dir/t4-host" ] && [ -x "$resources_dir/t4-host" ] || fail "staged t4-host is not executable"
[ -f "$resources_dir/omp" ] && [ -x "$resources_dir/omp" ] || fail "staged omp is not executable"
