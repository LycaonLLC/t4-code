#!/bin/sh
set -eu

umask 077

component=${1:-}
repository_suffix=${2:-}
dockerfile=${3:-}

case "$component:$repository_suffix:$dockerfile" in
  controller:t4-cluster-operator:cluster/images/controller/Dockerfile | \
  cluster-server:t4-cluster-server:cluster/images/cluster-server/Dockerfile | \
  session-runtime:t4-session-runtime:cluster/images/session-runtime/Dockerfile)
    ;;
  *)
    echo "component, repository suffix, and Dockerfile do not match the fixed T4 image contract" >&2
    exit 64
    ;;
esac

case "${CI_COMMIT_SHA:-}" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f])
    ;;
  *)
    echo "CI_COMMIT_SHA must be an exact lowercase 40-character SHA" >&2
    exit 64
    ;;
esac

: "${BUILDKIT_ADDR:?BUILDKIT_ADDR is required}"
: "${HARBOR_REGISTRY:?HARBOR_REGISTRY is required}"
: "${HARBOR_PROJECT:?HARBOR_PROJECT is required}"
auth_dir=${T4_REGISTRY_AUTH_DIR:-${CI_WORKSPACE:-$PWD}/.cluster-ci/registry-auth}
test -r "$auth_dir/config.json"
export DOCKER_CONFIG="$auth_dir"

test -f "$dockerfile"
artifact_dir="artifacts/cluster-proof/images"
mkdir -p "$artifact_dir"
metadata="$artifact_dir/$component.buildkit.json"
digest_file="$artifact_dir/$component.digest"

repository="$HARBOR_REGISTRY/$HARBOR_PROJECT/$repository_suffix"
reference="$repository:$CI_COMMIT_SHA"

buildctl --addr "$BUILDKIT_ADDR" build \
  --frontend dockerfile.v0 \
  --local context=. \
  --local dockerfile=. \
  --opt "filename=$dockerfile" \
  --opt platform=linux/amd64 \
  --opt "build-arg:SOURCE_COMMIT=$CI_COMMIT_SHA" \
  --output "type=image,name=$reference,push=true,compression=zstd,force-compression=true,oci-mediatypes=true" \
  --attest type=sbom \
  --attest type=provenance,mode=max \
  --metadata-file "$metadata"

digest=$(sed -n 's/.*"containerimage\.digest"[[:space:]]*:[[:space:]]*"\(sha256:[0-9a-f]\{64\}\)".*/\1/p' "$metadata")
case "$digest" in
  sha256:????????????????????????????????????????????????????????????????) ;;
  *)
    echo "BuildKit did not return an immutable image digest" >&2
    exit 65
    ;;
esac
printf '%s\n' "$digest" > "$digest_file"
printf '%s@%s\n' "$repository" "$digest" > "$artifact_dir/$component.reference"
