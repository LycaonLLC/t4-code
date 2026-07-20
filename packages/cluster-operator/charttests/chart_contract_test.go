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
	server := documentContainingKind(t, output, "Deployment", "name: \"release-name-t4-cluster-server\"")
	assertContains(t, server,
		"automountServiceAccountToken: false",
		"name: T4_CLUSTER_TRUSTED_PROXY_CIDRS",
		"value: \"192.0.2.0/24\"",
		"name: kubernetes-api-access",
		"audience: \"https://kubernetes.default.svc\"",
		"expirationSeconds: 3600",
	)
	if strings.Contains(output, "privileged: true") || strings.Contains(output, "hostNetwork: true") || strings.Contains(output, "hostPID: true") {
		t.Fatal("enabled chart contains a privileged shortcut")
	}
	if strings.Contains(output, "kind: PersistentVolumeClaim") || strings.Contains(output, "nfs:") || strings.Contains(output, "hostPath:") {
		t.Fatal("portable chart rendered storage backend or workload PVC")
	}
}

func TestEachDeploymentUsesZeroUnavailableAndConfiguredAPIAudience(t *testing.T) {
	output := helmTemplate(t, append(enabledValues(), "--set-string", "kubernetes.apiAudience=kubernetes.custom.example")...)
	controller := documentContainingKind(t, output, "Deployment", "name: \"release-name-t4-cluster-controller\"")
	server := documentContainingKind(t, output, "Deployment", "name: \"release-name-t4-cluster-server\"")
	for name, deployment := range map[string]string{"controller": controller, "server": server} {
		assertCount(t, deployment, "maxUnavailable: 0", 1)
		assertContains(t, deployment,
			"automountServiceAccountToken: false",
			"name: T4_KUBERNETES_API_AUDIENCE",
			"value: \"kubernetes.custom.example\"",
			"audience: \"kubernetes.custom.example\"",
		)
		if strings.Contains(deployment, "maxUnavailable: 1") {
			t.Fatalf("%s Deployment permits an unavailable replica", name)
		}
	}
	assertContains(t, server, "audience: \"t4-cluster-internal\"")
}

func TestValuesSchemaRejectsUnsafeNamesProfilesCIDRsAndHalfSelectors(t *testing.T) {
	for name, values := range map[string][]string{
		"cluster host name": {"--set-string", "clusterHost.name=Bad_Name"},
		"storage class name": {"--set-string", "storage.adminRWXStorageClass=Bad_Name"},
		"runtime profile": {"--set-string", "clusterHost.runtimeProfiles[0]=-bad"},
		"Woodpecker Secret name": {"--set-string", "woodpecker.existingSecret=Bad_Name", "--set-string", "woodpecker.configMap=woodpecker-config"},
		"Woodpecker ConfigMap name": {"--set-string", "woodpecker.existingSecret=woodpecker-token", "--set-string", "woodpecker.configMap=Bad_Name"},
		"Woodpecker key": {"--set-string", "woodpecker.existingSecret=woodpecker-token", "--set-string", "woodpecker.configMap=woodpecker-config", "--set-string", "woodpecker.tokenKey=bad/key"},
		"Woodpecker audience": {"--set-string", "woodpecker.serviceAccountAudience=/bad", "--set-string", "woodpecker.configMap=woodpecker-config"},
		"IPv4 default route": {"--set-string", "server.trustedProxyCIDRs[0]=0.0.0.0/0"},
		"IPv6 default route": {"--set-string", "server.trustedProxyCIDRs[0]=::/0"},
		"gateway half selector": {"--set-string", "networkPolicy.gatewayIngress.namespaceSelector.matchLabels.scope=gateway"},
		"observability half selector": {"--set-string", "networkPolicy.observability.podSelector.matchLabels.scope=metrics"},
	} {
		t.Run(name, func(t *testing.T) {
			helmTemplateMustFail(t, append(enabledValues(), values...)...)
		})
	}
}

func TestNumericDNSReferencesStayQuoted(t *testing.T) {
	output := helmTemplate(t, append(enabledValues(),
		"--set-string", "clusterHost.name=123",
		"--set-string", "storage.adminRWXStorageClass=456",
	)...)
	host := documentContainingKind(t, output, "T4ClusterHost", "name: \"123\"")
	assertContains(t, host, "storageClassName: \"456\"")
}

func TestDNSAndSourceSelectorsAreConfigurableAndReleaseScoped(t *testing.T) {
	defaults := helmTemplate(t, enabledValues()...)
	defaultDNS := documentContainingKind(t, defaults, "NetworkPolicy", "name: \"release-name-t4-cluster-dns\"")
	assertContains(t, defaultDNS, "kubernetes.io/metadata.name: kube-system", "k8s-app: kube-dns")
	output := helmTemplate(t, append(enabledValues(),
		"--set-string", "networkPolicy.dns.namespaceSelector.matchLabels.scope=custom-dns-namespace",
		"--set-string", "networkPolicy.dns.podSelector.matchLabels.scope=custom-dns-pod",
		"--set-string", "networkPolicy.gatewayIngress.namespaceSelector.matchLabels.scope=gateway-namespace",
		"--set-string", "networkPolicy.gatewayIngress.podSelector.matchLabels.scope=gateway-pod",
		"--set-string", "networkPolicy.observability.namespaceSelector.matchLabels.scope=metrics-namespace",
		"--set-string", "networkPolicy.observability.podSelector.matchLabels.scope=metrics-pod",
	)...)
	dns := documentContainingKind(t, output, "NetworkPolicy", "name: \"release-name-t4-cluster-dns\"")
	assertContains(t, dns, "scope: custom-dns-namespace", "scope: custom-dns-pod")
	gateway := documentContainingKind(t, output, "NetworkPolicy", "name: \"release-name-t4-cluster-gateway-ingress\"")
	assertContains(t, gateway, "scope: gateway-namespace", "scope: gateway-pod")
	metrics := documentContainingKind(t, output, "NetworkPolicy", "name: \"release-name-t4-cluster-observability\"")
	assertContains(t, metrics,
		"app.kubernetes.io/instance: \"release-name\"",
		"app.kubernetes.io/part-of: \"t4-cluster\"",
		"scope: metrics-namespace",
		"scope: metrics-pod",
	)
}

func TestIngressRequiresTLSAndSupportsTailscaleManagedCertificates(t *testing.T) {
	output := helmTemplate(t, append(enabledValues(),
		"--set", "ingress.enabled=true",
		"--set-string", "ingress.className=tailscale",
		"--set-string", "ingress.host=operator.example.ts.net",
	)...)
	ingress := documentContainingKind(t, output, "Ingress", "name: \"release-name-t4-cluster\"")
	assertContains(t, ingress,
		"ingressClassName: \"tailscale\"",
		"tls:",
		"hosts: [\"operator.example.ts.net\"]",
	)
	if strings.Contains(ingress, "secretName:") {
		t.Fatal("Tailscale-managed ingress invented a TLS Secret reference")
	}
	helmTemplateMustFail(t, append(enabledValues(),
		"--set", "ingress.enabled=true",
		"--set-string", "ingress.className=nginx",
		"--set-string", "ingress.host=operator.example.test",
	)...)
	helmTemplateMustFail(t, append(enabledValues(),
		"--set", "ingress.enabled=true",
		"--set-string", "ingress.className=tailscale",
		"--set-string", "ingress.host=operator.example.ts.net",
		"--set", "ingress.tls.enabled=false",
	)...)
}

func TestRBACSeparatesControllerMutationFromServerProjection(t *testing.T) {
	output := helmTemplate(t, enabledValues()...)
	controllerRole := documentContaining(t, output, "name: \"release-name-t4-cluster-controller\"")
	serverRole := documentContaining(t, output, "name: \"release-name-t4-cluster-server\"")
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
	server := documentContainingKind(t, output, "Deployment", "name: \"release-name-t4-cluster-server\"")
	assertContains(t, server,
		"serviceAccountName: \"release-name-t4-cluster-server\"",
		"name: T4_CLUSTER_IDENTITY_TOKEN_FILE",
		"/var/run/secrets/t4-cluster-identity/token",
		"serviceAccountToken:",
		"audience: \"t4-cluster-internal\"",
		"expirationSeconds: 600",
	)
	controller := documentContainingKind(t, output, "Deployment", "name: \"release-name-t4-cluster-controller\"")
	assertContains(t, controller,
		"name: T4_SESSION_SERVICE_ACCOUNT",
		"value: \"release-name-t4-cluster-session\"",
		"name: T4_CLUSTER_SERVER_SERVICE_ACCOUNT",
		"value: \"release-name-t4-cluster-server\"",
	)
	sessionRole := documentContainingKind(t, output, "ClusterRole", "name: \"release-name-t4-cluster-session-token-reviewer\"")
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
		"name: \"release-name-t4-cluster-default-deny\"",
		"192.0.2.10/32",
		"198.51.100.4/32",
		"203.0.113.8/32",
		"port: 53",
		"port: 8787",
	)
	sessionPolicy := documentContainingKind(t, output, "NetworkPolicy", "name: \"release-name-t4-cluster-session-host\"")
	assertContains(t, sessionPolicy, "192.0.2.10/32", "port: 443", "port: 6443")
	if strings.Contains(output, "0.0.0.0/0") {
		t.Fatal("network policy contains broad Internet egress")
	}
}

func TestWoodpeckerCanUseRotatingProjectedServiceAccountIdentity(t *testing.T) {
	values := append(enabledValues(),
		"--set", "woodpecker.configMap=woodpecker-config",
		"--set", "woodpecker.serviceAccountAudience=woodpecker-ci-trigger",
	)
	output := helmTemplate(t, values...)
	server := documentContainingKind(t, output, "Deployment", "name: \"release-name-t4-cluster-server\"")
	assertContains(t, server,
		"name: T4_WOODPECKER_TOKEN_FILE",
		"/var/run/secrets/t4-ci/token",
		"audience: \"woodpecker-ci-trigger\"",
		"expirationSeconds: 600",
	)
	host := documentContainingKind(t, output, "T4ClusterHost", "name: \"t4-cluster\"")
	assertContains(t, host, "serviceAccountAudience: \"woodpecker-ci-trigger\"", "name: \"woodpecker-config\"")
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
	for _, required := range []string{"helm upgrade", "helm rollback", "helm uninstall", "kubectl apply --server-side -f deploy/charts/t4-cluster/crds/", "condition=Established", "Do not rely on `helm upgrade` to change CRDs", "Retain", "Delete", "CRDs are not removed"} {
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
	if strings.Contains(session, "ARG BUN_IMAGE") || strings.Contains(session, "ARG OMP_TAG") || strings.Contains(session, "ARG OMP_COMMIT") {
		t.Fatal("session runtime permits overriding a labeled runtime pin")
	}
	assertContains(t, session,
		"refs/tags/t4code-17.0.5-appserver-10",
		"git checkout --detach \"8476f4451ed95c5d5401785d279a93d3c659fac4\"",
		"snapshot.debian.org/archive/debian/20250721T000000Z",
	)
	assertContains(t, server, "snapshot.debian.org/archive/debian/20250721T000000Z")
	assertContains(t, controller, "ARG TARGETOS\n", "ARG TARGETARCH\n")
	if strings.Contains(controller, "TARGETARCH=amd64") || strings.Contains(controller, "org.opencontainers.image.architecture") {
		t.Fatal("controller image hardcodes or claims a single/unbuilt architecture")
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
func helmTemplateMustFail(t *testing.T, extra ...string) {
	t.Helper()
	args := []string{"template", "release-name", filepath.Join(repoRoot(t), "deploy", "charts", "t4-cluster"), "--namespace", "t4-system"}
	args = append(args, extra...)
	command := exec.Command("helm", args...)
	if output, err := command.CombinedOutput(); err == nil {
		t.Fatalf("helm unexpectedly accepted invalid values: %s", output)
	}
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
