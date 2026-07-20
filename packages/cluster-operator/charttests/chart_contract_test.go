package charttests

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

const fakeDigest = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func TestChartIsDefaultOff(t *testing.T) {
	output := helmTemplate(t)
	if strings.TrimSpace(output) != "" {
		t.Fatalf("default values rendered workloads/resources:\n%s", output)
	}
}

func TestEnabledChartRendersHARestrictedWorkloads(t *testing.T) {
	output := helmTemplate(t, enabledValues()...)
	assertCount(t, output, "kind: Deployment", 2)
	assertContains(t, output,
		"replicas: 2",
		"replicas: 3",
		"maxUnavailable: 0",
		"kind: PodDisruptionBudget",
		"minAvailable: 2",
		"kubernetes.io/hostname",
		"k3s-worker-02",
		"topologySpreadConstraints:",
		"podAntiAffinity:",
		"readOnlyRootFilesystem: true",
		"runAsNonRoot: true",
		"allowPrivilegeEscalation: false",
		"type: RuntimeDefault",
		"drop:",
		"- ALL",
		"automountServiceAccountToken: false",
		"startupProbe:",
		"readinessProbe:",
		"livenessProbe:",
		"preStop:",
		"path: /drainz",
		"kind: NetworkPolicy",
		"policyTypes:",
		"kind: Role",
		"kind: ClusterRole",
		"coordination.k8s.io",
		"resources:",
	)
	server := documentContainingKind(t, output, "Deployment", "name: release-name-t4-cluster-server")
	assertContains(t, server,
		"automountServiceAccountToken: false",
		"name: T4_CLUSTER_TRUSTED_PROXY_CIDRS",
		"value: 192.0.2.0/24",
		"name: kubernetes-api-access",
		"audience: https://kubernetes.default.svc",
		"expirationSeconds: 3600",
	)
	if strings.Contains(output, "privileged: true") || strings.Contains(output, "hostNetwork: true") || strings.Contains(output, "hostPID: true") {
		t.Fatal("enabled chart contains a privileged shortcut")
	}
	if strings.Contains(output, "kind: PersistentVolumeClaim") || strings.Contains(output, "nfs:") || strings.Contains(output, "hostPath:") {
		t.Fatal("portable chart rendered storage backend or workload PVC")
	}
}

func TestRBACSeparatesControllerMutationFromServerProjection(t *testing.T) {
	output := helmTemplate(t, enabledValues()...)
	controllerRole := documentContaining(t, output, "name: release-name-t4-cluster-controller")
	serverRole := documentContaining(t, output, "name: release-name-t4-cluster-server")
	assertContains(t, controllerRole, "persistentvolumeclaims", "pods", "services", "t4sessions/status", "leases")
	assertContains(t, serverRole, "t4clusterhosts", "t4workspaces", "t4sessions", "create", "list", "watch")
	if strings.Contains(serverRole, "secrets") || strings.Contains(serverRole, "persistentvolumeclaims") || strings.Contains(serverRole, "t4sessions/status") {
		t.Fatal("server role can read secrets or mutate controller-owned infrastructure/status")
	}
}

func TestChartUsesOnlyProjectedServiceAccountIdentityForInternalPeers(t *testing.T) {
	output := helmTemplate(t, enabledValues()...)
	assertCount(t, output, "kind: ServiceAccount", 3)
	assertCount(t, output, "kind: Secret", 0)
	server := documentContainingKind(t, output, "Deployment", "name: release-name-t4-cluster-server")
	assertContains(t, server,
		"serviceAccountName: release-name-t4-cluster-server",
		"name: T4_CLUSTER_IDENTITY_TOKEN_FILE",
		"/var/run/secrets/t4-cluster-identity/token",
		"serviceAccountToken:",
		"audience: t4-cluster-internal",
		"expirationSeconds: 600",
	)
	controller := documentContainingKind(t, output, "Deployment", "name: release-name-t4-cluster-controller")
	assertContains(t, controller,
		"name: T4_SESSION_SERVICE_ACCOUNT",
		"value: release-name-t4-cluster-session",
		"name: T4_CLUSTER_SERVER_SERVICE_ACCOUNT",
		"value: release-name-t4-cluster-server",
	)
	sessionRole := documentContainingKind(t, output, "ClusterRole", "name: release-name-t4-cluster-session-token-reviewer")
	assertContains(t, sessionRole,
		"apiGroups: [authentication.k8s.io]",
		"resources: [tokenreviews]",
		"verbs: [create]",
	)
	if strings.Count(sessionRole, "- apiGroups:") != 1 || strings.Contains(sessionRole, "get") || strings.Contains(sessionRole, "list") || strings.Contains(sessionRole, "watch") {
		t.Fatalf("session ServiceAccount received permissions beyond TokenReview create:\n%s", sessionRole)
	}
}

func TestNetworkPoliciesDefaultDenyAndAllowOnlyDeclaredFlows(t *testing.T) {
	output := helmTemplate(t, append(enabledValues(),
		"--set", "networkPolicy.kubernetesApiCIDRs[0]=192.0.2.10/32",
		"--set", "networkPolicy.modelRouteCIDRs[0]=198.51.100.4/32",
		"--set", "networkPolicy.ciProviderCIDRs[0]=203.0.113.8/32",
	)...)
	assertContains(t, output,
		"name: release-name-t4-cluster-default-deny",
		"192.0.2.10/32",
		"198.51.100.4/32",
		"203.0.113.8/32",
		"port: 53",
		"port: 8787",
	)
	sessionPolicy := documentContainingKind(t, output, "NetworkPolicy", "name: release-name-t4-cluster-session-host")
	assertContains(t, sessionPolicy, "192.0.2.10/32", "port: 443", "port: 6443")
	if strings.Contains(output, "0.0.0.0/0") {
		t.Fatal("network policy contains broad Internet egress")
	}
}

func TestCRDsRemainExplicitAcrossUpgradeAndUninstall(t *testing.T) {
	withoutCRDs := helmTemplate(t, enabledValues()...)
	if strings.Contains(withoutCRDs, "kind: CustomResourceDefinition") {
		t.Fatal("CRDs must live in Helm crds/, not upgrade-rendered templates")
	}
	withCRDs := helmTemplate(t, append([]string{"--include-crds"}, enabledValues()...)...)
	assertCount(t, withCRDs, "kind: CustomResourceDefinition", 3)
	assertContains(t, withCRDs, "t4clusterhosts.cluster.t4.dev", "t4workspaces.cluster.t4.dev", "t4sessions.cluster.t4.dev")

	docs, err := os.ReadFile(filepath.Join(repoRoot(t), "docs", "CLUSTER_OPERATOR.md"))
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{"helm upgrade", "helm rollback", "helm uninstall", "Retain", "Delete", "CRDs are not removed"} {
		if !strings.Contains(string(docs), required) {
			t.Fatalf("operator guide lacks upgrade/uninstall contract %q", required)
		}
	}
}

func TestImageContractsArePinnedAndAuthorityCompatible(t *testing.T) {
	root := repoRoot(t)
	controller := mustRead(t, filepath.Join(root, "cluster", "images", "controller", "Dockerfile"))
	server := mustRead(t, filepath.Join(root, "cluster", "images", "cluster-server", "Dockerfile"))
	session := mustRead(t, filepath.Join(root, "cluster", "images", "session-runtime", "Dockerfile"))
	for name, content := range map[string]string{"controller": controller, "server": server, "session": session} {
		if !strings.Contains(content, "@sha256:") {
			t.Fatalf("%s image uses an unpinned base", name)
		}
	}
	assertContains(t, session,
		"8476f4451ed95c5d5401785d279a93d3c659fac4",
		"t4code-17.0.5-appserver-10",
		"t4-omp-authority/1",
		"packages/cluster-server/src/session-host-main.ts",
		"chromium",
		"Xvfb",
	)
	for name, content := range map[string]string{"server": server, "session": session} {
		assertContains(t, content, "pnpm install --frozen-lockfile")
		if strings.Contains(content, "bun install --ignore-scripts --lockfile-only") {
			t.Fatalf("%s image synthesizes an uncommitted dependency lock", name)
		}
	}
	assertContains(t, server, "packages/cluster-server/src/main.ts")
	entrypoint := mustRead(t, filepath.Join(root, "cluster", "images", "session-runtime", "session-entrypoint.sh"))
	assertContains(t, entrypoint,
		"T4_CLUSTER_SERVER_SERVICE_ACCOUNT",
		"/var/run/secrets/kubernetes.io/serviceaccount/token",
		"/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
		"/var/run/secrets/kubernetes.io/serviceaccount/namespace",
	)
}

func helmTemplate(t *testing.T, extra ...string) string {
	t.Helper()
	args := []string{"template", "release-name", filepath.Join(repoRoot(t), "deploy", "charts", "t4-cluster"), "--namespace", "t4-system"}
	args = append(args, extra...)
	command := exec.Command("helm", args...)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("helm %s: %v\n%s", strings.Join(args, " "), err, output)
	}
	return string(output)
}

func enabledValues() []string {
	return []string{
		"--set", "enabled=true",
		"--set", "storage.adminRWXStorageClass=portable-rwx",
		"--set", "images.controller.digest=" + fakeDigest,
		"--set", "images.server.digest=" + fakeDigest,
		"--set", "images.sessionRuntime.digest=" + fakeDigest,
		"--set", "server.trustedProxyCIDRs[0]=192.0.2.0/24",
	}
}

func repoRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	return root
}

func mustRead(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func assertContains(t *testing.T, value string, required ...string) {
	t.Helper()
	for _, item := range required {
		if !strings.Contains(value, item) {
			t.Fatalf("output lacks %q", item)
		}
	}
}

func assertCount(t *testing.T, value, needle string, want int) {
	t.Helper()
	if got := strings.Count(value, needle); got != want {
		t.Fatalf("count(%q) = %d, want %d", needle, got, want)
	}
}

func documentContaining(t *testing.T, rendered, needle string) string {
	t.Helper()
	for _, document := range strings.Split(rendered, "\n---") {
		if strings.Contains(document, "kind: Role\n") && strings.Contains(document, needle) {
			return document
		}
	}
	t.Fatalf("no rendered document contains %q", needle)
	return ""
}

func documentContainingKind(t *testing.T, rendered, kind, needle string) string {
	t.Helper()
	for _, document := range strings.Split(rendered, "\n---") {
		if strings.Contains(document, "kind: "+kind+"\n") && strings.Contains(document, needle) {
			return document
		}
	}
	t.Fatalf("no rendered %s contains %q", kind, needle)
	return ""
}
