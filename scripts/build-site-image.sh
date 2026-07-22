#!/bin/sh
set -eu

umask 077
canonical_build_source_repository=usr-bin-roygbiv/t4-code
authorized_ci_mirror=z-peterson/t4-code
dockerfile=cluster/images/site/Dockerfile

case "${CI_COMMIT_SHA:-}" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
  *) echo "CI_COMMIT_SHA must be an exact lowercase 40-character SHA" >&2; exit 64 ;;
esac

: "${BUILDKIT_ADDR:?BUILDKIT_ADDR is required}"
: "${HARBOR_REGISTRY:?HARBOR_REGISTRY is required}"
: "${HARBOR_PROJECT:?HARBOR_PROJECT is required}"
if [ "$HARBOR_REGISTRY" != "harbor.tailb18de3.ts.net" ]; then
  echo "HARBOR_REGISTRY must be the exact HTTPS tailnet Harbor host" >&2
  exit 64
fi
if [ "${CI_REPO:-}" != "$authorized_ci_mirror" ]; then
  echo "CI_REPO must identify the authorized Woodpecker mirror" >&2
  exit 64
fi

auth_dir=${T4_REGISTRY_AUTH_DIR:-${CI_WORKSPACE:-$PWD}/.cluster-ci/registry-auth}
test -r "$auth_dir/config.json"
export DOCKER_CONFIG="$auth_dir"
test -f "$dockerfile"

repository="$HARBOR_REGISTRY/$HARBOR_PROJECT/quarantine/t4-site"
reference="$repository:$CI_COMMIT_SHA"

buildctl --addr "$BUILDKIT_ADDR" build \
  --frontend dockerfile.v0 \
  --local context=. \
  --local dockerfile=. \
  --opt "filename=$dockerfile" \
  --opt platform=linux/amd64,linux/arm64 \
  --opt "build-arg:SOURCE_COMMIT=$CI_COMMIT_SHA" \
  --opt "build-arg:SOURCE_REPOSITORY=https://github.com/$canonical_build_source_repository" \
  --opt "label:org.opencontainers.image.source=https://github.com/$canonical_build_source_repository" \
  --opt "label:org.opencontainers.image.revision=$CI_COMMIT_SHA" \
  --output "type=image,name=$reference,push=true,compression=zstd,force-compression=true,oci-mediatypes=true" \
  --attest type=sbom \
  --attest type=provenance,mode=max
