#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)

for file in run.sh deploy-local.sh publish-omp-atomic.sh install.sh validate.sh; do
  bash -n "$SCRIPT_DIR/$file"
done

for command in apt-get awk bash bun cmp curl dpkg dpkg-deb dpkg-query flock gh git grep install jq node omp pnpm readlink realpath sed sha256sum sort sudo sync systemctl systemd-analyze uname; do
  command -v "$command" >/dev/null 2>&1 || {
    printf 'required command is unavailable: %s\n' "$command" >&2
    exit 1
  }
done

[[ -s "$SCRIPT_DIR/prompt.md" ]]
grep -Fq -- '--model openai-codex/gpt-5.6-sol' "$SCRIPT_DIR/run.sh"
grep -Fq -- '--thinking max' "$SCRIPT_DIR/run.sh"
grep -Fq -- '--approval-mode yolo' "$SCRIPT_DIR/run.sh"
grep -Fq -- 'Use `$T4_ATOMIC_PUBLISH_HELPER` as the only OMP publication path.' "$SCRIPT_DIR/prompt.md"
grep -Fq -- '--atomic --porcelain --no-follow-tags' "$SCRIPT_DIR/publish-omp-atomic.sh"
grep -Fq -- 'pushedRefCount: 3' "$SCRIPT_DIR/publish-omp-atomic.sh"
grep -Fq -- 'omp-windows-x64.exe' "$SCRIPT_DIR/run.sh"
grep -Fq -- 'repos/$OMP_UPSTREAM_SLUG/commits/main' "$SCRIPT_DIR/deploy-local.sh"
grep -Fq -- 'repos/$OMP_INTEGRATION_SLUG/commits/main' "$SCRIPT_DIR/deploy-local.sh"
grep -Fq -- 'repos/$OMP_UPSTREAM_SLUG/git/ref/tags/$UPSTREAM_TAG' "$SCRIPT_DIR/deploy-local.sh"
grep -Fq -- 'repos/$OMP_INTEGRATION_SLUG/git/ref/tags/$UPSTREAM_TAG' "$SCRIPT_DIR/deploy-local.sh"
grep -Fq -- '--cwd packages/appserver test' "$SCRIPT_DIR/deploy-local.sh"
grep -Fq -- 'appserver-exposure-starting' "$SCRIPT_DIR/deploy-local.sh"
grep -Fq -- '--deployment-identity "$DEPLOYMENT_IDENTITY"' "$SCRIPT_DIR/deploy-local.sh"
grep -Fq -- 'the automatic local deployer currently supports Linux only' "$SCRIPT_DIR/deploy-local.sh"
if grep -Eq -- '--no-tools|--tools=|--no-pty|bwrap|PrivateUsers|ProtectSystem|NoNewPrivileges' "$SCRIPT_DIR/run.sh" "$SCRIPT_DIR/t4-omp-maintainer.service.in" \
  || grep -Eq -- '^[[:space:]]+--max-time' "$SCRIPT_DIR/run.sh"; then
  printf 'the maintainer must retain the normal full host tool environment\n' >&2
  exit 1
fi

temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
service="$temporary/t4-omp-maintainer.service"
runtime_root="$temporary/runtime"
mkdir -p "$runtime_root"/{libexec,logs,work}
install -m 0700 "$SCRIPT_DIR/run.sh" "$runtime_root/libexec/run.sh"
install -m 0700 "$SCRIPT_DIR/deploy-local.sh" "$runtime_root/libexec/deploy-local.sh"
install -m 0700 "$SCRIPT_DIR/publish-omp-atomic.sh" "$runtime_root/libexec/publish-omp-atomic.sh"
install -m 0600 "$SCRIPT_DIR/prompt.md" "$runtime_root/libexec/prompt.md"
sed \
  -e "s|@HOME@|$HOME|g" \
  -e "s|@MAINTAINER_ROOT@|$runtime_root|g" \
  "$SCRIPT_DIR/t4-omp-maintainer.service.in" >"$service"
cp "$SCRIPT_DIR/t4-omp-maintainer.timer" "$temporary/t4-omp-maintainer.timer"
systemd-analyze verify "$service" "$temporary/t4-omp-maintainer.timer"
systemd-analyze calendar '*-*-* 00/2:17:00' >/dev/null

printf 'T4 maintainer scripts and systemd units validated.\n'
