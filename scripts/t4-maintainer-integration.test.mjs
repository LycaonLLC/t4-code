import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const deployScript = resolve(repoRoot, "ops/t4-maintainer/deploy-local.sh");
const runnerScript = resolve(repoRoot, "ops/t4-maintainer/run.sh");

const upstreamCommit = "a".repeat(40);
const integrationCommit = "b".repeat(40);
const t4Commit = "c".repeat(40);
const mainCommit = "d".repeat(40);
const upstreamTagObject = "e".repeat(40);
const integrationTagObject = "f".repeat(40);

const mockDispatcher = String.raw`#!/usr/bin/env bash
set -euo pipefail

tool=$(basename -- "$0")
state=\${MOCK_STATE:?}
calls=\${MOCK_CALLS:?}

printf '%s' "$tool" >>"$calls"
printf '\t%q' "$@" >>"$calls"
printf '\n' >>"$calls"

read_state() {
  local name=$1 fallback=\${2:-}
  if [[ -f $state/$name ]]; then
    cat "$state/$name"
  else
    printf '%s' "$fallback"
  fi
}

write_state() {
  printf '%s' "$2" >"$state/$1"
}

case $tool in
  gh)
    endpoint=''
    for argument in "$@"; do
      [[ $argument == repos/* ]] && endpoint=$argument
    done
    case $endpoint in
      repos/can1357/oh-my-pi/releases/latest)
        printf '{"draft":false,"prerelease":false,"tag_name":"v1.2.3"}\n'
        ;;
      repos/can1357/oh-my-pi/commits/v1.2.3)
        printf '%s\n' "$MOCK_UPSTREAM_COMMIT"
        ;;
      repos/lyc-aon/oh-my-pi/commits/v1.2.3)
        printf '%s\n' "$MOCK_UPSTREAM_COMMIT"
        ;;
      repos/can1357/oh-my-pi/git/ref/tags/v1.2.3)
        printf '%s\n' "$MOCK_UPSTREAM_TAG_OBJECT"
        ;;
      repos/lyc-aon/oh-my-pi/git/ref/tags/v1.2.3)
        [[ \${MOCK_FORK_BASE_TAG_MISSING:-0} != 1 ]] || exit 1
        if [[ \${MOCK_FORK_BASE_TAG_MISMATCH:-0} == 1 ]]; then
          printf '%040d\n' 8
        else
          printf '%s\n' "$MOCK_UPSTREAM_TAG_OBJECT"
        fi
        ;;
      repos/lyc-aon/oh-my-pi/git/ref/tags/t4code-1.2.3-appserver-1)
        printf '%s\n' "$MOCK_INTEGRATION_TAG_OBJECT"
        ;;
      repos/can1357/oh-my-pi/commits/main)
        printf '%s\n' "$MOCK_MAIN_COMMIT"
        ;;
      repos/lyc-aon/oh-my-pi/commits/main)
        if [[ -f $state/fork-main-synced ]]; then
          printf '%s\n' "$MOCK_MAIN_COMMIT"
        elif [[ \${MOCK_FORK_MAIN_DIVERGED:-0} == 1 ]]; then
          printf '%040d\n' 9
        elif [[ \${MOCK_FORK_MAIN_BEHIND:-0} == 1 ]]; then
          printf '%s\n' "$MOCK_UPSTREAM_COMMIT"
        else
          printf '%s\n' "$MOCK_MAIN_COMMIT"
        fi
        ;;
      repos/lyc-aon/oh-my-pi/actions/workflows/ci.yml)
        printf '%s\n' "$(read_state fork-workflow active)"
        ;;
      repos/lyc-aon/oh-my-pi/actions/workflows/ci.yml/disable)
        [[ \${MOCK_FORK_WORKFLOW_DISABLE_FAIL:-0} != 1 ]] || exit 1
        write_state fork-workflow disabled_manually
        printf '{}\n'
        ;;
      repos/lyc-aon/oh-my-pi/actions/workflows/ci.yml/enable)
        [[ \${MOCK_FORK_WORKFLOW_ENABLE_FAIL:-0} != 1 ]] || exit 1
        write_state fork-workflow active
        printf '{}\n'
        ;;
      repos/LycaonLLC/t4-code/releases/latest)
        printf '{"draft":false,"prerelease":false,"tag_name":"v1.2.3"}\n'
        ;;
      repos/LycaonLLC/t4-code/contents/package.json?ref=*)
        printf '{"version":"1.2.3"}\n'
        ;;
      repos/LycaonLLC/t4-code/contents/compat/omp-app-matrix.json?ref=*)
        if [[ \${MOCK_PUBLIC_INCOMPATIBLE:-0} == 1 ||
              (\${MOCK_MAIN_INCOMPATIBLE:-0} == 1 && $endpoint == *'?ref=main') ]]; then
          upstream_tag=v9.9.9
        else
          upstream_tag=v1.2.3
        fi
        printf '{"desktop":{"version":"1.2.3"},"verifiedRuntime":{"upstreamTag":"%s","upstreamCommit":"%s","sourceTag":"t4code-1.2.3-appserver-1","sourceCommit":"%s"}}\n' \
          "$upstream_tag" "$MOCK_UPSTREAM_COMMIT" "$MOCK_INTEGRATION_COMMIT"
        ;;
      repos/lyc-aon/oh-my-pi/commits/t4code-1.2.3-appserver-1)
        printf '%s\n' "$MOCK_INTEGRATION_COMMIT"
        ;;
      repos/LycaonLLC/t4-code/commits/v1.2.3|repos/LycaonLLC/t4-code/commits/main)
        printf '%s\n' "$MOCK_T4_COMMIT"
        ;;
      repos/lyc-aon/oh-my-pi/compare/*)
        if [[ $endpoint == *"$MOCK_INTEGRATION_COMMIT...t4code/main" &&
              \${MOCK_PRODUCT_BRANCH_MISSING:-0} != 1 ]]; then
          printf '{"status":"ahead","ahead_by":1,"base_commit":{"sha":"%s"},"merge_base_commit":{"sha":"%s"},"commits":[]}\n' \
            "$MOCK_INTEGRATION_COMMIT" "$MOCK_INTEGRATION_COMMIT"
        else
          printf '{"status":"ahead","ahead_by":1,"base_commit":{"sha":"%s"},"merge_base_commit":{"sha":"%s"},"commits":[{"sha":"%s"}]}\n' \
            "$MOCK_UPSTREAM_COMMIT" \
            "$MOCK_UPSTREAM_COMMIT" "$MOCK_INTEGRATION_COMMIT"
        fi
        ;;
      repos/LycaonLLC/t4-code/compare/*)
        printf '{"status":"identical","merge_base_commit":{"sha":"%s"}}\n' "$MOCK_T4_COMMIT"
        ;;
      repos/LycaonLLC/t4-code/actions/runs*)
        t4_ci_path='.github/workflows/ci.yml'
        t4_release_path='.github/workflows/release.yml'
        t4_site_path='.github/workflows/deploy-site.yml'
        [[ \${MOCK_T4_WORKFLOW_WRONG_PATH:-0} != 1 ]] || t4_ci_path='.github/workflows/not-ci.yml'
        if [[ (\${MOCK_WORKFLOWS_TERMINAL:-0} == 1 && ! -f $state/sol-ran) ||
              (\${MOCK_WORKFLOWS_FAIL_ONCE_AFTER_SOL:-0} == 1 && -f $state/sol-ran && ! -f $state/workflows-failed-once) ]]; then
          [[ \${MOCK_WORKFLOWS_FAIL_ONCE_AFTER_SOL:-0} != 1 || ! -f $state/sol-ran ]] \
            || write_state workflows-failed-once 1
          cat <<JSON
{"workflow_runs":[
 {"name":"CI","path":"$t4_ci_path","head_sha":"$MOCK_T4_COMMIT","event":"push","head_branch":"main","status":"completed","conclusion":"failure","updated_at":"2020-01-01T00:00:00Z"},
 {"name":"Release app builds","path":"$t4_release_path","head_sha":"$MOCK_T4_COMMIT","event":"push","head_branch":"v1.2.3","status":"completed","conclusion":"failure","updated_at":"2020-01-01T00:00:00Z"},
 {"name":"Deploy project site","path":"$t4_site_path","head_sha":"$MOCK_T4_COMMIT","event":"workflow_dispatch","head_branch":"main","status":"completed","conclusion":"failure","updated_at":"2020-01-01T00:00:00Z"}
]}
JSON
        elif [[ \${MOCK_WORKFLOWS_ACTIVE:-0} == 1 ]]; then
          cat <<JSON
{"workflow_runs":[
 {"name":"CI","path":"$t4_ci_path","head_sha":"$MOCK_T4_COMMIT","event":"push","head_branch":"main","status":"in_progress","conclusion":null,"updated_at":"2026-07-15T00:00:00Z"},
 {"name":"Release app builds","path":"$t4_release_path","head_sha":"$MOCK_T4_COMMIT","event":"push","head_branch":"v1.2.3","status":"queued","conclusion":null,"updated_at":"2026-07-15T00:00:00Z"},
 {"name":"Deploy project site","path":"$t4_site_path","head_sha":"$MOCK_T4_COMMIT","event":"workflow_dispatch","head_branch":"main","status":"queued","conclusion":null,"updated_at":"2026-07-15T00:00:00Z"}
]}
JSON
        else
          cat <<JSON
{"workflow_runs":[
 {"name":"CI","path":"$t4_ci_path","head_sha":"$MOCK_T4_COMMIT","event":"push","head_branch":"main","status":"completed","conclusion":"success","updated_at":"2026-07-15T00:00:00Z"},
 {"name":"Release app builds","path":"$t4_release_path","head_sha":"$MOCK_T4_COMMIT","event":"push","head_branch":"v1.2.3","status":"completed","conclusion":"success","updated_at":"2026-07-15T00:00:00Z"},
 {"name":"Deploy project site","path":"$t4_site_path","head_sha":"$MOCK_T4_COMMIT","event":"workflow_dispatch","head_branch":"main","status":"completed","conclusion":"success","updated_at":"2026-07-15T00:00:00Z"}
]}
JSON
        fi
        ;;
      repos/lyc-aon/oh-my-pi/actions/workflows/ci.yml/runs*)
        omp_workflow_path='.github/workflows/ci.yml'
        [[ \${MOCK_OMP_WORKFLOW_WRONG_PATH:-0} != 1 ]] || omp_workflow_path='.github/workflows/not-ci.yml'
        if [[ \${MOCK_OMP_WORKFLOW_MISSING:-0} == 1 ]]; then
          printf '{"workflow_runs":[]}\n'
        elif [[ \${MOCK_OMP_WORKFLOW_FAILED:-0} == 1 ]]; then
          printf '{"workflow_runs":[{"name":"CI","path":"%s","head_sha":"%s","event":"push","head_branch":"t4code/main","status":"completed","conclusion":"failure"}]}\n' "$omp_workflow_path" "$MOCK_INTEGRATION_COMMIT"
        else
          printf '{"workflow_runs":[{"name":"CI","path":"%s","head_sha":"%s","event":"push","head_branch":"t4code/main","status":"completed","conclusion":"success"}]}\n' "$omp_workflow_path" "$MOCK_INTEGRATION_COMMIT"
        fi
        ;;
      repos/lyc-aon/oh-my-pi/releases/tags/t4code-1.2.3-appserver-1)
        omp_digest=$(printf 'mock-asset\n' | /usr/bin/sha256sum | /usr/bin/awk '{print $1}')
        omp_asset_prefix='mock://'
        [[ \${MOCK_OMP_ASSET_WRONG_ORIGIN:-0} != 1 ]] || omp_asset_prefix='https://example.invalid/'
        extra=''
        [[ \${MOCK_OMP_ASSET_EXTRA:-0} != 1 ]] || extra=',{"name":"unexpected","state":"uploaded","size":10,"digest":"sha256:'"$omp_digest"'","browser_download_url":"mock://unexpected"}'
        missing='{"name":"omp-linux-x64","state":"uploaded","size":11,"digest":"sha256:'"$omp_digest"'","browser_download_url":"'"$omp_asset_prefix"'omp-linux-x64"},'
        [[ \${MOCK_OMP_ASSET_MISSING:-0} != 1 ]] || missing=''
        size=11
        [[ \${MOCK_OMP_ASSET_ZERO:-0} != 1 ]] || size=0
        digest="sha256:$omp_digest"
        [[ \${MOCK_OMP_ASSET_DIGESTLESS:-0} != 1 ]] || digest='null'
        [[ $digest == null ]] || digest='"'"$digest"'"'
        cat <<JSON
{"tag_name":"t4code-1.2.3-appserver-1","html_url":"https://github.com/lyc-aon/oh-my-pi/releases/tag/t4code-1.2.3-appserver-1","draft":false,"prerelease":false,"assets":[
  $missing
  {"name":"omp-linux-arm64","state":"uploaded","size":$size,"digest":$digest,"browser_download_url":"\${omp_asset_prefix}omp-linux-arm64"},
  {"name":"omp-darwin-x64","state":"uploaded","size":11,"digest":"sha256:$omp_digest","browser_download_url":"\${omp_asset_prefix}omp-darwin-x64"},
  {"name":"omp-darwin-arm64","state":"uploaded","size":11,"digest":"sha256:$omp_digest","browser_download_url":"\${omp_asset_prefix}omp-darwin-arm64"},
  {"name":"omp-windows-x64.exe","state":"uploaded","size":11,"digest":"sha256:$omp_digest","browser_download_url":"\${omp_asset_prefix}omp-windows-x64.exe"}$extra
]}
JSON
        ;;
      */releases/tags/*)
        release_tag=\${endpoint##*/}
        release_version=\${release_tag#v}
        deb_digest=$(printf 'mock-deb\n' | /usr/bin/sha256sum | /usr/bin/awk '{print $1}')
        asset_digest=$(printf 'mock-asset\n' | /usr/bin/sha256sum | /usr/bin/awk '{print $1}')
        manifest=$(printf '%s  T4-Code-%s-android.apk\n%s  T4-Code-%s-linux-amd64.deb\n%s  T4-Code-%s-linux-x86_64.AppImage\n%s  T4-Code-%s-mac-arm64.dmg\n%s  T4-Code-%s-mac-arm64.zip\n' \
          "$asset_digest" "$release_version" "$deb_digest" "$release_version" "$asset_digest" "$release_version" \
          "$asset_digest" "$release_version" "$asset_digest" "$release_version")
        manifest_digest=$(printf '%s\n' "$manifest" | /usr/bin/sha256sum | /usr/bin/awk '{print $1}')
        cat <<JSON
{"tag_name":"$release_tag","html_url":"https://github.com/LycaonLLC/t4-code/releases/tag/$release_tag","draft":false,"prerelease":false,"assets":[
  {"name":"SHA256SUMS.txt","state":"uploaded","size":64,"digest":"sha256:$manifest_digest","browser_download_url":"mock://SHA256SUMS-$release_version.txt"},
  {"name":"T4-Code-$release_version-android.apk","state":"uploaded","size":64,"digest":"sha256:$asset_digest","browser_download_url":"mock://T4-Code-$release_version-android.apk"},
  {"name":"T4-Code-$release_version-linux-amd64.deb","state":"uploaded","size":64,"digest":"sha256:$deb_digest","browser_download_url":"mock://T4-Code-$release_version-linux-amd64.deb"},
  {"name":"T4-Code-$release_version-linux-x86_64.AppImage","state":"uploaded","size":64,"digest":"sha256:$asset_digest","browser_download_url":"mock://T4-Code-$release_version-linux-x86_64.AppImage"},
  {"name":"T4-Code-$release_version-mac-arm64.dmg","state":"uploaded","size":64,"digest":"sha256:$asset_digest","browser_download_url":"mock://T4-Code-$release_version-mac-arm64.dmg"},
  {"name":"T4-Code-$release_version-mac-arm64.zip","state":"uploaded","size":64,"digest":"sha256:$asset_digest","browser_download_url":"mock://T4-Code-$release_version-mac-arm64.zip"}
]}
JSON
        ;;
      *) printf '{}\n' ;;
    esac
    ;;

  curl)
    output=''
    url=''
    previous=''
    for argument in "$@"; do
      if [[ $previous == -o ]]; then output=$argument; fi
      [[ $argument == mock://* || $argument == http://* || $argument == https://* ]] && url=$argument
      previous=$argument
    done
    if [[ -n $output ]]; then
      mkdir -p -- "$(dirname -- "$output")"
      if [[ $url == *SHA256SUMS* ]]; then
        version=1.2.3
        [[ $url =~ SHA256SUMS-([0-9]+\.[0-9]+\.[0-9]+)\.txt ]] && version=\${BASH_REMATCH[1]}
        deb_digest=$(printf 'mock-deb\n' | /usr/bin/sha256sum | /usr/bin/awk '{print $1}')
        asset_digest=$(printf 'mock-asset\n' | /usr/bin/sha256sum | /usr/bin/awk '{print $1}')
        printf '%s  T4-Code-%s-android.apk\n%s  T4-Code-%s-linux-amd64.deb\n%s  T4-Code-%s-linux-x86_64.AppImage\n%s  T4-Code-%s-mac-arm64.dmg\n%s  T4-Code-%s-mac-arm64.zip\n' \
          "$asset_digest" "$version" "$deb_digest" "$version" "$asset_digest" "$version" \
          "$asset_digest" "$version" "$asset_digest" "$version" >"$output"
      elif [[ $url == *linux-amd64.deb ]]; then
        printf 'mock-deb\n' >"$output"
      elif [[ $url == mock://omp-* && \${MOCK_OMP_ASSET_UNREACHABLE:-0} == 1 ]]; then
        exit 22
      elif [[ $url == mock://omp-* && \${MOCK_OMP_ASSET_DIGEST_MISMATCH:-0} == 1 ]]; then
        printf 'mismatched-omp-asset\n' >"$output"
      else
        printf 'mock-asset\n' >"$output"
      fi
      exit 0
    fi
    if [[ $url == http://127.0.0.1:* ]]; then
      [[ $(read_state gateway-service inactive) == active ]] || exit 22
      [[ $(read_state gateway-health healthy) == healthy ]] || exit 22
      sessions=$(read_state active-sessions 0)
      identity=$(read_state deployment-identity "sha256:$(printf old | /usr/bin/sha256sum | /usr/bin/awk '{print $1}')")
      if [[ \${MOCK_STALE_LOOPBACK_IDENTITY:-0} == 1 ]]; then
        identity="sha256:$(printf stale-loopback | /usr/bin/sha256sum | /usr/bin/awk '{print $1}')"
      fi
      printf '{"ok":true,"web":true,"upstream":true,"transport":"local-unix","activeSessions":%s,"deploymentIdentity":"%s"}\n' "$sessions" "$identity"
      exit 0
    fi
    if [[ $url == https://* ]]; then
      if [[ $url == https://t4code.net/*assets/* ]]; then
        printf 'v1.2.3 t4code-1.2.3-appserver-1 T4-Code-1.2.3-android.apk T4-Code-1.2.3-linux-amd64.deb T4-Code-1.2.3-linux-x86_64.AppImage T4-Code-1.2.3-mac-arm64.dmg T4-Code-1.2.3-mac-arm64.zip\n'
        exit 0
      fi
      if [[ $url == https://t4code.net/* ]]; then
        printf '<script src="/assets/mock.js"></script>\n'
        exit 0
      fi
      [[ $(read_state tailnet-health healthy) == healthy ]] || exit 22
      identity=$(read_state deployment-identity "sha256:$(printf old | /usr/bin/sha256sum | /usr/bin/awk '{print $1}')")
      if [[ \${MOCK_STALE_TAILNET_IDENTITY:-0} == 1 ]]; then
        identity="sha256:$(printf stale | /usr/bin/sha256sum | /usr/bin/awk '{print $1}')"
      fi
      printf '{"ok":true,"web":true,"upstream":true,"transport":"local-unix","activeSessions":0,"deploymentIdentity":"%s"}\n' "$identity"
      exit 0
    fi
    ;;

  git)
    root=''
    if [[ \${1:-} == -C ]]; then
      root=$2
      shift 2
    fi
    if [[ \${1:-} == clone ]]; then
      destination=\${!#}
      mkdir -p -- "$destination"
      if [[ $destination == *omp-source ]]; then
        mkdir -p -- "$destination/packages/coding-agent/dist"
        printf 'omp\n' >"$destination/.mock-kind"
      else
        mkdir -p -- "$destination/compat" "$destination/scripts" \
          "$destination/apps/web/dist" \
          "$destination/node_modules/.pnpm/ws@mock/node_modules/ws"
        printf '{"version":"1.2.3"}\n' >"$destination/package.json"
        cat >"$destination/compat/omp-app-matrix.json" <<JSON
{"desktop":{"version":"1.2.3"},"verifiedRuntime":{"upstreamTag":"v1.2.3","upstreamCommit":"\${MOCK_UPSTREAM_COMMIT}","sourceTag":"t4code-1.2.3-appserver-1","sourceCommit":"\${MOCK_INTEGRATION_COMMIT}"}}
JSON
        printf 'service\n' >"$destination/scripts/tailnet-service.mjs"
        printf 'gateway\n' >"$destination/scripts/tailnet-gateway.mjs"
        printf '<html>built</html>\n' >"$destination/apps/web/dist/index.html"
        printf '{"name":"ws"}\n' >"$destination/node_modules/.pnpm/ws@mock/node_modules/ws/package.json"
        if [[ \${MOCK_WS_ESCAPE:-0} == 1 ]]; then
          ln -s -- "$state/escaping-ws" "$destination/node_modules/ws"
        else
          ln -s -- .pnpm/ws@mock/node_modules/ws "$destination/node_modules/ws"
        fi
        printf 't4\n' >"$destination/.mock-kind"
        write_state prepared 1
      fi
      exit 0
    fi
    case \${1:-} in
      init) exit 0 ;;
      rev-parse)
        if [[ $* == *refs/remotes/official/main* ]]; then
          printf '%s\n' "$MOCK_MAIN_COMMIT"
        elif [[ $* == *refs/remotes/fork/main* ]]; then
          if [[ -f $state/fork-main-synced ]]; then
            printf '%s\n' "$MOCK_MAIN_COMMIT"
          elif [[ \${MOCK_FORK_MAIN_RACE_ONCE:-0} == 1 && ! -f $state/fork-main-race-consumed ]]; then
            write_state fork-main-race-consumed 1
            printf '%s\n' "$MOCK_MAIN_COMMIT"
          elif [[ \${MOCK_FORK_MAIN_DIVERGED:-0} == 1 ]]; then
            printf '%040d\n' 9
          elif [[ \${MOCK_FORK_MAIN_BEHIND:-0} == 1 ]]; then
            printf '%s\n' "$MOCK_UPSTREAM_COMMIT"
          else
            printf '%s\n' "$MOCK_MAIN_COMMIT"
          fi
        elif [[ -f $root/.mock-kind && $(cat "$root/.mock-kind") == omp ]]; then
          printf '%s\n' "$MOCK_INTEGRATION_COMMIT"
        else
          printf '%s\n' "$MOCK_T4_COMMIT"
        fi
        ;;
      merge-base)
        if [[ $* == *refs/remotes/fork/main* && \${MOCK_FORK_MAIN_DIVERGED:-0} == 1 ]]; then
          exit 1
        fi
        if [[ \${MOCK_PRODUCT_BRANCH_MISSING:-0} == 1 && $* == *refs/remotes/origin/t4code/main* ]]; then
          exit 1
        fi
        exit 0
        ;;
      push)
        [[ \${MOCK_FORK_MAIN_PUSH_FAIL:-0} != 1 ]] || exit 1
        write_state fork-main-synced 1
        exit 0
        ;;
      hash-object) /usr/bin/git "$@" ;;
      diff|remote|fetch) exit 0 ;;
      *) exit 0 ;;
    esac
    ;;

  bun)
    if [[ \${*:-} == *'run build'* ]]; then
      candidate="$PWD/packages/coding-agent/dist/omp"
      mkdir -p -- "$(dirname -- "$candidate")"
      cat >"$candidate" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'omp-candidate' >>"$MOCK_CALLS"
printf '\t%q' "$@" >>"$MOCK_CALLS"
printf '\n' >>"$MOCK_CALLS"
case \${1:-} in
  --version) printf 'omp/1.2.3\n' ;;
  --smoke-test) exit 0 ;;
  appserver)
    case \${2:-} in
      status)
        [[ \${3:-} == --json ]] || exit 2
        printf '{"state":"running","health":{"ok":true,"hostId":"mock-host","epoch":"mock-epoch"}}\n'
        ;;
      drain-if-idle)
        if [[ \${3:-} == --help ]]; then
          printf 'drain-if-idle help\n'
          exit 0
        fi
        [[ \${3:-} == --json ]] || exit 2
        [[ \${MOCK_NEW_APP_DRAIN_UNSUPPORTED:-0} != 1 ]] || exit 2
        expected_host= expected_epoch=
        shift 3
        while (($#)); do
          case $1 in
            --expected-host-id) expected_host=$2; shift 2 ;;
            --expected-epoch) expected_epoch=$2; shift 2 ;;
            *) exit 2 ;;
          esac
        done
        if [[ $expected_host != mock-host || $expected_epoch != mock-epoch ]]; then
          if [[ \${MOCK_NEW_APP_DRAIN_MALFORMED:-0} == 1 ]]; then
            printf 'not-json\n'
          elif [[ \${MOCK_NEW_APP_DRAIN_WRONG_IDENTITY:-0} == 1 ]]; then
            printf '{"state":"identity_mismatch","health":{"ok":true,"hostId":"changed-host","epoch":"changed-epoch"}}\n'
          else
            printf '{"state":"identity_mismatch","health":{"ok":true,"hostId":"mock-host","epoch":"mock-epoch"}}\n'
          fi
          [[ \${MOCK_NEW_APP_DRAIN_WRONG_STATUS:-0} != 1 ]] || exit 0
          exit 75
        fi
        [[ \${MOCK_NEW_APP_DRAIN_BUSY:-0} != 1 ]] || exit 75
        if [[ \${MOCK_NEW_APP_DRAIN_IDENTITY_MISMATCH:-0} == 1 ]]; then
          host_id=changed-host
          epoch=changed-epoch
        else
          host_id=mock-host
          epoch=mock-epoch
        fi
        printf '{"state":"draining","health":{"ok":true,"hostId":"%s","epoch":"%s"},"busy":{"connections":0,"inflightMessages":0,"startingSupervisors":0,"lifecycleMutations":0,"sessionOperations":0,"activePrompts":0,"rpcSupervisorsWithPendingCalls":0,"busySessions":0,"openTerminalSessions":0,"pendingConfirmations":0,"outboundSends":0}}\n' "$host_id" "$epoch"
        ;;
      *) exit 2 ;;
    esac
    ;;
  *) exit 0 ;;
esac
SH
      chmod 0755 "$candidate"
    fi
    ;;

  pnpm)
    exit 0
    ;;

  omp)
    count=$(read_state sol-count 0)
    write_state sol-count $((count + 1))
    write_state sol-ran 1
    if [[ \${MOCK_SOL_BACKGROUND_HOLDER:-0} == 1 ]]; then
      (sleep 30) >/dev/null 2>&1 &
      write_state sol-background-pid $!
    fi
    if [[ -n \${MOCK_SOL_RESULT_SOURCE:-} ]]; then
      cp -- "$MOCK_SOL_RESULT_SOURCE" "$T4_MAINTENANCE_RESULT"
    fi
    exit \${MOCK_SOL_STATUS:-86}
    ;;

  node)
    script=\${1:-}
    action=\${2:-}
    if [[ $script == */scripts/tailnet-service.mjs && $action == install ]]; then
      runtime=$(dirname -- "$(dirname -- "$script")")
      shift 2
      origin='' port='' web_root='' app_socket='' label='' deployment_identity='' defer_start=false
      while (($#)); do
        case $1 in
          --defer-start) defer_start=true; shift ;;
          --origin) origin=$2; shift 2 ;;
          --port) port=$2; shift 2 ;;
          --web-root) web_root=$2; shift 2 ;;
          --app-socket) app_socket=$2; shift 2 ;;
          --label) label=$2; shift 2 ;;
          --deployment-identity) deployment_identity=$2; shift 2 ;;
          *) shift ;;
        esac
      done
      /usr/bin/jq -n \
        --arg sourceRoot "$runtime" \
        --arg nodeExecutable /usr/bin/node \
        --arg gatewayScript "$runtime/scripts/tailnet-gateway.mjs" \
        --arg allowedOrigin "$origin" \
        --argjson port "$port" \
        --arg appSocket "$app_socket" \
        --arg label "$label" \
        --arg deploymentIdentity "$deployment_identity" \
        --arg webRoot "$web_root" \
        '{
          sourceRoot:$sourceRoot,
          nodeExecutable:$nodeExecutable,
          gatewayScript:$gatewayScript,
          webRoot:$webRoot,
          allowedOrigin:$allowedOrigin,
          port:$port,
          appSocket:$appSocket,
          label:$label,
          deploymentIdentity:$deploymentIdentity
        }' \
        >"$MOCK_GATEWAY_CONFIG"
      printf 'new-unit\n' >"$MOCK_GATEWAY_UNIT"
      write_state deployment-identity "$deployment_identity"
      if [[ $defer_start == true ]]; then
        write_state gateway-enablement disabled
        write_state gateway-service inactive
      else
        write_state gateway-enablement enabled
        write_state gateway-service active
      fi
      write_state gateway-health healthy
      exit 0
    fi
    if [[ $script == */scripts/tailnet-service.mjs && $action == start ]]; then
      write_state gateway-enablement enabled
      write_state gateway-service active
      write_state gateway-health healthy
      exit 0
    fi
    if [[ $script == */scripts/tailnet-service.mjs && $action == status ]]; then
      [[ $(read_state gateway-service inactive) == active ]]
      exit
    fi
    exit 2
    ;;

  systemctl)
    args=("$@")
    filtered=()
    for argument in "\${args[@]}"; do
      [[ $argument == --user ]] || filtered+=("$argument")
    done
    command=\${filtered[0]:-}
    service=''
    for argument in "\${filtered[@]:1}"; do
      [[ $argument == *.service ]] && service=$argument
    done
    key=gateway-service
    [[ $service == "$MOCK_OMP_SERVICE" ]] && key=app-service
    case $command in
      is-active) [[ $(read_state "$key" inactive) == active ]] ;;
      is-enabled)
        enablement=$(read_state gateway-enablement disabled)
        printf '%s\n' "$enablement"
        [[ $enablement == enabled ]]
        ;;
      enable)
        write_state gateway-enablement enabled
        for argument in "\${filtered[@]:1}"; do
          if [[ $argument == --now ]]; then write_state "$key" active; fi
        done
        exit 0
        ;;
      disable)
        if [[ $key == gateway-service && \${MOCK_GATEWAY_DISABLE_FAIL_AFTER_FIRST:-0} == 1 ]]; then
          disable_count=$(read_state gateway-disable-count 0)
          disable_count=$((disable_count + 1))
          write_state gateway-disable-count "$disable_count"
          [[ $disable_count -le 1 ]] || exit 72
        fi
        write_state gateway-enablement disabled
        for argument in "\${filtered[@]:1}"; do
          if [[ $argument == --now ]]; then write_state "$key" inactive; fi
        done
        exit 0
        ;;
      show)
        if [[ $key == app-service && $(read_state "$key" inactive) == active ]]; then
          if [[ -f $state/mainpid-zero ]]; then printf '0\n'; else cat "$state/app-pid"; fi
        else
          printf '0\n'
        fi
        ;;
      stop) write_state "$key" inactive ;;
      start|restart)
        write_state "$key" active
        if [[ $key == app-service ]]; then
          rm -f -- "$state/mainpid-zero" "$state/app-drained"
          if [[ \${MOCK_APP_START_FAIL_ACTIVE:-0} == 1 && ! -f $state/app-start-failed-once ]]; then
            write_state app-start-failed-once 1
            exit 69
          fi
        fi
        exit 0
        ;;
      daemon-reload) exit 0 ;;
      *) exit 0 ;;
    esac
    ;;

  pgrep)
    if [[ \${1:-} == -x || \${1:-} == -f ]]; then
      if [[ -f $state/desktop-busy ]]; then exit 0; fi
      if [[ -f $state/busy-after-stage && -f $state/prepared ]]; then exit 0; fi
      exit 1
    fi
    if [[ \${1:-} == -P ]]; then
      [[ -f $state/child-busy ]]
      exit
    fi
    exit 1
    ;;

  sudo)
    count=$(read_state sudo-count 0)
    count=$((count + 1))
    write_state sudo-count "$count"
    [[ \${MOCK_SUDO_DENY:-0} != 1 ]] || exit 1
    [[ \${MOCK_SUDO_DENY_AFTER_FIRST:-0} != 1 || $count -le 1 ]] || exit 1
    [[ \${1:-} == -n ]] && shift
    exec "$@"
    ;;

  apt-get)
    for argument in "$@"; do
      [[ $argument != --simulate ]] || exit 0
    done
    count=$(read_state apt-count 0)
    count=$((count + 1))
    write_state apt-count "$count"
    if [[ \${MOCK_ROLLBACK_APT_FAIL:-0} == 1 && $count -gt 1 ]]; then exit 70; fi
    deb=\${!#}
    version=1.2.3
    [[ $deb =~ T4-Code-([0-9]+\.[0-9]+\.[0-9]+)-linux-amd64\.deb$ ]] && version=\${BASH_REMATCH[1]}
    write_state package-version "$version"
    mkdir -p -- "$(dirname -- "$MOCK_T4_EXECUTABLE")" "$MOCK_T4_WEB_ROOT"
    printf '#!/bin/sh\nexit 0\n' >"$MOCK_T4_EXECUTABLE"
    chmod 0755 "$MOCK_T4_EXECUTABLE"
    printf '<html>installed</html>\n' >"$MOCK_T4_WEB_ROOT/index.html"
    ;;

  dpkg-query)
    printf 'install ok installed\t%s\n' "$(read_state package-version 1.2.3)"
    ;;

  dpkg)
    if [[ -f $state/package-dirty ]]; then printf 'dirty\n'; fi
    ;;

  dpkg-deb)
    field=\${!#}
    if [[ $field == Package ]]; then
      printf 't4-code\n'
    else
      deb=\${*: -2:1}
      version=1.2.3
      [[ $deb =~ T4-Code-([0-9]+\.[0-9]+\.[0-9]+)-linux-amd64\.deb$ ]] && version=\${BASH_REMATCH[1]}
      printf '%s\n' "$version"
    fi
    ;;

  sha256sum)
    if [[ \${1:-} == /proc/*/exe ]]; then
      exec /usr/bin/sha256sum "$MOCK_OMP_TARGET"
    fi
    exec /usr/bin/sha256sum "$@"
    ;;

  *)
    printf 'unsupported mock tool: %s\n' "$tool" >&2
    exit 127
    ;;
esac
`.replaceAll("\\${", "${");

const mockLocalDeploy = String.raw`#!/usr/bin/env bash
set -euo pipefail
result=$1
receipt=$2
work=$3
printf 'local-deploy\t%q\t%q\t%q\n' "$result" "$receipt" "$work" >>"$MOCK_CALLS"
count=0
[[ ! -f $MOCK_STATE/local-deploy-count ]] || count=$(<"$MOCK_STATE/local-deploy-count")
printf '%s' "$((count + 1))" >"$MOCK_STATE/local-deploy-count"
[[ \${MOCK_LOCAL_DEPLOY_FAIL:-0} != 1 ]] || exit 75
mkdir -p -- "$(dirname -- "$receipt")" "$work"
mkdir -p -- \
  "$MOCK_RUNTIME_ROOT/scripts" \
  "$MOCK_RUNTIME_ROOT/apps/web/dist" \
  "$MOCK_RUNTIME_ROOT/node_modules/ws"
printf 'service\n' >"$MOCK_RUNTIME_ROOT/scripts/tailnet-service.mjs"
printf 'gateway\n' >"$MOCK_RUNTIME_ROOT/scripts/tailnet-gateway.mjs"
printf '<html>runner</html>\n' >"$MOCK_RUNTIME_ROOT/apps/web/dist/index.html"
printf '{"name":"ws"}\n' >"$MOCK_RUNTIME_ROOT/node_modules/ws/package.json"
printf 'new-unit\n' >"$MOCK_GATEWAY_UNIT"
cat >"$MOCK_OMP_TARGET" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case \${1:-} in
  --version) printf 'omp/1.2.3\n' ;;
  appserver)
    [[ \${2:-} == status && \${3:-} == --json ]] || exit 2
    printf '{"state":"running","health":{"ok":true,"hostId":"mock-host","epoch":"mock-epoch"}}\n'
    ;;
  *) exit 0 ;;
esac
SH
chmod 0755 "$MOCK_OMP_TARGET"
omp_sha=$(/usr/bin/sha256sum "$MOCK_OMP_TARGET" | /usr/bin/awk '{print $1}')
deployment_identity="sha256:$(printf '%s\0%s\0%s\0' "$MOCK_T4_COMMIT" "$MOCK_INTEGRATION_COMMIT" "$omp_sha" | /usr/bin/sha256sum | /usr/bin/awk '{print $1}')"
printf '1.2.3' >"$MOCK_STATE/package-version"
printf 'active' >"$MOCK_STATE/app-service"
printf 'active' >"$MOCK_STATE/gateway-service"
printf 'enabled' >"$MOCK_STATE/gateway-enablement"
printf 'healthy' >"$MOCK_STATE/gateway-health"
printf '%s' "$deployment_identity" >"$MOCK_STATE/deployment-identity"

gateway_script="$MOCK_RUNTIME_ROOT/scripts/tailnet-gateway.mjs"
web_root="$MOCK_RUNTIME_ROOT/apps/web/dist"
ws_root="$MOCK_RUNTIME_ROOT/node_modules/ws"
node_executable=/usr/bin/node
gateway_origin=https://mock.tailnet.ts.net
gateway_port=4319
gateway_socket=$(<"$MOCK_STATE/socket-path")
gateway_label=mock
/usr/bin/jq -n \
  --arg sourceRoot "$MOCK_RUNTIME_ROOT" \
  --arg allowedOrigin "$gateway_origin" \
  --argjson port "$gateway_port" \
  --arg appSocket "$gateway_socket" \
  --arg label "$gateway_label" \
  --arg nodeExecutable "$node_executable" \
  --arg gatewayScript "$gateway_script" \
  --arg webRoot "$web_root" \
  --arg deploymentIdentity "$deployment_identity" \
  '{
    sourceRoot: $sourceRoot,
    allowedOrigin: $allowedOrigin,
    port: $port,
    appSocket: $appSocket,
    label: $label,
    nodeExecutable: $nodeExecutable,
    gatewayScript: $gatewayScript,
    webRoot: $webRoot,
    deploymentIdentity: $deploymentIdentity
  }' >"$MOCK_GATEWAY_CONFIG"

tree_sha() {
  local root=$1 relative digest
  (
    cd -- "$root"
    while IFS= read -r -d '' relative; do
      digest=$(/usr/bin/sha256sum "$relative" | /usr/bin/awk '{print $1}')
      printf '%s\0%s\0' "$relative" "$digest"
    done < <(/usr/bin/find . -type f -print0 | LC_ALL=C /usr/bin/sort -z)
  ) | /usr/bin/sha256sum | /usr/bin/awk '{print $1}'
}

gateway_script_sha=$(/usr/bin/sha256sum "$gateway_script" | /usr/bin/awk '{print $1}')
web_tree_sha=$(tree_sha "$web_root")
ws_tree_sha=$(tree_sha "$ws_root")
config_sha=$(/usr/bin/sha256sum "$MOCK_GATEWAY_CONFIG" | /usr/bin/awk '{print $1}')
unit_sha=$(/usr/bin/sha256sum "$MOCK_GATEWAY_UNIT" | /usr/bin/awk '{print $1}')
/usr/bin/jq -n \
  --slurpfile publication "$result" \
  --arg omp_target "$MOCK_OMP_TARGET" \
  --arg omp_sha "$omp_sha" \
  --arg runtime_root "$MOCK_RUNTIME_ROOT" \
  --arg runtime_commit "$MOCK_T4_COMMIT" \
  --arg work "$work" \
  --arg gateway_script_sha "$gateway_script_sha" \
  --arg web_tree_sha "$web_tree_sha" \
  --arg ws_tree_sha "$ws_tree_sha" \
  --arg config_sha "$config_sha" \
  --arg unit_sha "$unit_sha" \
  --arg gateway_origin "$gateway_origin" \
  --argjson gateway_port "$gateway_port" \
  --arg gateway_socket "$gateway_socket" \
  --arg gateway_label "$gateway_label" \
  --arg deployment_identity "$deployment_identity" \
  --arg node_executable "$node_executable" '
  {
    schemaVersion: 1,
    status: "complete",
    upstream: $publication[0].upstream,
    integration: $publication[0].integration,
    t4: $publication[0].t4,
    omp: {
      target: $omp_target,
      version: "omp/1.2.3",
      installedSha256: $omp_sha,
      runningExecutableSha256: $omp_sha,
      previousSha256: $omp_sha,
      service: "mock-omp.service",
      mainPid: 1,
      health: "healthy",
      hostId: "mock-host",
      epoch: "mock-epoch"
    },
    desktop: {
      package: "t4-code",
      installedVersion: "1.2.3",
      previousVersion: "1.2.2",
      debSha256: $omp_sha,
      dpkgVerification: "clean"
    },
    gateway: {
      service: "mock-gateway.service",
      activeState: "active",
      health: "healthy",
      helperStatus: "healthy",
      loopbackHealth: "healthy",
      tailnetHealth: "pending",
      runtimeSourceRoot: $runtime_root,
      runtimeCommit: $runtime_commit,
      allowedOrigin: $gateway_origin,
      port: $gateway_port,
      appSocket: $gateway_socket,
      label: $gateway_label,
        nodeExecutable: $node_executable,
        deploymentIdentity: $deployment_identity,
      artifacts: {
        gatewayScriptSha256: $gateway_script_sha,
        webTreeSha256: $web_tree_sha,
        wsTreeSha256: $ws_tree_sha,
        configSha256: $config_sha,
        unitSha256: $unit_sha
      }
    },
    rollback: {available: true, backupDirectory: $work}
  }
' >"$receipt"
`.replaceAll("\\${", "${");

function forgedOmpPublicProof() {
  const digest = createHash("sha256").update("mock-asset\n").digest("hex");
  const canonical = {
    tagName: "t4code-1.2.3-appserver-1",
    htmlUrl:
      "https://github.com/lyc-aon/oh-my-pi/releases/tag/t4code-1.2.3-appserver-1",
    assets: [
      "omp-linux-x64",
      "omp-linux-arm64",
      "omp-darwin-x64",
      "omp-darwin-arm64",
      "omp-windows-x64.exe",
    ]
      .sort()
      .map((name) => ({
        name,
        state: "uploaded",
        size: 11,
        digest: `sha256:${digest}`,
        browserDownloadUrl: `mock://${name}`,
      })),
  };
  const canonicalJson = spawnSync("/usr/bin/jq", ["-cS", "."], {
    encoding: "utf8",
    input: JSON.stringify(canonical),
  });
  assert.equal(canonicalJson.status, 0, canonicalJson.stderr);
  return {
    verifiedAt: "2099-01-01T00:00:00Z",
    fingerprint: `sha256:${createHash("sha256").update(canonicalJson.stdout.trim()).digest("hex")}`,
    canonical,
  };
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function waitForPath(path) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await pathExists(path)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function createDeployFixture(options = {}) {
  const previousVersion = options.sameVersion ? "1.2.3" : "1.2.2";
  const root = await mkdtemp(join(tmpdir(), "t4-maintainer-contract-"));
  const home = join(root, "home");
  const state = join(root, "mock-state");
  const bin = join(root, "bin");
  const maintainerRoot = join(root, "maintainer");
  const runRoot = join(maintainerRoot, "runs", "fixture");
  const work = join(runRoot, "local-work");
  const result = join(runRoot, "result.json");
  const receipt = join(runRoot, "local-deployment.json");
  const calls = join(root, "calls.log");
  const ompTarget = join(home, "bin", "omp");
  const socket = join(root, "runtime", "omp.sock");
  const gatewayConfig = join(home, ".config", "t4-code", "tailnet-gateway.json");
  const gatewayService = "mock-gateway.service";
  const ompService = "mock-omp.service";
  const gatewayUnit = join(home, ".config", "systemd", "user", gatewayService);
  const t4Executable = join(root, "opt", "T4 Code", "t4-code");
  const t4WebRoot = join(root, "opt", "T4 Code", "resources", "web");
  const deployments = join(maintainerRoot, "deployments");

  await mkdir(dirname(ompTarget), { recursive: true });
  await mkdir(dirname(socket), { recursive: true });
  await mkdir(dirname(gatewayConfig), { recursive: true });
  await mkdir(dirname(gatewayUnit), { recursive: true });
  await mkdir(t4WebRoot, { recursive: true });
  await mkdir(runRoot, { recursive: true });
  await mkdir(state, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(calls, "");

  await writeFile(
    result,
    `${JSON.stringify({
      upstream: { tag: "v1.2.3", commit: upstreamCommit },
      integration: { tag: "t4code-1.2.3-appserver-1", commit: integrationCommit },
      t4: { version: "1.2.3", tag: "v1.2.3", commit: t4Commit },
      release: { url: "https://github.com/LycaonLLC/t4-code/releases/tag/v1.2.3" },
      site: { url: "https://t4code.net", releaseTag: "v1.2.3" },
    })}\n`,
  );
  await writeFile(
    ompTarget,
    `#!/usr/bin/env bash
set -euo pipefail
printf 'omp-target' >>"$MOCK_CALLS"
printf '\\t%q' "$@" >>"$MOCK_CALLS"
printf '\\n' >>"$MOCK_CALLS"
case \${1:-} in
  --version) printf 'omp/1.2.2\\n' ;;
  appserver)
    case \${2:-} in
      status)
        [[ \${3:-} == --json ]] || exit 2
        if [[ \${MOCK_DRAIN_CONSTANT_IDENTITY:-0} == 1 ]]; then
          printf '{"state":"running","health":{"ok":true,"hostId":"t4-maintainer-capability-probe","epoch":"t4-maintainer-capability-probe"}}\\n'
        else
          printf '{"state":"running","health":{"ok":true,"hostId":"old-host","epoch":"old-epoch"}}\\n'
        fi
        ;;
      drain-if-idle)
        if [[ \${3:-} == --help ]]; then
          [[ \${MOCK_DRAIN_CAPABILITY_MISSING:-0} != 1 ]] || exit 2
          if [[ \${MOCK_DRAIN_GENERIC_HELP:-0} == 1 ]]; then
            printf 'generic appserver help\\n'
            exit 0
          fi
          printf 'drain-if-idle help\\n'
          exit 0
        fi
        [[ \${3:-} == --json ]] || exit 2
        if [[ \${5:-} == t4-maintainer-capability-host-* &&
              \${7:-} == t4-maintainer-capability-epoch-* ]]; then
          if [[ \${MOCK_DRAIN_PROBE_WRONG_IDENTITY:-0} == 1 ]]; then
            host_id=changed-host
            epoch=changed-epoch
          elif [[ \${MOCK_DRAIN_CONSTANT_IDENTITY:-0} == 1 ]]; then
            host_id=t4-maintainer-capability-probe
            epoch=t4-maintainer-capability-probe
          else
            host_id=old-host
            epoch=old-epoch
          fi
          printf '{"state":"identity_mismatch","health":{"ok":true,"hostId":"%s","epoch":"%s"}}\\n' "$host_id" "$epoch"
          if [[ \${MOCK_DRAIN_PROBE_WRONG_STATUS:-0} == 1 ]]; then exit 0; fi
          exit 75
        fi
        [[ \${MOCK_DRAIN_BUSY:-0} != 1 ]] || exit 75
        printf '1' >"$MOCK_STATE/app-drained"
        if [[ \${MOCK_DRAIN_IDENTITY_MISMATCH:-0} == 1 ]]; then
          printf '{"state":"draining","health":{"ok":true,"hostId":"changed-host","epoch":"changed-epoch"},"busy":{"connections":0,"inflightMessages":0,"startingSupervisors":0,"lifecycleMutations":0,"sessionOperations":0,"activePrompts":0,"rpcSupervisorsWithPendingCalls":0,"busySessions":0,"openTerminalSessions":0,"pendingConfirmations":0,"outboundSends":0}}\\n'
        elif [[ \${MOCK_DRAIN_CONSTANT_IDENTITY:-0} == 1 ]]; then
          printf '{"state":"draining","health":{"ok":true,"hostId":"t4-maintainer-capability-probe","epoch":"t4-maintainer-capability-probe"},"busy":{"connections":0,"inflightMessages":0,"startingSupervisors":0,"lifecycleMutations":0,"sessionOperations":0,"activePrompts":0,"rpcSupervisorsWithPendingCalls":0,"busySessions":0,"openTerminalSessions":0,"pendingConfirmations":0,"outboundSends":0}}\\n'
        else
          printf '{"state":"draining","health":{"ok":true,"hostId":"old-host","epoch":"old-epoch"},"busy":{"connections":0,"inflightMessages":0,"startingSupervisors":0,"lifecycleMutations":0,"sessionOperations":0,"activePrompts":0,"rpcSupervisorsWithPendingCalls":0,"busySessions":0,"openTerminalSessions":0,"pendingConfirmations":0,"outboundSends":0}}\\n'
        fi
        ;;
      *) exit 2 ;;
    esac
    ;;
  *) exit 0 ;;
esac
`,
  );
  await chmod(ompTarget, 0o751);
  await writeFile(t4Executable, "#!/bin/sh\nexit 0\n");
  await chmod(t4Executable, 0o755);
  await writeFile(join(t4WebRoot, "index.html"), "old-web\n");
  await writeFile(
    gatewayConfig,
    `${JSON.stringify({
      sourceRoot: join(root, "previous-runtime"),
      allowedOrigin: "https://mock.tailnet.ts.net",
      port: 4319,
      appSocket: socket,
      label: "mock",
    })}\n`,
  );
  await writeFile(gatewayUnit, "old-unit\n");
  await writeFile(join(state, "package-version"), previousVersion);
  await writeFile(join(state, "active-sessions"), String(options.activeSessions ?? 0));
  await writeFile(join(state, "gateway-health"), options.gatewayHealthy === false ? "unhealthy" : "healthy");
  await writeFile(join(state, "tailnet-health"), "healthy");
  await writeFile(join(state, "socket-path"), socket);
  await writeFile(join(state, "app-service"), options.appActive === false ? "inactive" : "active");
  await writeFile(
    join(state, "gateway-service"),
    options.gatewayActive === false ? "inactive" : "active",
  );
  await writeFile(
    join(state, "gateway-enablement"),
    options.gatewayEnabled === false ? "disabled" : "enabled",
  );
  await mkdir(join(state, "escaping-ws"), { recursive: true });
  await writeFile(join(state, "escaping-ws", "package.json"), "{}\n");
  if (options.desktopBusy) await writeFile(join(state, "desktop-busy"), "1");
  if (options.childBusy) await writeFile(join(state, "child-busy"), "1");
  if (options.mainPidZero) await writeFile(join(state, "mainpid-zero"), "1");
  if (options.busyAfterStage) await writeFile(join(state, "busy-after-stage"), "1");

  const dispatcher = join(bin, "mock-tool");
  await writeFile(dispatcher, mockDispatcher);
  await chmod(dispatcher, 0o755);
  for (const tool of [
    "gh",
    "curl",
    "git",
    "bun",
    "pnpm",
    "omp",
    "node",
    "systemctl",
    "pgrep",
    "sudo",
    "apt-get",
    "dpkg-query",
    "dpkg",
    "dpkg-deb",
    "sha256sum",
  ]) {
    await symlink(dispatcher, join(bin, tool));
  }

  const socketProcess = spawn(
    process.execPath,
    [
      "-e",
      "const net=require('node:net');const fs=require('node:fs');const p=process.env.SOCKET;try{fs.unlinkSync(p)}catch{};net.createServer(()=>{}).listen(p)",
    ],
    { env: { ...process.env, SOCKET: socket }, stdio: "ignore" },
  );
  await waitForPath(socket);
  await writeFile(join(state, "app-pid"), `${socketProcess.pid}\n`);

  const env = {
    ...process.env,
    HOME: home,
    XDG_RUNTIME_DIR: dirname(socket),
    PATH: `${bin}:${process.env.PATH}`,
    MOCK_STATE: state,
    MOCK_CALLS: calls,
    MOCK_UPSTREAM_COMMIT: upstreamCommit,
    MOCK_INTEGRATION_COMMIT: integrationCommit,
    MOCK_T4_COMMIT: t4Commit,
    MOCK_MAIN_COMMIT: mainCommit,
    MOCK_UPSTREAM_TAG_OBJECT: upstreamTagObject,
    MOCK_INTEGRATION_TAG_OBJECT: integrationTagObject,
    MOCK_OMP_TARGET: ompTarget,
    MOCK_OMP_SERVICE: ompService,
    MOCK_GATEWAY_CONFIG: gatewayConfig,
    MOCK_GATEWAY_UNIT: gatewayUnit,
    MOCK_T4_EXECUTABLE: t4Executable,
    MOCK_T4_WEB_ROOT: t4WebRoot,
    T4_MAINTAINER_ROOT: maintainerRoot,
    T4_MAINTAINER_TEST_MODE: "1",
    T4_MAINTAINER_GH: join(bin, "gh"),
    T4_MAINTAINER_CURL: join(bin, "curl"),
    T4_MAINTAINER_JQ: "/usr/bin/jq",
    T4_MAINTAINER_GIT: join(bin, "git"),
    T4_MAINTAINER_BUN: join(bin, "bun"),
    T4_MAINTAINER_PNPM: join(bin, "pnpm"),
    T4_MAINTAINER_NODE: join(bin, "node"),
    T4_MAINTAINER_SUDO: join(bin, "sudo"),
    T4_MAINTAINER_APT_GET: join(bin, "apt-get"),
    T4_MAINTAINER_DPKG_QUERY: join(bin, "dpkg-query"),
    T4_MAINTAINER_DPKG: join(bin, "dpkg"),
    T4_MAINTAINER_DPKG_DEB: join(bin, "dpkg-deb"),
    T4_MAINTAINER_SHA256SUM: join(bin, "sha256sum"),
    T4_MAINTAINER_SYSTEMCTL: join(bin, "systemctl"),
    T4_MAINTAINER_INSTALL: "/usr/bin/install",
    T4_MAINTAINER_SYNC: "/usr/bin/sync",
    T4_LOCAL_OMP_TARGET: ompTarget,
    T4_LOCAL_OMP_SERVICE: ompService,
    T4_LOCAL_OMP_SOCKET: socket,
    T4_LOCAL_T4_EXECUTABLE: t4Executable,
    T4_LOCAL_T4_WEB_ROOT: t4WebRoot,
    T4_LOCAL_GATEWAY_SERVICE: gatewayService,
    T4_LOCAL_GATEWAY_CONFIG: gatewayConfig,
    T4_LOCAL_GATEWAY_UNIT: gatewayUnit,
    T4_LOCAL_DEPLOYMENTS_DIR: deployments,
    T4_LOCAL_HEALTH_ATTEMPTS: "1",
    T4_LOCAL_HEALTH_INTERVAL_SECONDS: "1",
    T4_LOCAL_MAIN_MIRROR_ATTEMPTS: "2",
    T4_LOCAL_MAIN_MIRROR_INTERVAL_SECONDS: "1",
    ...(options.wsEscape ? { MOCK_WS_ESCAPE: "1" } : {}),
    ...(options.rollbackAptFail ? { MOCK_ROLLBACK_APT_FAIL: "1" } : {}),
    ...(options.noSudo ? { MOCK_SUDO_DENY: "1" } : {}),
    ...(options.sudoExpires ? { MOCK_SUDO_DENY_AFTER_FIRST: "1" } : {}),
    ...(options.drainCapabilityMissing ? { MOCK_DRAIN_CAPABILITY_MISSING: "1" } : {}),
    ...(options.drainGenericHelp ? { MOCK_DRAIN_GENERIC_HELP: "1" } : {}),
    ...(options.drainProbeWrongStatus ? { MOCK_DRAIN_PROBE_WRONG_STATUS: "1" } : {}),
    ...(options.drainProbeWrongIdentity ? { MOCK_DRAIN_PROBE_WRONG_IDENTITY: "1" } : {}),
    ...(options.drainConstantIdentity ? { MOCK_DRAIN_CONSTANT_IDENTITY: "1" } : {}),
    ...(options.drainBusy ? { MOCK_DRAIN_BUSY: "1" } : {}),
    ...(options.drainIdentityMismatch ? { MOCK_DRAIN_IDENTITY_MISMATCH: "1" } : {}),
    ...(options.newAppDrainBusy ? { MOCK_NEW_APP_DRAIN_BUSY: "1" } : {}),
    ...(options.newAppDrainIdentityMismatch
      ? { MOCK_NEW_APP_DRAIN_IDENTITY_MISMATCH: "1" }
      : {}),
    ...(options.newAppDrainUnsupported ? { MOCK_NEW_APP_DRAIN_UNSUPPORTED: "1" } : {}),
    ...(options.newAppDrainMalformed ? { MOCK_NEW_APP_DRAIN_MALFORMED: "1" } : {}),
    ...(options.newAppDrainWrongStatus ? { MOCK_NEW_APP_DRAIN_WRONG_STATUS: "1" } : {}),
    ...(options.newAppDrainWrongIdentity ? { MOCK_NEW_APP_DRAIN_WRONG_IDENTITY: "1" } : {}),
    ...(options.appStartFailsActive ? { MOCK_APP_START_FAIL_ACTIVE: "1" } : {}),
    ...(options.forkMainDiverged ? { MOCK_FORK_MAIN_DIVERGED: "1" } : {}),
    ...(options.forkMainBehind ? { MOCK_FORK_MAIN_BEHIND: "1" } : {}),
    ...(options.forkMainRaceOnce ? { MOCK_FORK_MAIN_RACE_ONCE: "1" } : {}),
    ...(options.forkMainPushFail ? { MOCK_FORK_MAIN_PUSH_FAIL: "1" } : {}),
    ...(options.forkWorkflowDisableFail ? { MOCK_FORK_WORKFLOW_DISABLE_FAIL: "1" } : {}),
    ...(options.forkWorkflowEnableFail ? { MOCK_FORK_WORKFLOW_ENABLE_FAIL: "1" } : {}),
    ...(options.forkBaseTagMissing ? { MOCK_FORK_BASE_TAG_MISSING: "1" } : {}),
    ...(options.forkBaseTagMismatch ? { MOCK_FORK_BASE_TAG_MISMATCH: "1" } : {}),
    ...(options.staleLoopbackIdentity ? { MOCK_STALE_LOOPBACK_IDENTITY: "1" } : {}),
    ...(options.staleTailnetIdentity ? { MOCK_STALE_TAILNET_IDENTITY: "1" } : {}),
    ...(options.gatewayDisableFailAfterFirst
      ? { MOCK_GATEWAY_DISABLE_FAIL_AFTER_FIRST: "1" }
      : {}),
    ...(options.productBranchMissing ? { MOCK_PRODUCT_BRANCH_MISSING: "1" } : {}),
  };

  return {
    root,
    state,
    maintainerRoot,
    work,
    result,
    receipt,
    calls,
    ompTarget,
    gatewayConfig,
    gatewayUnit,
    deployments,
    env,
    initial: {
      omp: await readFile(ompTarget),
      ompMode: (await lstat(ompTarget)).mode & 0o777,
      gatewayConfig: await readFile(gatewayConfig),
      gatewayUnit: await readFile(gatewayUnit),
      packageVersion: previousVersion,
      appService: options.appActive === false ? "inactive" : "active",
      gatewayService: options.gatewayActive === false ? "inactive" : "active",
      gatewayEnablement: options.gatewayEnabled === false ? "disabled" : "enabled",
    },
    run(extraEnv = {}) {
      return spawnSync("/usr/bin/bash", [deployScript, result, receipt, work], {
        encoding: "utf8",
        env: { ...env, ...extraEnv },
        timeout: 20_000,
      });
    },
    async callsText() {
      return readFile(calls, "utf8");
    },
    async cleanup() {
      socketProcess.kill("SIGTERM");
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function createRunnerFixture(options = {}) {
  const fixture = await createDeployFixture({
    sameVersion: true,
    forkMainDiverged: options.forkMainDiverged,
    forkMainBehind: options.forkMainBehind,
    forkMainRaceOnce: options.forkMainRaceOnce,
    forkMainPushFail: options.forkMainPushFail,
    forkWorkflowDisableFail: options.forkWorkflowDisableFail,
    forkWorkflowEnableFail: options.forkWorkflowEnableFail,
    forkBaseTagMissing: options.forkBaseTagMissing,
    forkBaseTagMismatch: options.forkBaseTagMismatch,
    staleLoopbackIdentity: options.staleLoopbackIdentity,
    staleTailnetIdentity: options.staleTailnetIdentity,
    ompWorkflowMissing: options.ompWorkflowMissing,
    ompWorkflowFailed: options.ompWorkflowFailed,
    ompWorkflowWrongPath: options.ompWorkflowWrongPath,
    ompAssetMissing: options.ompAssetMissing,
    ompAssetExtra: options.ompAssetExtra,
    ompAssetZero: options.ompAssetZero,
    ompAssetDigestless: options.ompAssetDigestless,
    ompAssetDigestMismatch: options.ompAssetDigestMismatch,
    ompAssetUnreachable: options.ompAssetUnreachable,
    ompAssetWrongOrigin: options.ompAssetWrongOrigin,
  });
  const localDeploy = join(fixture.root, "bin", "local-deploy");
  const prompt = join(fixture.root, "prompt.md");
  const runtimeRoot = join(fixture.root, "runner-runtime");
  await writeFile(localDeploy, mockLocalDeploy);
  await chmod(localDeploy, 0o755);
  await writeFile(prompt, "Maintain the verified compatibility publication.\n");
  await mkdir(join(runtimeRoot, "scripts"), { recursive: true });
  await mkdir(join(runtimeRoot, "apps", "web", "dist"), { recursive: true });
  await mkdir(join(runtimeRoot, "node_modules", "ws"), { recursive: true });
  await writeFile(join(runtimeRoot, ".mock-kind"), "t4\n");
  await writeFile(join(runtimeRoot, "scripts", "tailnet-service.mjs"), "service\n");
  await writeFile(join(runtimeRoot, "scripts", "tailnet-gateway.mjs"), "gateway\n");
  await writeFile(join(runtimeRoot, "apps", "web", "dist", "index.html"), "<html>runner</html>\n");
  await writeFile(join(runtimeRoot, "node_modules", "ws", "package.json"), '{"name":"ws"}\n');
  const atomicState = join(fixture.maintainerRoot, "state", "atomic-publication");
  const atomicReceiptDirectory = join(atomicState, "t4code-1.2.3-appserver-1");
  await mkdir(atomicReceiptDirectory, { recursive: true });
  const atomicIntentPath = join(atomicReceiptDirectory, "intent.json");
  await writeFile(
    atomicIntentPath,
    `${JSON.stringify({
      schemaVersion: 1,
      createdAt: "2026-07-15T00:00:00Z",
      upstream: { tag: "v1.2.3", commit: upstreamCommit },
      integrationTag: "t4code-1.2.3-appserver-1",
      before: { baseTagObject: "", integrationTagObject: "", productCommit: "" },
      desired: {
        baseTagObject: upstreamTagObject,
        integrationTagObject,
        productCommit: integrationCommit,
      },
      atomicRefspecs: [
        "official-base-tag",
        "t4code/main",
        "annotated-integration-tag",
      ],
    })}\n`,
  );
  const intentHash = spawnSync("/usr/bin/git", ["hash-object", atomicIntentPath], {
    encoding: "utf8",
  });
  assert.equal(intentHash.status, 0, intentHash.stderr);
  await writeFile(
    join(atomicReceiptDirectory, "receipt.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      completedAt: "2026-07-15T00:00:00Z",
      helperOwned: true,
      atomicPush: true,
      pushedRefCount: 3,
      productionRemoteIdentity: true,
      officialRepository: "can1357/oh-my-pi",
      forkRepository: "lyc-aon/oh-my-pi",
      upstream: {
        tag: "v1.2.3",
        commit: upstreamCommit,
        tagObject: upstreamTagObject,
      },
      product: { branch: "t4code/main", commit: integrationCommit },
      integration: {
        tag: "t4code-1.2.3-appserver-1",
        tagObject: integrationTagObject,
        commit: integrationCommit,
      },
      intentObject: intentHash.stdout.trim(),
    })}\n`,
  );
  const runnerEnv = {
    ...fixture.env,
    MOCK_RUNTIME_ROOT: runtimeRoot,
    T4_MAINTAINER_OMP: join(fixture.root, "bin", "omp"),
    T4_MAINTAINER_LOCAL_DEPLOY: localDeploy,
    T4_MAINTAINER_PROMPT_FILE: prompt,
    T4_MAINTAINER_VERIFY_ATTEMPTS: "1",
    T4_MAINTAINER_VERIFY_INTERVAL_SECONDS: "1",
    T4_MAINTAINER_ATOMIC_STATE_DIR: atomicState,
    ...(options.localDeployFail ? { MOCK_LOCAL_DEPLOY_FAIL: "1" } : {}),
    ...(options.publicIncompatible ? { MOCK_PUBLIC_INCOMPATIBLE: "1" } : {}),
    ...(options.mainIncompatible ? { MOCK_MAIN_INCOMPATIBLE: "1" } : {}),
    ...(options.workflowsTerminal ? { MOCK_WORKFLOWS_TERMINAL: "1" } : {}),
    ...(options.workflowsActive ? { MOCK_WORKFLOWS_ACTIVE: "1" } : {}),
    ...(options.t4WorkflowWrongPath ? { MOCK_T4_WORKFLOW_WRONG_PATH: "1" } : {}),
    ...(options.ompWorkflowMissing ? { MOCK_OMP_WORKFLOW_MISSING: "1" } : {}),
    ...(options.ompWorkflowFailed ? { MOCK_OMP_WORKFLOW_FAILED: "1" } : {}),
    ...(options.ompWorkflowWrongPath ? { MOCK_OMP_WORKFLOW_WRONG_PATH: "1" } : {}),
    ...(options.ompAssetMissing ? { MOCK_OMP_ASSET_MISSING: "1" } : {}),
    ...(options.ompAssetExtra ? { MOCK_OMP_ASSET_EXTRA: "1" } : {}),
    ...(options.ompAssetZero ? { MOCK_OMP_ASSET_ZERO: "1" } : {}),
    ...(options.ompAssetDigestless ? { MOCK_OMP_ASSET_DIGESTLESS: "1" } : {}),
    ...(options.ompAssetDigestMismatch ? { MOCK_OMP_ASSET_DIGEST_MISMATCH: "1" } : {}),
    ...(options.ompAssetUnreachable ? { MOCK_OMP_ASSET_UNREACHABLE: "1" } : {}),
    ...(options.ompAssetWrongOrigin ? { MOCK_OMP_ASSET_WRONG_ORIGIN: "1" } : {}),
    ...(options.productBranchMissing ? { MOCK_PRODUCT_BRANCH_MISSING: "1" } : {}),
  };

  return {
    ...fixture,
    runnerEnv,
    runtimeRoot,
    pending: join(fixture.maintainerRoot, "state", "pending.json"),
    processed: join(fixture.maintainerRoot, "state", "processed.json"),
    localApplied: join(fixture.maintainerRoot, "state", "local-applied.json"),
    async seedPending() {
      await mkdir(join(fixture.maintainerRoot, "state"), { recursive: true });
      const publication = JSON.parse(await readFile(fixture.result, "utf8"));
      await writeFile(
        join(fixture.maintainerRoot, "state", "pending.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          publicVerifiedAt: "2026-07-15T00:00:00Z",
          publicationRunId: "mock-publication",
          publication,
        })}\n`,
      );
    },
    runRunner(extraEnv = {}, args = []) {
      return spawnSync("/usr/bin/bash", [runnerScript, ...args], {
        encoding: "utf8",
        env: { ...runnerEnv, ...extraEnv },
        timeout: 20_000,
      });
    },
  };
}

async function assertRestored(fixture, { blocked = false } = {}) {
  assert.deepEqual(await readFile(fixture.ompTarget), fixture.initial.omp);
  assert.equal((await lstat(fixture.ompTarget)).mode & 0o777, fixture.initial.ompMode);
  assert.deepEqual(await readFile(fixture.gatewayConfig), fixture.initial.gatewayConfig);
  assert.deepEqual(await readFile(fixture.gatewayUnit), fixture.initial.gatewayUnit);
  assert.equal(
    (await readFile(join(fixture.state, "package-version"), "utf8")).trim(),
    fixture.initial.packageVersion,
  );
  assert.equal(
    (await readFile(join(fixture.state, "app-service"), "utf8")).trim(),
    fixture.initial.appService,
  );
  assert.equal(
    (await readFile(join(fixture.state, "gateway-service"), "utf8")).trim(),
    fixture.initial.gatewayService,
  );
  assert.equal(
    (await readFile(join(fixture.state, "gateway-enablement"), "utf8")).trim(),
    fixture.initial.gatewayEnablement,
  );
  assert.equal(await pathExists(fixture.receipt), false);
  const marker = join(fixture.maintainerRoot, "state", "deployment-blocked.json");
  const markerExists = await pathExists(marker);
  assert.equal(
    markerExists,
    blocked,
    markerExists
      ? `${await readFile(marker, "utf8")}\n${await fixture.callsText()}`
      : "deployment marker unexpectedly absent",
  );
}

test("busy preflight performs no mutation or artifact staging", async (t) => {
  for (const [name, options] of [
    ["desktop", { desktopBusy: true }],
    ["gateway session", { activeSessions: 2 }],
    ["appserver child", { childBusy: true }],
  ]) {
    await t.test(name, async (subtest) => {
      const fixture = await createDeployFixture(options);
      subtest.after(() => fixture.cleanup());
      const result = fixture.run();
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const calls = await fixture.callsText();
      assert.doesNotMatch(calls, /^(?:git|bun|pnpm|apt-get)\t/mu);
      assert.doesNotMatch(calls, /^systemctl\t.*(?:stop|start|restart)/mu);
      assert.equal(await pathExists(fixture.deployments), false);
      assert.equal(await pathExists(join(fixture.work, "omp-source")), false);
      assert.equal(await pathExists(join(fixture.work, "downloads")), false);
      assert.equal(await pathExists(join(fixture.work, "rollback")), false);
      await assertRestored(fixture);
    });
  }
});

test("missing noninteractive sudo authority rejects before staging", async (t) => {
  const fixture = await createDeployFixture({ noSudo: true });
  t.after(() => fixture.cleanup());
  const result = fixture.run();
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const calls = await fixture.callsText();
  assert.match(calls, /^sudo\t-n\ttrue$/mu);
  assert.doesNotMatch(calls, /^(?:git|bun|pnpm|apt-get)\t/mu);
  assert.doesNotMatch(calls, /^systemctl\t.*(?:stop|start|restart)/mu);
  assert.equal(await pathExists(fixture.deployments), false);
  assert.equal(await pathExists(join(fixture.work, "omp-source")), false);
  assert.equal(await pathExists(join(fixture.work, "downloads")), false);
  assert.equal(await pathExists(join(fixture.work, "rollback")), false);
  await assertRestored(fixture);
});

test("expired sudo authority rejects at the second guard before transaction mutation", async (t) => {
  const fixture = await createDeployFixture({ sudoExpires: true });
  t.after(() => fixture.cleanup());
  const result = fixture.run();
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const calls = await fixture.callsText();
  assert.equal(calls.split("\n").filter((line) => line === "sudo\t-n\ttrue").length, 2, calls);
  assert.match(calls, /^git\t.*clone/mu);
  assert.doesNotMatch(calls, /^apt-get\t/mu);
  assert.doesNotMatch(calls, /^systemctl\t.*(?:stop|start|restart)/mu);
  assert.equal(await pathExists(join(fixture.work, "omp-source")), false);
  assert.equal(await pathExists(join(fixture.work, "downloads")), false);
  assert.equal(await pathExists(join(fixture.work, "rollback")), false);
  await assertRestored(fixture);
});

test("missing or generic atomic-drain help rejects before staging", async (t) => {
  for (const [name, options] of [
    ["nonzero unsupported command", { drainCapabilityMissing: true }],
    ["exit-zero generic appserver help", { drainGenericHelp: true }],
  ]) {
    await t.test(name, async (subtest) => {
      const fixture = await createDeployFixture(options);
      subtest.after(() => fixture.cleanup());
      const result = fixture.run();
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const calls = await fixture.callsText();
      assert.match(calls, /^omp-target\tappserver\tdrain-if-idle\t--help$/mu);
      assert.doesNotMatch(calls, /^(?:git|bun|pnpm|apt-get)\t/mu);
      assert.doesNotMatch(calls, /^systemctl\t.*(?:stop|start|restart)/mu);
      assert.equal(await pathExists(join(fixture.work, "omp-source")), false);
      assert.equal(await pathExists(join(fixture.work, "downloads")), false);
      assert.equal(await pathExists(join(fixture.work, "rollback")), false);
      await assertRestored(fixture);
    });
  }
});

test("atomic-drain sentinel probe requires exit 75 and the running identity", async (t) => {
  for (const [name, options] of [
    ["wrong exit status", { drainProbeWrongStatus: true }],
    ["wrong returned identity", { drainProbeWrongIdentity: true }],
  ]) {
    await t.test(name, async (subtest) => {
      const fixture = await createDeployFixture(options);
      subtest.after(() => fixture.cleanup());
      const result = fixture.run();
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const calls = await fixture.callsText();
      assert.match(
        calls,
        /^omp-target\tappserver\tdrain-if-idle\t--json\t--expected-host-id\tt4-maintainer-capability-host-[0-9a-f]{64}\t--expected-epoch\tt4-maintainer-capability-epoch-[0-9a-f]{64}$/mu,
      );
      assert.doesNotMatch(calls, /^(?:git|bun|pnpm|apt-get)\t/mu);
      assert.doesNotMatch(calls, /^systemctl\t.*(?:stop|start|restart)/mu);
      assert.equal(await pathExists(join(fixture.work, "omp-source")), false);
      assert.equal(await pathExists(join(fixture.work, "downloads")), false);
      assert.equal(await pathExists(join(fixture.work, "rollback")), false);
      await assertRestored(fixture);
    });
  }
});

test("atomic drain protects the appserver identity window before stop", async (t) => {
  const fixture = await createDeployFixture();
  t.after(() => fixture.cleanup());
  const result = fixture.run();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const calls = await fixture.callsText();
  const drain = calls.indexOf(
    "omp-target\tappserver\tdrain-if-idle\t--json\t--expected-host-id\told-host\t--expected-epoch\told-epoch",
  );
  const stop = calls.indexOf("systemctl\t--user\tstop\tmock-omp.service");
  assert.ok(drain >= 0, calls);
  assert.ok(stop > drain, calls);
});

test("installed candidate proves its drain contract against the exact live executable", async (t) => {
  const fixture = await createDeployFixture();
  t.after(() => fixture.cleanup());
  const result = fixture.run();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const calls = await fixture.callsText();
  assert.match(
    calls,
    /^omp-candidate\tappserver\tdrain-if-idle\t--json\t--expected-host-id\tt4-maintainer-host-[0-9a-f]{64}\t--expected-epoch\tt4-maintainer-epoch-[0-9a-f]{64}$/mu,
  );
  assert.ok(
    calls.split("\n").filter((line) => /^sha256sum\t\/proc\/[0-9]+\/exe$/u.test(line)).length >= 2,
    calls,
  );
});

test("malformed, unsupported, and false live drain proofs never complete deployment", async (t) => {
  for (const [name, options, preservesNewState] of [
    ["unsupported", { newAppDrainUnsupported: true }, true],
    ["malformed", { newAppDrainMalformed: true }, false],
    ["wrong status", { newAppDrainWrongStatus: true }, false],
    ["wrong identity", { newAppDrainWrongIdentity: true }, false],
  ]) {
    await t.test(name, async (subtest) => {
      const fixture = await createDeployFixture(options);
      subtest.after(() => fixture.cleanup());
      const result = fixture.run();
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(await pathExists(fixture.receipt), false);
      const calls = await fixture.callsText();
      assert.match(calls, /^omp-candidate\tappserver\tdrain-if-idle\t--json/mu);
      assert.match(
        calls,
        /^omp-candidate\tappserver\tdrain-if-idle\t--json\t--expected-host-id\tmock-host\t--expected-epoch\tmock-epoch$/mu,
      );
      if (preservesNewState) {
        const marker = join(fixture.maintainerRoot, "state", "deployment-blocked.json");
        assert.equal(await pathExists(marker), true);
        assert.equal(JSON.parse(await readFile(marker, "utf8")).status, "rollback-blocked-active-work");
        assert.notDeepEqual(await readFile(fixture.ompTarget), fixture.initial.omp);
        assert.equal((await readFile(join(fixture.state, "app-service"), "utf8")).trim(), "active");
        assert.equal(
          (await readFile(join(fixture.state, "gateway-enablement"), "utf8")).trim(),
          "disabled",
        );
      } else {
        await assertRestored(fixture);
      }
    });
  }
});

test("a failed appserver start that became active is drained before rollback", async (t) => {
  const fixture = await createDeployFixture({ appStartFailsActive: true });
  t.after(() => fixture.cleanup());
  const result = fixture.run();
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const calls = await fixture.callsText();
  const start = calls.indexOf("systemctl\t--user\tstart\tmock-omp.service");
  const drain = calls.indexOf(
    "omp-candidate\tappserver\tdrain-if-idle\t--json\t--expected-host-id\tmock-host\t--expected-epoch\tmock-epoch",
  );
  assert.ok(start >= 0 && drain > start, calls);
  await assertRestored(fixture);
});

test("gateway installation stays dark until the final exposure step", async (t) => {
  const fixture = await createDeployFixture();
  t.after(() => fixture.cleanup());
  const result = fixture.run();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const calls = await fixture.callsText();
  const callLines = calls.split("\n");
  const installLine = callLines
    .findIndex((line) => line.startsWith("node\t") && line.includes("\tinstall\t--defer-start"));
  const startLine = callLines
    .findIndex((line) => line.startsWith("node\t") && line.endsWith("\tstart"));
  assert.ok(installLine >= 0, calls);
  assert.ok(startLine > installLine, calls);
  assert.match(calls, /\t--deployment-identity\tsha256:[0-9a-f]{64}(?:\t|\n)/u);
});

test("busy or identity-changed atomic drain rolls back before package mutation", async (t) => {
  for (const [name, options] of [
    ["busy", { drainBusy: true }],
    ["identity mismatch", { drainIdentityMismatch: true }],
  ]) {
    await t.test(name, async (subtest) => {
      const fixture = await createDeployFixture(options);
      subtest.after(() => fixture.cleanup());
      const result = fixture.run();
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const calls = await fixture.callsText();
      assert.match(
        calls,
        /^omp-target\tappserver\tdrain-if-idle\t--json\t--expected-host-id\told-host\t--expected-epoch\told-epoch$/mu,
      );
      assert.match(calls, /^git\t.*clone/mu);
      assert.equal(
        calls
          .split("\n")
          .filter((line) => line.startsWith("apt-get\t") && !line.includes("--simulate"))
          .length,
        0,
        calls,
      );
      if (name === "busy") {
        assert.doesNotMatch(calls, /^systemctl\t--user\tstop\tmock-omp\.service$/mu);
      } else {
        assert.match(calls, /^systemctl\t--user\tstop\tmock-omp\.service$/mu);
        assert.match(calls, /^systemctl\t--user\trestart\tmock-omp\.service$/mu);
      }
      await assertRestored(fixture);
    });
  }
});

test("stopped or unhealthy baseline services are repairable", async (t) => {
  for (const [name, options] of [
    [
      "disabled/stopped gateway and stopped appserver",
      { gatewayActive: false, gatewayEnabled: false, appActive: false },
    ],
    ["unhealthy active gateway", { gatewayHealthy: false }],
    ["active appserver with MainPID zero", { mainPidZero: true }],
  ]) {
    await t.test(name, async (subtest) => {
      const fixture = await createDeployFixture(options);
      subtest.after(() => fixture.cleanup());
      const result = fixture.run();
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(await pathExists(fixture.receipt), true);
      assert.equal(
        await pathExists(join(fixture.maintainerRoot, "state", "deployment-blocked.json")),
        false,
      );
      const receipt = JSON.parse(await readFile(fixture.receipt, "utf8"));
      assert.equal(receipt.status, "complete");
      assert.equal(receipt.gateway.runtimeCommit, t4Commit);
      assert.match(receipt.gateway.deploymentIdentity, /^sha256:[0-9a-f]{64}$/u);
      assert.match(receipt.gateway.artifacts.gatewayScriptSha256, /^[0-9a-f]{64}$/u);
      assert.match(receipt.gateway.artifacts.webTreeSha256, /^[0-9a-f]{64}$/u);
      assert.match(receipt.gateway.artifacts.wsTreeSha256, /^[0-9a-f]{64}$/u);
      assert.equal(receipt.gateway.tailnetHealth, "pending");
      assert.equal((await readFile(join(fixture.state, "package-version"), "utf8")).trim(), "1.2.3");
      assert.equal(
        (await readFile(join(fixture.state, "gateway-enablement"), "utf8")).trim(),
        "enabled",
      );
      assert.match(await fixture.callsText(), /^apt-get\t.*--reinstall/mu);
    });
  }
});

test("same-version package repair is an effective reinstall", async (t) => {
  const fixture = await createDeployFixture({ sameVersion: true });
  t.after(() => fixture.cleanup());
  const result = fixture.run();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const aptCalls = (await fixture.callsText())
    .split("\n")
    .filter((line) => line.startsWith("apt-get\t") && !line.includes("--simulate"));
  assert.equal(aptCalls.length, 1);
  assert.match(aptCalls[0], /--reinstall/u);
  assert.match(aptCalls[0], /T4-Code-1\.2\.3-linux-amd64\.deb/u);
});

test("the second idle guard catches a session opened during preparation", async (t) => {
  const fixture = await createDeployFixture({ busyAfterStage: true });
  t.after(() => fixture.cleanup());
  const result = fixture.run();
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const calls = await fixture.callsText();
  assert.match(calls, /^git\t.*clone/mu);
  assert.doesNotMatch(calls, /^apt-get\t/mu);
  assert.doesNotMatch(calls, /^systemctl\t.*(?:stop|start|restart)/mu);
  assert.equal(await pathExists(join(fixture.work, "omp-source")), false);
  assert.equal(await pathExists(join(fixture.work, "downloads")), false);
  assert.equal(await pathExists(join(fixture.work, "rollback")), false);
  await assertRestored(fixture);
});

test("every named cutover fault verifies rollback and clears the transaction", async (t) => {
  const checkpoints = [
    "after-transaction-marker",
    "after-gateway-stop",
    "after-appserver-stop",
    "after-omp-install",
    "after-appserver-start",
    "before-desktop-install",
    "after-desktop-install",
    "after-gateway-install",
    "before-gateway-exposure",
    "after-gateway-start",
    "after-loopback-health",
    "before-receipt",
    "after-receipt-write",
  ];
  for (const checkpoint of checkpoints) {
    await t.test(checkpoint, async (subtest) => {
      const fixture = await createDeployFixture(
        checkpoint === "after-gateway-install"
          ? { appActive: false, gatewayActive: false, gatewayEnabled: false }
          : {},
      );
      subtest.after(() => fixture.cleanup());
      const pending = join(fixture.maintainerRoot, "state", "pending.json");
      await mkdir(dirname(pending), { recursive: true });
      await writeFile(pending, "pending-must-survive\n");
      const result = fixture.run({ T4_MAINTAINER_TEST_FAULT: checkpoint });
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      await assertRestored(fixture);
      assert.equal(await readFile(pending, "utf8"), "pending-must-survive\n");
      const calls = (await fixture.callsText()).split("\n").filter(Boolean);
      const aptCalls = calls.filter(
        (line) => line.startsWith("apt-get\t") && !line.includes("--simulate"),
      );
      for (const call of aptCalls) assert.match(call, /--reinstall/u);
      if ([
        "after-desktop-install",
        "after-gateway-install",
        "before-gateway-exposure",
        "after-gateway-start",
        "after-loopback-health",
        "before-receipt",
        "after-receipt-write",
      ].includes(checkpoint)) {
        assert.equal(aptCalls.length, 2, `target and rollback apt calls missing at ${checkpoint}`);
      }
    });
  }
});

test("post-exposure busy or changed appserver preserves new state behind a durable block", async (t) => {
  for (const [name, options, expectedStatus] of [
    ["busy", { newAppDrainBusy: true }, "rollback-blocked-active-work"],
    [
      "identity mismatch",
      { newAppDrainIdentityMismatch: true },
      "rollback-blocked-invalid-drain-proof",
    ],
  ]) {
    await t.test(name, async (subtest) => {
      const fixture = await createDeployFixture(options);
      subtest.after(() => fixture.cleanup());
      const first = fixture.run({ T4_MAINTAINER_TEST_FAULT: "after-gateway-start" });
      assert.notEqual(first.status, 0, `${first.stdout}\n${first.stderr}`);

      const marker = join(fixture.maintainerRoot, "state", "deployment-blocked.json");
      assert.equal(await pathExists(marker), true);
      assert.equal(JSON.parse(await readFile(marker, "utf8")).status, expectedStatus);
      assert.equal((await readFile(join(fixture.state, "package-version"), "utf8")).trim(), "1.2.3");
      assert.notDeepEqual(await readFile(fixture.ompTarget), fixture.initial.omp);
      assert.notDeepEqual(await readFile(fixture.gatewayConfig), fixture.initial.gatewayConfig);
      assert.notDeepEqual(await readFile(fixture.gatewayUnit), fixture.initial.gatewayUnit);
      assert.equal((await readFile(join(fixture.state, "app-service"), "utf8")).trim(), "active");
      assert.equal(
        (await readFile(join(fixture.state, "gateway-service"), "utf8")).trim(),
        "inactive",
      );
      assert.equal(
        (await readFile(join(fixture.state, "gateway-enablement"), "utf8")).trim(),
        "disabled",
      );
      assert.equal(await pathExists(fixture.receipt), false);

      const callsBefore = await fixture.callsText();
      const effectiveAptBefore = callsBefore
        .split("\n")
        .filter((line) => line.startsWith("apt-get\t") && !line.includes("--simulate"));
      assert.equal(effectiveAptBefore.length, 1, callsBefore);
      assert.doesNotMatch(
        callsBefore,
        /^apt-get\t.*previous-T4-Code-1\.2\.2-linux-amd64\.deb/mu,
      );

      const second = fixture.run();
      assert.notEqual(second.status, 0, `${second.stdout}\n${second.stderr}`);
      assert.equal(await fixture.callsText(), callsBefore);
    });
  }
});

test("rollback failure leaves a durable block that prevents a second mutation", async (t) => {
  const fixture = await createDeployFixture({ rollbackAptFail: true });
  t.after(() => fixture.cleanup());
  const first = fixture.run({ T4_MAINTAINER_TEST_FAULT: "after-desktop-install" });
  assert.notEqual(first.status, 0, `${first.stdout}\n${first.stderr}`);
  const marker = join(fixture.maintainerRoot, "state", "deployment-blocked.json");
  assert.equal(await pathExists(marker), true);
  assert.equal(JSON.parse(await readFile(marker, "utf8")).status, "rollback-incomplete");
  const callsBefore = await fixture.callsText();
  const second = fixture.run();
  assert.notEqual(second.status, 0, `${second.stdout}\n${second.stderr}`);
  const callsAfter = await fixture.callsText();
  assert.equal(
    callsAfter.split("\n").filter((line) => line.startsWith("apt-get\t")).length,
    callsBefore.split("\n").filter((line) => line.startsWith("apt-get\t")).length,
  );
  assert.equal(
    callsAfter.split("\n").filter((line) => /^systemctl\t.*(?:stop|start|restart)/u.test(line)).length,
    callsBefore.split("\n").filter((line) => /^systemctl\t.*(?:stop|start|restart)/u.test(line)).length,
  );
});

test("a crash-left transaction marker blocks rerun before staging or mutation", async (t) => {
  const fixture = await createDeployFixture();
  t.after(() => fixture.cleanup());
  const marker = join(fixture.maintainerRoot, "state", "deployment-blocked.json");
  await mkdir(dirname(marker), { recursive: true });
  const markerBytes = '{"schemaVersion":1,"status":"deployment-in-progress"}\n';
  await writeFile(marker, markerBytes);

  const result = fixture.run();
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(await readFile(marker, "utf8"), markerBytes);
  const calls = await fixture.callsText();
  assert.doesNotMatch(calls, /^(?:git|bun|pnpm|apt-get)\t/mu);
  assert.doesNotMatch(calls, /^systemctl\t.*(?:stop|start|restart)/mu);
  assert.equal(await pathExists(join(fixture.work, "omp-source")), false);
  assert.equal(await pathExists(join(fixture.work, "downloads")), false);
  assert.equal(await pathExists(join(fixture.work, "rollback")), false);
  await assertRestored(fixture, { blocked: true });
});

test("runtime dependency symlinks must remain inside the exact tagged runtime", async (t) => {
  const fixture = await createDeployFixture({ wsEscape: true });
  t.after(() => fixture.cleanup());
  const result = fixture.run();
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const calls = await fixture.callsText();
  assert.doesNotMatch(calls, /^apt-get\t/mu);
  assert.doesNotMatch(calls, /^systemctl\t.*(?:stop|start|restart)/mu);
  await assertRestored(fixture);
});

test("a divergent fork main is retried and rejected before source staging", async (t) => {
  const fixture = await createDeployFixture({ forkMainDiverged: true });
  t.after(() => fixture.cleanup());
  const result = fixture.run();
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const calls = await fixture.callsText();
  assert.equal(
    calls.split("\n").filter((line) => line.includes("repos/lyc-aon/oh-my-pi/commits/main"))
      .length,
    2,
    calls,
  );
  assert.doesNotMatch(calls, /^git\t.*clone/mu);
  assert.doesNotMatch(calls, /^systemctl\t.*(?:stop|start|restart)/mu);
  await assertRestored(fixture);
});

test("a missing or recreated fork base tag is rejected before source staging", async (t) => {
  for (const [name, options] of [
    ["missing", { forkBaseTagMissing: true }],
    ["different tag object", { forkBaseTagMismatch: true }],
  ]) {
    await t.test(name, async (subtest) => {
      const fixture = await createDeployFixture(options);
      subtest.after(() => fixture.cleanup());
      const result = fixture.run();
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const calls = await fixture.callsText();
      assert.equal(
        calls
          .split("\n")
          .filter((line) => line.includes("repos/lyc-aon/oh-my-pi/git/ref/tags/v1.2.3"))
          .length,
        2,
        calls,
      );
      assert.doesNotMatch(calls, /^git\t.*clone/mu);
      assert.doesNotMatch(calls, /^systemctl\t.*(?:stop|start|restart)/mu);
      await assertRestored(fixture);
    });
  }
});

test("public verification rejects a changed fork base-tag object", async (t) => {
  const fixture = await createRunnerFixture({ forkBaseTagMismatch: true });
  t.after(() => fixture.cleanup());
  const result = fixture.runRunner();
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const calls = await fixture.callsText();
  assert.match(calls, /repos\/can1357\/oh-my-pi\/git\/ref\/tags\/v1\.2\.3/mu);
  assert.match(calls, /repos\/lyc-aon\/oh-my-pi\/git\/ref\/tags\/v1\.2\.3/mu);
  assert.equal(calls.split("\n").filter((line) => line.startsWith("local-deploy\t")).length, 0);
  assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 0);
});

test("integration tags must remain reachable from the durable fork product branch", async (t) => {
  await t.test("local source gate", async (subtest) => {
    const fixture = await createDeployFixture({ productBranchMissing: true });
    subtest.after(() => fixture.cleanup());
    const result = fixture.run();
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const calls = await fixture.callsText();
    assert.match(calls, /refs\/remotes\/origin\/t4code\/main/mu);
    assert.doesNotMatch(calls, /^apt-get\t/mu);
    assert.doesNotMatch(calls, /^systemctl\t.*(?:stop|start|restart)/mu);
    await assertRestored(fixture);
  });

  await t.test("public result gate", async (subtest) => {
    const fixture = await createRunnerFixture({ productBranchMissing: true });
    subtest.after(() => fixture.cleanup());
    const result = fixture.runRunner();
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const calls = await fixture.callsText();
    assert.match(
      calls,
      /repos\/lyc-aon\/oh-my-pi\/compare\/b{40}\.\.\.t4code\/main/mu,
    );
    assert.equal(calls.split("\n").filter((line) => line.startsWith("local-deploy\t")).length, 0);
    assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 0);
  });
});

test("repeated pending retries retain state and never invoke Sol", async (t) => {
  const fixture = await createRunnerFixture({ localDeployFail: true });
  t.after(() => fixture.cleanup());
  await fixture.seedPending();
  const pendingBefore = await readFile(fixture.pending);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = fixture.runRunner();
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(await readFile(fixture.pending), pendingBefore);
    assert.equal(await pathExists(fixture.processed), false);
  }

  const calls = await fixture.callsText();
  assert.equal(
    calls.split("\n").filter((line) => line.startsWith("local-deploy\t")).length,
    2,
    calls,
  );
  assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 0);
});

test("Tailnet-only convergence retains local apply and never redeploys or invokes Sol", async (t) => {
  const fixture = await createRunnerFixture();
  t.after(() => fixture.cleanup());
  await writeFile(join(fixture.state, "tailnet-health"), "unhealthy");

  const first = fixture.runRunner();
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  assert.equal(await pathExists(fixture.pending), true, await fixture.callsText());
  assert.equal(await pathExists(fixture.localApplied), true, await fixture.callsText());
  assert.equal(await pathExists(fixture.processed), false);
  const pendingAfterFirst = await readFile(fixture.pending);
  const appliedAfterFirst = await readFile(fixture.localApplied);
  assert.equal(
    JSON.parse(appliedAfterFirst).localDeployment.gateway.tailnetHealth,
    "pending",
  );

  const callsAfterFirst = await fixture.callsText();
  const second = fixture.runRunner();
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  assert.deepEqual(await readFile(fixture.pending), pendingAfterFirst);
  assert.deepEqual(await readFile(fixture.localApplied), appliedAfterFirst);
  assert.equal(await pathExists(fixture.processed), false);

  const callsAfterSecond = await fixture.callsText();
  assert.ok(callsAfterSecond.length > callsAfterFirst.length);
  await writeFile(join(fixture.state, "tailnet-health"), "healthy");
  const third = fixture.runRunner();
  assert.equal(third.status, 0, `${third.stdout}\n${third.stderr}`);
  assert.equal(await pathExists(fixture.pending), false);
  assert.equal(await pathExists(fixture.localApplied), false);
  assert.equal(await pathExists(fixture.processed), true);
  const processed = JSON.parse(await readFile(fixture.processed, "utf8"));
  assert.equal(processed.localDeployment.gateway.tailnetHealth, "healthy");

  const calls = await fixture.callsText();
  assert.equal(
    calls.split("\n").filter((line) => line.startsWith("local-deploy\t")).length,
    1,
    calls,
  );
  assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 0, calls);
  const thirdRunCalls = calls.slice(callsAfterSecond.length);
  const upstreamResolution = thirdRunCalls.indexOf(
    "gh\tapi\trepos/can1357/oh-my-pi/commits/v1.2.3",
  );
  const tailnetProof = thirdRunCalls.indexOf("https://mock.tailnet.ts.net/healthz");
  assert.ok(upstreamResolution >= 0, thirdRunCalls);
  assert.ok(tailnetProof > upstreamResolution, thirdRunCalls);
});

test("stale Tailnet deployment identity cannot finalize exact local state", async (t) => {
  const fixture = await createRunnerFixture({ staleTailnetIdentity: true });
  t.after(() => fixture.cleanup());
  const first = fixture.runRunner();
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  assert.equal(await pathExists(fixture.pending), true);
  assert.equal(await pathExists(fixture.localApplied), true);
  assert.equal(await pathExists(fixture.processed), false);
  const applied = JSON.parse(await readFile(fixture.localApplied, "utf8"));
  assert.match(applied.localDeployment.gateway.deploymentIdentity, /^sha256:[0-9a-f]{64}$/u);

  const second = fixture.runRunner({ MOCK_STALE_TAILNET_IDENTITY: "0" });
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  assert.equal(await pathExists(fixture.pending), false);
  assert.equal(await pathExists(fixture.localApplied), false);
  assert.equal(await pathExists(fixture.processed), true);
});

test("stale loopback deployment identity cannot validate the local receipt", async (t) => {
  const fixture = await createRunnerFixture({ staleLoopbackIdentity: true });
  t.after(() => fixture.cleanup());
  const first = fixture.runRunner();
  assert.notEqual(first.status, 0, `${first.stdout}\n${first.stderr}`);
  assert.equal(await pathExists(fixture.pending), true);
  assert.equal(await pathExists(fixture.localApplied), true);
  assert.equal(await pathExists(fixture.processed), false);
  assert.match(first.stderr, /receipt did not independently match the live workstation/u);

  const second = fixture.runRunner({ MOCK_STALE_LOOPBACK_IDENTITY: "0" });
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  assert.equal(await pathExists(fixture.pending), false);
  assert.equal(await pathExists(fixture.localApplied), false);
  assert.equal(await pathExists(fixture.processed), true);
});

test("receipt-bound local drift redeploys the exact pending publication without Sol", async (t) => {
  const driftTargets = [
    ["OMP executable", (fixture) => fixture.ompTarget],
    ["gateway script", (fixture) => join(fixture.runtimeRoot, "scripts", "tailnet-gateway.mjs")],
    ["web tree", (fixture) => join(fixture.runtimeRoot, "apps", "web", "dist", "index.html")],
    ["ws tree", (fixture) => join(fixture.runtimeRoot, "node_modules", "ws", "package.json")],
    ["gateway config", (fixture) => fixture.gatewayConfig],
    ["gateway unit", (fixture) => fixture.gatewayUnit],
  ];

  for (const [name, resolveTarget] of driftTargets) {
    await t.test(name, async (subtest) => {
      const fixture = await createRunnerFixture();
      subtest.after(() => fixture.cleanup());
      await writeFile(join(fixture.state, "tailnet-health"), "unhealthy");
      const first = fixture.runRunner();
      assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
      assert.equal(await pathExists(fixture.localApplied), true, await fixture.callsText());

      await appendFile(resolveTarget(fixture), "drift\n");
      const second = fixture.runRunner();
      assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
      assert.equal(await pathExists(fixture.pending), true);
      assert.equal(await pathExists(fixture.localApplied), true);
      assert.equal(await pathExists(fixture.processed), false);
      const calls = await fixture.callsText();
      assert.equal(
        calls.split("\n").filter((line) => line.startsWith("local-deploy\t")).length,
        2,
        calls,
      );
      assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 0, calls);
    });
  }
});

test("normal recovery adopts a compatible in-flight main publication before Sol", async (t) => {
  const fixture = await createRunnerFixture({ localDeployFail: true });
  t.after(() => fixture.cleanup());
  const result = fixture.runRunner();
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(await pathExists(fixture.pending), true, await fixture.callsText());
  assert.equal(await pathExists(fixture.processed), false);
  const calls = await fixture.callsText();
  assert.equal(
    calls.split("\n").filter((line) => line.startsWith("local-deploy\t")).length,
    1,
    calls,
  );
  assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 0);
});

test("normal recovery adopts the compatible latest public release before Sol", async (t) => {
  const fixture = await createRunnerFixture({ localDeployFail: true, mainIncompatible: true });
  t.after(() => fixture.cleanup());
  const result = fixture.runRunner();
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(await pathExists(fixture.pending), true, await fixture.callsText());
  assert.equal(await pathExists(fixture.processed), false);
  const calls = await fixture.callsText();
  assert.match(calls, /gh\tapi\trepos\/LycaonLLC\/t4-code\/releases\/latest/mu);
  assert.match(
    calls,
    /contents\/compat\/omp-app-matrix\.json\\\?ref=v1\.2\.3/mu,
  );
  assert.equal(
    calls.split("\n").filter((line) => line.startsWith("local-deploy\t")).length,
    1,
    calls,
  );
  assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 0, calls);
});

test("terminal compatible publication resumes through Sol instead of waiting forever", async (t) => {
  const fixture = await createRunnerFixture({ workflowsTerminal: true });
  t.after(() => fixture.cleanup());
  const result = fixture.runRunner();
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /ready for completion through the positive Sol release workflow/u);
  assert.equal(await pathExists(fixture.pending), false);
  assert.equal(await pathExists(fixture.processed), false);
  const calls = await fixture.callsText();
  assert.doesNotMatch(
    calls,
    /gh\tapi\trepos\/LycaonLLC\/t4-code\/releases\/latest/mu,
    "an older public release cannot supersede compatible main work that is ready to resume",
  );
  assert.equal(calls.split("\n").filter((line) => line.startsWith("local-deploy\t")).length, 0);
  assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 1, calls);
  assert.match(
    calls.replaceAll("\\ ", " "),
    /Continue and complete the compatible T4 publication/u,
  );
});

test("a fresh Sol result cannot forge the wrapper-owned OMP asset proof", async (t) => {
  const fixture = await createRunnerFixture({ workflowsTerminal: true });
  t.after(() => fixture.cleanup());
  const forgedResult = join(fixture.root, "forged-sol-result.json");
  const publication = JSON.parse(await readFile(fixture.result, "utf8"));
  publication.publicProof = { ompRelease: forgedOmpPublicProof() };
  await writeFile(forgedResult, `${JSON.stringify(publication)}\n`);

  const result = fixture.runRunner({
    MOCK_SOL_RESULT_SOURCE: forgedResult,
    MOCK_SOL_STATUS: "0",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const calls = await fixture.callsText();
  assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 1, calls);
  assert.match(
    calls,
    /curl\t[^\n]*mock:\/\/omp-linux-x64\t-o\t/mu,
    "an untrusted prepopulated proof must still trigger the initial full download",
  );
});

test("fresh verification downloads OMP assets once across later convergence retries", async (t) => {
  const fixture = await createRunnerFixture({ workflowsTerminal: true });
  t.after(() => fixture.cleanup());
  const solResult = join(fixture.root, "sol-result.json");
  await writeFile(solResult, await readFile(fixture.result));

  const result = fixture.runRunner({
    MOCK_SOL_RESULT_SOURCE: solResult,
    MOCK_SOL_STATUS: "0",
    MOCK_WORKFLOWS_FAIL_ONCE_AFTER_SOL: "1",
    T4_MAINTAINER_VERIFY_ATTEMPTS: "2",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const downloads = (await fixture.callsText())
    .split("\n")
    .filter(
      (line) => line.startsWith("curl\t") && line.includes("mock://omp-") && line.includes("\t-o\t"),
    );
  assert.equal(downloads.length, 5, downloads.join("\n"));
});

test("active compatible publication waits without launching duplicate Sol work", async (t) => {
  const fixture = await createRunnerFixture({ workflowsActive: true });
  t.after(() => fixture.cleanup());
  const result = fixture.runRunner();
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /workflows are active or recently successful/u);
  assert.equal(await pathExists(fixture.pending), false);
  const calls = await fixture.callsText();
  assert.equal(calls.split("\n").filter((line) => line.startsWith("local-deploy\t")).length, 0);
  assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 0, calls);
});

test("same-named noncanonical T4 workflows cannot satisfy publication", async (t) => {
  const fixture = await createRunnerFixture({ t4WorkflowWrongPath: true });
  t.after(() => fixture.cleanup());
  const solResult = join(fixture.root, "sol-result.json");
  await writeFile(solResult, await readFile(fixture.result));

  const result = fixture.runRunner({
    MOCK_SOL_RESULT_SOURCE: solResult,
    MOCK_SOL_STATUS: "0",
  });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const calls = await fixture.callsText();
  assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 1, calls);
  assert.equal(calls.split("\n").filter((line) => line.startsWith("local-deploy\t")).length, 0, calls);
});

test("an incompatible public matrix falls through nonfatally to Sol", async (t) => {
  const fixture = await createRunnerFixture({ publicIncompatible: true });
  t.after(() => fixture.cleanup());
  const result = fixture.runRunner();
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const calls = await fixture.callsText();
  assert.equal(calls.split("\n").filter((line) => line.startsWith("local-deploy\t")).length, 0);
  assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 1, calls);
});

test("background work from Sol cannot inherit and strand the maintainer lock", async (t) => {
  const fixture = await createRunnerFixture({ publicIncompatible: true });
  t.after(() => fixture.cleanup());
  const first = fixture.runRunner({ MOCK_SOL_BACKGROUND_HOLDER: "1" });
  assert.notEqual(first.status, 0, `${first.stdout}\n${first.stderr}`);
  const backgroundPid = Number(await readFile(join(fixture.state, "sol-background-pid"), "utf8"));
  t.after(() => {
    try {
      process.kill(backgroundPid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  });

  const second = fixture.runRunner();
  assert.notEqual(second.status, 0, `${second.stdout}\n${second.stderr}`);
  assert.doesNotMatch(second.stdout, /maintainer run is already active/u);
  const calls = await fixture.callsText();
  assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 2, calls);
});

test("wrapper fast-forwards fork main with CI quiesced before any Sol work", async (t) => {
  const fixture = await createRunnerFixture({ forkMainBehind: true, localDeployFail: true });
  t.after(() => fixture.cleanup());
  const result = fixture.runRunner();
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const calls = await fixture.callsText();
  const disable = calls.indexOf("actions/workflows/ci.yml/disable");
  const push = calls.indexOf("git\t-C", disable);
  const enable = calls.indexOf("actions/workflows/ci.yml/enable", push);
  assert.ok(disable >= 0 && push > disable && enable > push, calls);
  assert.equal(await readFile(join(fixture.state, "fork-workflow"), "utf8"), "active");
  assert.equal(
    await pathExists(join(fixture.maintainerRoot, "state", "fork-main-sync.json")),
    false,
  );
  assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 0, calls);
});

test("wrapper retries a moving fork-main snapshot within its bounded window", async (t) => {
  const fixture = await createRunnerFixture({
    forkMainBehind: true,
    forkMainRaceOnce: true,
    localDeployFail: true,
  });
  t.after(() => fixture.cleanup());
  const result = fixture.runRunner();
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /moved while its exact snapshot was being proved/u);
  assert.equal(await pathExists(join(fixture.state, "fork-main-synced")), true);
  assert.equal(await readFile(join(fixture.state, "fork-workflow"), "utf8"), "active");
  const calls = await fixture.callsText();
  assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 0, calls);
  assert.match(calls, /actions\/workflows\/ci\.yml\/disable/mu);
  assert.match(calls, /actions\/workflows\/ci\.yml\/enable/mu);
});

test("fork-main divergence fails closed before Sol", async (t) => {
  const fixture = await createRunnerFixture({ forkMainDiverged: true });
  t.after(() => fixture.cleanup());
  const result = fixture.runRunner();
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /fork main has diverged/u);
  const calls = await fixture.callsText();
  assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 0, calls);
  assert.equal(calls.split("\n").filter((line) => line.startsWith("local-deploy\t")).length, 0);
});

test("interrupted fork CI re-enable retains recovery state until active proof", async (t) => {
  const fixture = await createRunnerFixture({ forkMainBehind: true, forkWorkflowEnableFail: true });
  t.after(() => fixture.cleanup());
  const marker = join(fixture.maintainerRoot, "state", "fork-main-sync.json");
  const first = fixture.runRunner();
  assert.notEqual(first.status, 0, `${first.stdout}\n${first.stderr}`);
  assert.equal(await pathExists(marker), true);
  assert.equal(await readFile(join(fixture.state, "fork-workflow"), "utf8"), "disabled_manually");

  const second = fixture.runRunner({ MOCK_FORK_WORKFLOW_ENABLE_FAIL: "0", MOCK_LOCAL_DEPLOY_FAIL: "1" });
  assert.notEqual(second.status, 0, `${second.stdout}\n${second.stderr}`);
  assert.match(second.stdout, /Recovered and proved the fork CI workflow active/u);
  assert.equal(await pathExists(marker), false);
  assert.equal(await readFile(join(fixture.state, "fork-workflow"), "utf8"), "active");
});

test("exact OMP CI and five-asset release failures block local deployment", async (t) => {
  const cases = [
    ["missing CI", { ompWorkflowMissing: true }],
    ["failed CI", { ompWorkflowFailed: true }],
    ["wrong CI path", { ompWorkflowWrongPath: true }],
    ["missing asset", { ompAssetMissing: true }],
    ["extra asset", { ompAssetExtra: true }],
    ["zero asset", { ompAssetZero: true }],
    ["digestless asset", { ompAssetDigestless: true }],
    ["unreachable asset", { ompAssetUnreachable: true }],
    ["digest mismatch", { ompAssetDigestMismatch: true }],
    ["wrong asset origin", { ompAssetWrongOrigin: true }],
  ];
  for (const [name, options] of cases) {
    await t.test(name, async (subtest) => {
      const fixture = await createRunnerFixture(options);
      subtest.after(() => fixture.cleanup());
      const result = fixture.runRunner();
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const calls = await fixture.callsText();
      assert.equal(calls.split("\n").filter((line) => line.startsWith("local-deploy\t")).length, 0);
      assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 0);
    });
  }
});

test("processed no-op rechecks public invariants without redownloading OMP binaries", async (t) => {
  const fixture = await createRunnerFixture();
  t.after(() => fixture.cleanup());
  const first = fixture.runRunner();
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  assert.equal(await pathExists(fixture.processed), true);
  const callsBefore = await fixture.callsText();
  assert.match(callsBefore, /mock:\/\/omp-linux-x64/mu);

  const second = fixture.runRunner();
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  const delta = (await fixture.callsText()).slice(callsBefore.length);
  assert.match(delta, /mock:\/\/omp-linux-x64/mu);
  assert.doesNotMatch(delta, /curl\t[^\n]*mock:\/\/omp-[^\n]*\t-o\t/mu);

  const drift = fixture.runRunner({ MOCK_OMP_ASSET_MISSING: "1" });
  assert.notEqual(drift.status, 0, `${drift.stdout}\n${drift.stderr}`);
  const finalCalls = await fixture.callsText();
  assert.equal(finalCalls.split("\n").filter((line) => line.startsWith("local-deploy\t")).length, 1);
  assert.equal(finalCalls.split("\n").filter((line) => line.startsWith("omp\t")).length, 0);
});

test("active but durably disabled gateway is repaired from processed state without Sol", async (t) => {
  const fixture = await createRunnerFixture();
  t.after(() => fixture.cleanup());
  const first = fixture.runRunner();
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  await writeFile(join(fixture.state, "gateway-service"), "active");
  await writeFile(join(fixture.state, "gateway-enablement"), "disabled");
  const second = fixture.runRunner();
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  const calls = await fixture.callsText();
  assert.equal(calls.split("\n").filter((line) => line.startsWith("local-deploy\t")).length, 2, calls);
  assert.equal(calls.split("\n").filter((line) => line.startsWith("omp\t")).length, 0, calls);
  assert.equal(await readFile(join(fixture.state, "gateway-enablement"), "utf8"), "enabled");
});

test("a gateway quarantine failure preserves an honest block and active-ingress warning", async (t) => {
  const fixture = await createDeployFixture({ gatewayDisableFailAfterFirst: true });
  t.after(() => fixture.cleanup());
  const result = fixture.run({ T4_MAINTAINER_TEST_FAULT: "after-gateway-start" });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /gateway quarantine could not be proven/u);
  assert.match(result.stderr, /Ingress may still be active/u);
  assert.doesNotMatch(result.stderr, /gateway remains durably disabled/u);
  const blocked = JSON.parse(
    await readFile(join(fixture.maintainerRoot, "state", "deployment-blocked.json"), "utf8"),
  );
  assert.equal(blocked.status, "gateway-quarantine-incomplete");
  assert.equal(await readFile(join(fixture.state, "gateway-service"), "utf8"), "active");
});

test("derived drain probe cannot collide with the former constant sentinel", async (t) => {
  const fixture = await createDeployFixture({ drainConstantIdentity: true });
  t.after(() => fixture.cleanup());
  const result = fixture.run();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const calls = await fixture.callsText();
  assert.match(
    calls,
    /--expected-host-id\tt4-maintainer-capability-host-[0-9a-f]{64}\t--expected-epoch\tt4-maintainer-capability-epoch-[0-9a-f]{64}/mu,
  );
});
