#!/bin/sh
set -eu

umask 077
: "${CI_COMMIT_SHA:?CI_COMMIT_SHA is required}"
: "${HARBOR_REGISTRY:?HARBOR_REGISTRY is required}"
: "${HARBOR_PROJECT:?HARBOR_PROJECT is required}"
if [ "$HARBOR_REGISTRY" != "harbor.tailb18de3.ts.net" ]; then
  echo "HARBOR_REGISTRY must be the exact HTTPS tailnet Harbor host" >&2
  exit 64
fi
case "$CI_COMMIT_SHA" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
  *) echo "CI_COMMIT_SHA must be an exact lowercase 40-character SHA" >&2; exit 64 ;;
esac

auth_dir=${T4_REGISTRY_AUTH_DIR:-${CI_WORKSPACE:-$PWD}/.cluster-ci/registry-auth}
test -r "$auth_dir/config.json"
export DOCKER_CONFIG="$auth_dir"
source="$HARBOR_REGISTRY/$HARBOR_PROJECT/quarantine/t4-site:$CI_COMMIT_SHA"
destination="$HARBOR_REGISTRY/$HARBOR_PROJECT/t4-site:$CI_COMMIT_SHA"
digest_file=${T4_SITE_DIGEST_FILE:-.site-ci/site-image-digest}
source_digest=$(oras resolve --plain-http "$source")
case "$source_digest" in
  sha256:????????????????????????????????????????????????????????????????) ;;
  *) echo "site quarantine image did not resolve to an immutable digest" >&2; exit 65 ;;
esac

if destination_digest=$(oras resolve --plain-http "$destination" 2>&1); then
  if [ "$destination_digest" != "$source_digest" ]; then
    echo "site destination commit tag already resolves to a different digest" >&2
    exit 65
  fi
else
  case "$destination_digest" in
    *"failed to resolve digest: "*"$CI_COMMIT_SHA: not found") ;;
    *) printf '%s\n' "$destination_digest" >&2; exit 65 ;;
  esac
  oras copy --from-plain-http --to-plain-http --recursive "$source" "$destination"
fi

test "$(oras resolve --plain-http "$destination")" = "$source_digest"
mkdir -p "$(dirname "$digest_file")"
printf '%s\n' "$source_digest" > "$digest_file"
