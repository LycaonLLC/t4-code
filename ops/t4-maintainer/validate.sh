#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)

for file in run.sh install.sh validate.sh; do
  bash -n "$SCRIPT_DIR/$file"
done

for command in bash cmp curl flock gh grep jq omp readlink sed sort systemctl systemd-analyze; do
  command -v "$command" >/dev/null 2>&1 || {
    printf 'required command is unavailable: %s\n' "$command" >&2
    exit 1
  }
done

[[ -s "$SCRIPT_DIR/prompt.md" ]]
grep -Fq -- '--model openai-codex/gpt-5.6-sol' "$SCRIPT_DIR/run.sh"
grep -Fq -- '--thinking max' "$SCRIPT_DIR/run.sh"
grep -Fq -- '--approval-mode yolo' "$SCRIPT_DIR/run.sh"
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
install -m 0600 "$SCRIPT_DIR/prompt.md" "$runtime_root/libexec/prompt.md"
sed \
  -e "s|@HOME@|$HOME|g" \
  -e "s|@MAINTAINER_ROOT@|$runtime_root|g" \
  "$SCRIPT_DIR/t4-omp-maintainer.service.in" >"$service"
cp "$SCRIPT_DIR/t4-omp-maintainer.timer" "$temporary/t4-omp-maintainer.timer"
systemd-analyze verify "$service" "$temporary/t4-omp-maintainer.timer"
systemd-analyze calendar '*-*-* 00/2:17:00' >/dev/null

printf 'T4 maintainer scripts and systemd units validated.\n'
