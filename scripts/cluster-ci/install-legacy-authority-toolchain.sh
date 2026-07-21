#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "legacy authority toolchain setup requires root" >&2
  exit 64
fi

test -f .ci/bun
rm -f /etc/apt/sources.list.d/*
printf '%s\n' \
  'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20250721T000000Z bookworm main' \
  'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/20250721T000000Z bookworm-security main' \
  > /etc/apt/sources.list
apt-get -o Acquire::Check-Valid-Until=false update
apt-get install -y --no-install-recommends ca-certificates git lld pkg-config libssl-dev
rm -rf /var/lib/apt/lists/*
install -m 0755 .ci/bun /usr/local/bin/bun
test "$(bun --version)" = "1.3.14"
command -v cargo >/dev/null
command -v ld.lld >/dev/null
