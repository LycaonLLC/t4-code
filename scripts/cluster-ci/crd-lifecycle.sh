#!/bin/sh
set -eu

usage() {
  cat >&2 <<'EOF'
usage: crd-lifecycle.sh install|upgrade -- helm install|upgrade ... --skip-crds

Environment:
  KUBECTL                 kubectl executable (default: kubectl)
  T4_CRD_DIRECTORY        reviewed CRD directory
  T4_COMPAT_DIRECTORY     old-object compatibility fixture directory
  T4_VALIDATION_NAMESPACE existing namespace used for server dry-runs (default: default)
EOF
  exit 64
}

[ "$#" -ge 4 ] || usage
mode=$1
shift
case "$mode" in
  install|upgrade) ;;
  *) usage ;;
esac
[ "${1:-}" = "--" ] || usage
shift
[ "${1:-}" = "helm" ] || usage
[ "${2:-}" = "$mode" ] || usage

has_skip_crds=false
for argument in "$@"; do
  case "$argument" in
    --skip-crds) has_skip_crds=true ;;
    --force|--force=*|--force-conflicts|replace)
      echo "force replacement is prohibited by the T4 CRD lifecycle" >&2
      exit 64
      ;;
  esac
done
[ "$has_skip_crds" = true ] || {
  echo "the workload command must include --skip-crds" >&2
  exit 64
}

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
kubectl=${KUBECTL:-kubectl}
crd_directory=${T4_CRD_DIRECTORY:-$repo_root/deploy/charts/t4-cluster/crds}
compat_directory=${T4_COMPAT_DIRECTORY:-$repo_root/packages/cluster-operator/api/v1alpha1/testdata/compat}
validation_namespace=${T4_VALIDATION_NAMESPACE:-default}
field_manager=t4-crd-lifecycle
crds="crd/t4clusterhosts.cluster.t4.dev crd/t4workspaces.cluster.t4.dev crd/t4sessions.cluster.t4.dev"

# Every operation before the first non-dry-run apply is read-only. An upgrade
# rejects an incompatible CRD or old persisted shape before touching the CRD or
# any chart-managed workload.
"$kubectl" apply --server-side --dry-run=server --validate=strict \
  --field-manager="$field_manager" -f "$crd_directory" >/dev/null
if [ "$mode" = upgrade ]; then
  "$kubectl" apply --dry-run=server --validate=strict \
    --namespace "$validation_namespace" -f "$compat_directory" >/dev/null
fi

"$kubectl" apply --server-side --validate=strict \
  --field-manager="$field_manager" -f "$crd_directory"
# Discovery and admission must converge before compatibility validation or any
# workload rollout uses the new schema.
# shellcheck disable=SC2086 # The fixed CRD words are intentional argv entries.
"$kubectl" wait --for=condition=Established --timeout=120s $crds

"$kubectl" apply --dry-run=server --validate=strict \
  --namespace "$validation_namespace" -f "$compat_directory" >/dev/null

for crd in $crds; do
  stored_versions=$("$kubectl" get "$crd" -o 'jsonpath={.status.storedVersions[*]}')
  if [ "$stored_versions" != v1alpha1 ]; then
    echo "$crd status.storedVersions is '$stored_versions'; expected exactly 'v1alpha1'" >&2
    exit 65
  fi
done

# Helm is deliberately last and must not manage CRDs. If any earlier gate fails,
# the existing controller, server, session workloads, and custom resources are
# untouched by this runner.
exec "$@"
