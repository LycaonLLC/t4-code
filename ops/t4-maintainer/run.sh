#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

# Keep the user manager's full environment and make the normal per-user tool
# locations available after boot as well as during a desktop login.
export PATH="$HOME/.local/bin:$HOME/bin:$HOME/.cargo/bin:${PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
MAINTAINER_ROOT=${T4_MAINTAINER_ROOT:-"${XDG_DATA_HOME:-$HOME/.local/share}/t4-maintainer"}
T4_SOURCE_ROOT=${T4_MAINTAINER_T4_SOURCE_ROOT:-$(cd -- "$SCRIPT_DIR/../.." && pwd -P)}
PROMPT_FILE=${T4_MAINTAINER_PROMPT_FILE:-"$SCRIPT_DIR/prompt.md"}
STATE_DIR="$MAINTAINER_ROOT/state"
RUNS_DIR="$MAINTAINER_ROOT/runs"
WORK_DIR="$MAINTAINER_ROOT/work"
LOGS_DIR="$MAINTAINER_ROOT/logs"
LOCK_FILE="$STATE_DIR/maintainer.lock"
PROCESSED_FILE="$STATE_DIR/processed.json"

GH=${T4_MAINTAINER_GH:-gh}
CURL=${T4_MAINTAINER_CURL:-curl}
JQ=${T4_MAINTAINER_JQ:-jq}
OMP=${T4_MAINTAINER_OMP:-omp}
VERIFY_ATTEMPTS=${T4_MAINTAINER_VERIFY_ATTEMPTS:-91}
VERIFY_INTERVAL_SECONDS=${T4_MAINTAINER_VERIFY_INTERVAL_SECONDS:-30}

readonly OMP_UPSTREAM_REPOSITORY="can1357/oh-my-pi"
readonly OMP_INTEGRATION_REPOSITORY="lyc-aon/oh-my-pi"
readonly T4_REPOSITORY="LycaonLLC/t4-code"
readonly T4_SITE="https://t4code.net"

timestamp() {
  date --utc +'%Y-%m-%dT%H:%M:%SZ'
}

log() {
  printf '%s %s\n' "$(timestamp)" "$*"
}

fail() {
  log "ERROR: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command is unavailable: $1"
}

require_positive_integer() {
  [[ $2 =~ ^[1-9][0-9]*$ ]] || fail "$1 must be a positive integer"
}

prepare_directories() {
  mkdir -p -- "$STATE_DIR" "$RUNS_DIR" "$WORK_DIR" "$LOGS_DIR"
  chmod 700 -- "$MAINTAINER_ROOT" "$STATE_DIR" "$RUNS_DIR" "$WORK_DIR" "$LOGS_DIR"
}

acquire_lock() {
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    log "A maintainer run is already active; this timer event is complete."
    exit 0
  fi
}

latest_stable_release() {
  local release tag commit
  release=$($GH api "repos/$OMP_UPSTREAM_REPOSITORY/releases/latest")
  tag=$(printf '%s' "$release" | $JQ -er '
    select(.draft == false and .prerelease == false)
    | .tag_name
    | select(test("^v[0-9]+\\.[0-9]+\\.[0-9]+$"))
  ') || fail "the official latest release is not a stable semantic-version tag"
  commit=$($GH api "repos/$OMP_UPSTREAM_REPOSITORY/commits/$tag" --jq .sha)
  [[ $commit =~ ^[0-9a-f]{40}$ ]] || fail "the official release tag did not resolve to a commit"
  $JQ -cn --arg tag "$tag" --arg commit "$commit" '{tag: $tag, commit: $commit}'
}

processed_matches() {
  local target=$1
  [[ -s $PROCESSED_FILE ]] || return 1
  $JQ -e --argjson target "$target" '
    .upstream.tag == $target.tag and .upstream.commit == $target.commit
  ' "$PROCESSED_FILE" >/dev/null 2>&1
}

resolve_public_commit() {
  local repository=$1 ref=$2
  $GH api "repos/$repository/commits/$ref" --jq .sha
}

release_assets_are_public() {
  local release_json=$1 version=$2
  local -a expected=(
    "SHA256SUMS.txt"
    "T4-Code-${version}-android.apk"
    "T4-Code-${version}-linux-amd64.deb"
    "T4-Code-${version}-linux-x86_64.AppImage"
    "T4-Code-${version}-mac-arm64.dmg"
    "T4-Code-${version}-mac-arm64.zip"
  )
  local name url
  for name in "${expected[@]}"; do
    url=$(printf '%s' "$release_json" | $JQ -er --arg name "$name" '
      .assets[]
      | select(.name == $name and .state == "uploaded" and .size > 0)
      | .browser_download_url
    ') || return 1
    $CURL -fsSIL --retry 3 --retry-all-errors --max-time 45 "$url" >/dev/null || return 1
  done
}

site_has_release() {
  local t4_tag=$1 integration_tag=$2 version=$3
  local cache_bust index docs site_assets asset bundle_file
  cache_bust=$(date +%s)
  index=$($CURL -fsSL --retry 3 --retry-all-errors --max-time 45 "$T4_SITE/?maintainer=$cache_bust") || return 1
  docs=$($CURL -fsSL --retry 3 --retry-all-errors --max-time 45 "$T4_SITE/docs/?maintainer=$cache_bust") || return 1
  site_assets=$(printf '%s\n%s' "$index" "$docs" | grep -oE '(src|href)="/assets/[^"]+\.js"' | sed -E 's/^(src|href)="([^"]+)"$/\2/' | sort -u)
  [[ -n $site_assets ]] || return 1
  bundle_file=$(mktemp "$STATE_DIR/site-bundles.XXXXXX")
  while IFS= read -r asset; do
    $CURL -fsSL --retry 3 --retry-all-errors --max-time 45 "$T4_SITE${asset}?maintainer=$cache_bust" >>"$bundle_file" || {
      rm -f -- "$bundle_file"
      return 1
    }
  done <<<"$site_assets"
  grep -Fq -- "$t4_tag" "$bundle_file" || {
    rm -f -- "$bundle_file"
    return 1
  }
  grep -Fq -- "$integration_tag" "$bundle_file" || {
    rm -f -- "$bundle_file"
    return 1
  }
  grep -Fq -- "T4-Code-${version}-linux-amd64.deb" "$bundle_file" || {
    rm -f -- "$bundle_file"
    return 1
  }
  rm -f -- "$bundle_file"
}

verify_result_once() {
  local result_file=$1 target=$2
  local upstream_tag upstream_commit integration_tag integration_commit
  local t4_version t4_tag t4_commit release_url site_url site_tag
  local actual_integration_commit actual_t4_commit release_json expected_release_url

  $JQ -e '
    (.upstream.tag | type == "string") and
    (.upstream.commit | test("^[0-9a-f]{40}$")) and
    (.integration.tag | type == "string") and
    (.integration.commit | test("^[0-9a-f]{40}$")) and
    (.t4.version | test("^[0-9]+\\.[0-9]+\\.[0-9]+$")) and
    (.t4.tag | test("^v[0-9]+\\.[0-9]+\\.[0-9]+$")) and
    (.t4.commit | test("^[0-9a-f]{40}$")) and
    (.release.url | type == "string") and
    (.site.url | type == "string") and
    (.site.releaseTag | type == "string")
  ' "$result_file" >/dev/null || return 1

  upstream_tag=$($JQ -r '.upstream.tag' "$result_file")
  upstream_commit=$($JQ -r '.upstream.commit' "$result_file")
  integration_tag=$($JQ -r '.integration.tag' "$result_file")
  integration_commit=$($JQ -r '.integration.commit' "$result_file")
  t4_version=$($JQ -r '.t4.version' "$result_file")
  t4_tag=$($JQ -r '.t4.tag' "$result_file")
  t4_commit=$($JQ -r '.t4.commit' "$result_file")
  release_url=$($JQ -r '.release.url' "$result_file")
  site_url=$($JQ -r '.site.url' "$result_file")
  site_tag=$($JQ -r '.site.releaseTag' "$result_file")

  [[ $upstream_tag == "$($JQ -r '.tag' <<<"$target")" ]] || return 1
  [[ $upstream_commit == "$($JQ -r '.commit' <<<"$target")" ]] || return 1
  [[ $integration_tag =~ ^t4code-${upstream_tag#v}-appserver-[1-9][0-9]*$ ]] || return 1
  [[ $t4_tag == "v$t4_version" ]] || return 1
  [[ $site_tag == "$t4_tag" && $site_url == "$T4_SITE" ]] || return 1
  expected_release_url="https://github.com/$T4_REPOSITORY/releases/tag/$t4_tag"
  [[ $release_url == "$expected_release_url" ]] || return 1

  actual_integration_commit=$(resolve_public_commit "$OMP_INTEGRATION_REPOSITORY" "$integration_tag") || return 1
  [[ $actual_integration_commit == "$integration_commit" ]] || return 1
  actual_t4_commit=$(resolve_public_commit "$T4_REPOSITORY" "$t4_tag") || return 1
  [[ $actual_t4_commit == "$t4_commit" ]] || return 1

  release_json=$($GH api "repos/$T4_REPOSITORY/releases/tags/$t4_tag") || return 1
  printf '%s' "$release_json" | $JQ -e --arg tag "$t4_tag" --arg url "$expected_release_url" '
    .tag_name == $tag and .html_url == $url and .draft == false and .prerelease == false
  ' >/dev/null || return 1
  release_assets_are_public "$release_json" "$t4_version" || return 1
  site_has_release "$t4_tag" "$integration_tag" "$t4_version" || return 1
}

verify_result() {
  local result_file=$1 target=$2 attempt
  [[ -s $result_file ]] || fail "the maintainer result file is missing"
  require_positive_integer T4_MAINTAINER_VERIFY_ATTEMPTS "$VERIFY_ATTEMPTS"
  require_positive_integer T4_MAINTAINER_VERIFY_INTERVAL_SECONDS "$VERIFY_INTERVAL_SECONDS"
  for ((attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt += 1)); do
    if verify_result_once "$result_file" "$target"; then
      log "Public GitHub release assets and t4code.net match the maintainer result."
      return 0
    fi
    if ((attempt < VERIFY_ATTEMPTS)); then
      log "Public release verification is still converging (${attempt}/${VERIFY_ATTEMPTS}); checking again in ${VERIFY_INTERVAL_SECONDS}s."
      sleep "$VERIFY_INTERVAL_SECONDS"
    fi
  done
  fail "public release verification did not converge"
}

record_processed() {
  local result_file=$1 run_id=$2 temporary
  temporary=$(mktemp "$STATE_DIR/processed.json.XXXXXX")
  $JQ --arg processed_at "$(timestamp)" --arg run_id "$run_id" '
    . + {processedAt: $processed_at, runId: $run_id, publicVerification: "complete"}
  ' "$result_file" >"$temporary"
  chmod 600 "$temporary"
  mv -f -- "$temporary" "$PROCESSED_FILE"
}

adopt_current_public_release() {
  local target matrix package_version t4_tag t4_commit result_file run_id
  [[ -r "$T4_SOURCE_ROOT/compat/omp-app-matrix.json" ]] || fail "T4 compatibility matrix is unavailable at $T4_SOURCE_ROOT"
  [[ -r "$T4_SOURCE_ROOT/package.json" ]] || fail "T4 package metadata is unavailable at $T4_SOURCE_ROOT"

  target=$(latest_stable_release)
  matrix=$(<"$T4_SOURCE_ROOT/compat/omp-app-matrix.json")
  package_version=$($JQ -er '.version | select(test("^[0-9]+\\.[0-9]+\\.[0-9]+$"))' "$T4_SOURCE_ROOT/package.json")
  $JQ -e --argjson target "$target" --arg version "$package_version" '
    .verifiedRuntime.upstreamTag == $target.tag and
    .verifiedRuntime.upstreamCommit == $target.commit and
    .desktop.version == $version and
    (.verifiedRuntime.sourceTag | test("^t4code-" + ($target.tag | ltrimstr("v")) + "-appserver-[1-9][0-9]*$")) and
    (.verifiedRuntime.sourceCommit | test("^[0-9a-f]{40}$"))
  ' <<<"$matrix" >/dev/null || fail "the public T4 compatibility matrix does not match the latest stable official OMP release"

  t4_tag="v$package_version"
  t4_commit=$(resolve_public_commit "$T4_REPOSITORY" "$t4_tag")
  [[ $t4_commit =~ ^[0-9a-f]{40}$ ]] || fail "the public T4 tag did not resolve to a commit"
  run_id="adopt-${t4_tag}-$(date --utc +%Y%m%dT%H%M%SZ)"
  result_file=$(mktemp "$STATE_DIR/adopt-result.XXXXXX.json")
  $JQ -n \
    --argjson upstream "$target" \
    --arg integration_tag "$($JQ -r '.verifiedRuntime.sourceTag' <<<"$matrix")" \
    --arg integration_commit "$($JQ -r '.verifiedRuntime.sourceCommit' <<<"$matrix")" \
    --arg version "$package_version" \
    --arg t4_tag "$t4_tag" \
    --arg t4_commit "$t4_commit" \
    --arg release_url "https://github.com/$T4_REPOSITORY/releases/tag/$t4_tag" \
    --arg site_url "$T4_SITE" \
    '{
      upstream: $upstream,
      integration: {tag: $integration_tag, commit: $integration_commit},
      t4: {version: $version, tag: $t4_tag, commit: $t4_commit},
      release: {url: $release_url},
      site: {url: $site_url, releaseTag: $t4_tag}
    }' >"$result_file"
  verify_result "$result_file" "$target"
  record_processed "$result_file" "$run_id"
  rm -f -- "$result_file"
  log "Adopted the already-public $t4_tag release for official OMP $($JQ -r '.tag' <<<"$target")."
}

run_live_maintenance() {
  local target upstream_tag upstream_commit run_id run_dir workspace context_file result_file
  local omp_status

  target=$(latest_stable_release)
  upstream_tag=$($JQ -r '.tag' <<<"$target")
  upstream_commit=$($JQ -r '.commit' <<<"$target")
  if processed_matches "$target"; then
    log "Latest stable official OMP release $upstream_tag ($upstream_commit) is already publicly processed."
    return 0
  fi

  run_id="${upstream_tag#v}-$(date --utc +%Y%m%dT%H%M%SZ)"
  run_dir="$RUNS_DIR/$run_id"
  workspace="$run_dir/workspace"
  context_file="$run_dir/context.json"
  result_file="$run_dir/result.json"
  mkdir -p -- "$workspace"
  chmod 700 -- "$run_dir" "$workspace"
  $JQ -n \
    --arg detected_at "$(timestamp)" \
    --argjson upstream "$target" \
    --arg workspace "$workspace" \
    --arg result_file "$result_file" \
    --arg omp_upstream "$OMP_UPSTREAM_REPOSITORY" \
    --arg omp_integration "$OMP_INTEGRATION_REPOSITORY" \
    --arg t4 "$T4_REPOSITORY" \
    --arg site "$T4_SITE" \
    --slurpfile previous <(if [[ -s $PROCESSED_FILE ]]; then cat "$PROCESSED_FILE"; else printf 'null\n'; fi) \
    '{
      detectedAt: $detected_at,
      upstream: $upstream,
      repositories: {officialOmp: $omp_upstream, integrationOmp: $omp_integration, t4: $t4},
      site: $site,
      workspace: $workspace,
      resultFile: $result_file,
      previousProcessed: $previous[0]
    }' >"$context_file"

  log "Starting the live T4 publication for official OMP $upstream_tag ($upstream_commit)."
  set +e
  T4_MAINTENANCE_CONTEXT="$context_file" \
  T4_MAINTENANCE_RESULT="$result_file" \
  T4_MAINTENANCE_WORKSPACE="$workspace" \
  T4_MAINTENANCE_UPSTREAM_TAG="$upstream_tag" \
  T4_MAINTENANCE_UPSTREAM_COMMIT="$upstream_commit" \
    "$OMP" \
      --profile t4-maintainer \
      --cwd "$workspace" \
      --model openai-codex/gpt-5.6-sol \
      --thinking max \
      --print \
      --mode json \
      --approval-mode yolo \
      "@$PROMPT_FILE" \
      "Publish T4 Code for official OMP $upstream_tag at $upstream_commit. The run context is $context_file and the verified result belongs at $result_file." \
      >"$run_dir/omp.jsonl" 2>"$run_dir/omp.stderr.log"
  omp_status=$?
  set -e
  if ((omp_status != 0)); then
    fail "the Sol maintainer exited with status $omp_status; run files are retained at $run_dir"
  fi

  verify_result "$result_file" "$target"
  record_processed "$result_file" "$run_id"
  log "Live publication is complete for $upstream_tag; processed state now points to $($JQ -r '.t4.tag' "$result_file")."
}

main() {
  prepare_directories
  require_command flock
  require_command "$GH"
  require_command "$CURL"
  require_command "$JQ"
  require_command "$OMP"
  [[ -r $PROMPT_FILE ]] || fail "maintainer prompt is unavailable: $PROMPT_FILE"
  acquire_lock

  case ${1:-run} in
    run)
      run_live_maintenance
      ;;
    --adopt-current)
      adopt_current_public_release
      ;;
    *)
      fail "usage: $0 [--adopt-current]"
      ;;
  esac
}

main "$@"
