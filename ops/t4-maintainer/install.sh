#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
MAINTAINER_ROOT=${T4_MAINTAINER_ROOT:-"${XDG_DATA_HOME:-$HOME/.local/share}/t4-maintainer"}
SYSTEMD_USER_DIR=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
SERVICE_NAME=t4-omp-maintainer.service
TIMER_NAME=t4-omp-maintainer.timer

"$SCRIPT_DIR/validate.sh"

if [[ ${1:-} == --check ]]; then
  exit 0
fi
if [[ $# -gt 0 ]]; then
  printf 'usage: %s [--check]\n' "$0" >&2
  exit 1
fi

mkdir -p -- "$MAINTAINER_ROOT"/{libexec,logs,runs,state,work} "$SYSTEMD_USER_DIR"
chmod 700 -- "$MAINTAINER_ROOT" "$MAINTAINER_ROOT"/{libexec,logs,runs,state,work}
touch "$MAINTAINER_ROOT/logs/service.log" "$MAINTAINER_ROOT/logs/service.error.log"
chmod 600 "$MAINTAINER_ROOT/logs/service.log" "$MAINTAINER_ROOT/logs/service.error.log"

environment_file="$MAINTAINER_ROOT/environment"
if [[ -n ${OMP_AUTH_BROKER_URL:-} && -n ${OMP_AUTH_BROKER_TOKEN_FILE:-} ]]; then
  [[ $OMP_AUTH_BROKER_URL != *$'\n'* && $OMP_AUTH_BROKER_URL != *"'"* ]] || {
    printf 'OMP_AUTH_BROKER_URL contains unsupported environment-file characters\n' >&2
    exit 1
  }
  [[ $OMP_AUTH_BROKER_TOKEN_FILE != *$'\n'* && $OMP_AUTH_BROKER_TOKEN_FILE != *"'"* ]] || {
    printf 'OMP_AUTH_BROKER_TOKEN_FILE contains unsupported environment-file characters\n' >&2
    exit 1
  }
  [[ -r $OMP_AUTH_BROKER_TOKEN_FILE ]] || {
    printf 'OMP auth broker token file is not readable\n' >&2
    exit 1
  }
  temporary_environment=$(mktemp "$MAINTAINER_ROOT/environment.XXXXXX")
  printf "OMP_AUTH_BROKER_URL='%s'\nOMP_AUTH_BROKER_TOKEN_FILE='%s'\n" \
    "$OMP_AUTH_BROKER_URL" "$OMP_AUTH_BROKER_TOKEN_FILE" >"$temporary_environment"
  chmod 600 "$temporary_environment"
  mv -f -- "$temporary_environment" "$environment_file"
elif [[ ! -s $environment_file ]]; then
  printf 'OMP auth broker environment is unavailable\n' >&2
  exit 1
fi

if [[ -z ${OMP_AUTH_BROKER_TOKEN_FILE:-} ]]; then
  set -a
  # This local mode-0600 file contains broker references created above.
  # shellcheck disable=SC1090
  source "$environment_file"
  set +a
fi

profile_root="$HOME/.omp/profiles/t4-maintainer"
profile_token="$profile_root/auth-broker.token"
mkdir -p -- "$profile_root"
chmod 700 -- "$profile_root"
if [[ -L $profile_token ]]; then
  [[ $(readlink -f -- "$profile_token") == "$(readlink -f -- "$OMP_AUTH_BROKER_TOKEN_FILE")" ]] || {
    printf 'the t4-maintainer broker-token link points to another credential\n' >&2
    exit 1
  }
elif [[ -e $profile_token ]]; then
  cmp -s -- "$profile_token" "$OMP_AUTH_BROKER_TOKEN_FILE" || {
    printf 'the t4-maintainer profile already has another broker credential\n' >&2
    exit 1
  }
else
  ln -s -- "$OMP_AUTH_BROKER_TOKEN_FILE" "$profile_token"
fi

"$SCRIPT_DIR/run.sh" --adopt-current
install -m 0700 "$SCRIPT_DIR/run.sh" "$MAINTAINER_ROOT/libexec/run.sh"
install -m 0600 "$SCRIPT_DIR/prompt.md" "$MAINTAINER_ROOT/libexec/prompt.md"

temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
sed \
  -e "s|@HOME@|$HOME|g" \
  -e "s|@MAINTAINER_ROOT@|$MAINTAINER_ROOT|g" \
  "$SCRIPT_DIR/t4-omp-maintainer.service.in" >"$temporary/$SERVICE_NAME"
cp "$SCRIPT_DIR/t4-omp-maintainer.timer" "$temporary/$TIMER_NAME"
systemd-analyze verify "$temporary/$SERVICE_NAME" "$temporary/$TIMER_NAME"
install -m 0644 "$temporary/$SERVICE_NAME" "$SYSTEMD_USER_DIR/$SERVICE_NAME"
install -m 0644 "$temporary/$TIMER_NAME" "$SYSTEMD_USER_DIR/$TIMER_NAME"

systemctl --user daemon-reload
systemctl --user enable --now "$TIMER_NAME"
printf 'Installed and enabled %s.\n' "$TIMER_NAME"
