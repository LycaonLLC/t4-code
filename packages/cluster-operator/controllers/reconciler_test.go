package controllers_test

import (
	"context"
	"testing"

	corev1 "k8s.io/api/core/v1"
	storagev1 "k8s.io/api/storage/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	apiresource "k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	clusterv1alpha1 "github.com/LycaonLLC/t4-code/packages/cluster-operator/api/v1alpha1"
	"github.com/LycaonLLC/t4-code/packages/cluster-operator/controllers"
)

func TestWorkspaceReconcileIsIdempotentAcrossDuplicateEvents(t *testing.T) {
	scheme := testScheme(t)
	workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
	c := fake.NewClientBuilder().WithScheme(scheme).
		WithStatusSubresource(&clusterv1alpha1.T4ClusterHost{}, &clusterv1alpha1.T4Workspace{}, &clusterv1alpha1.T4Session{}, &corev1.PersistentVolumeClaim{}, &corev1.Pod{}).
		WithObjects(testHost(), rwxStorageClass(), workspace).Build()
	r := &controllers.WorkspaceReconciler{Client: c, Scheme: scheme}
	reconcileMany(t, 4, func() error {
		_, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(workspace)})
		return err
	})

	var pvcs corev1.PersistentVolumeClaimList
	if err := c.List(context.Background(), &pvcs, client.InNamespace("team")); err != nil {
		t.Fatal(err)
	}
	if len(pvcs.Items) != 1 {
		t.Fatalf("duplicate events created %d PVCs, want 1", len(pvcs.Items))
	}
	pvc := pvcs.Items[0]
	if len(pvc.Spec.AccessModes) != 1 || pvc.Spec.AccessModes[0] != corev1.ReadWriteMany {
		t.Fatalf("PVC access modes = %v, want only ReadWriteMany", pvc.Spec.AccessModes)
	}
	if pvc.Spec.StorageClassName == nil || *pvc.Spec.StorageClassName != "portable-rwx" {
		t.Fatalf("PVC storage class = %v", pvc.Spec.StorageClassName)
	}

	var got clusterv1alpha1.T4Workspace
	if err := c.Get(context.Background(), client.ObjectKeyFromObject(workspace), &got); err != nil {
		t.Fatal(err)
	}
	if got.Status.ObservedGeneration != got.Generation || got.Status.PVCName != pvc.Name {
		t.Fatalf("workspace status not converged: %#v", got.Status)
	}
	if !contains(got.Finalizers, clusterv1alpha1.WorkspaceFinalizer) {
		t.Fatal("workspace protection finalizer missing")
	}
}

func TestRetainWorkspaceCreatesPVCWithoutGarbageCollectableOwner(t *testing.T) {
	scheme := testScheme(t)
	workspace := testWorkspace(clusterv1alpha1.RetentionPolicyRetain)
	workspace.UID = "workspace-uid"
	c := fake.NewClientBuilder().WithScheme(scheme).
		WithStatusSubresource(&clusterv1alpha1.T4Workspace{}, &corev1.PersistentVolumeClaim{}).
		WithObjects(testHost(), rwxStorageClass(), workspace).Build()
	r := &controllers.WorkspaceReconciler{Client: c, Scheme: scheme}
	reconcileMany(t, 2, func() error {
		_, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(workspace)})
		return err
	})
	var pvc corev1.PersistentVolumeClaim
	if err := c.Get(context.Background(), types.NamespacedName{Namespace: workspace.Namespace, Name: controllers.WorkspacePVCName(workspace)}, &pvc); err != nil {
		t.Fatal(err)
	}
	if len(pvc.OwnerReferences) != 0 || pvc.Annotations[clusterv1alpha1.WorkspaceUIDAnnotation] != string(workspace.UID) {
		t.Fatalf("retained PVC is exposed to owner garbage collection: %#v", pvc.ObjectMeta)
	}
}

func TestWorkspaceStorageFailsClosedWhenClassMissingOrNotRWX(t *testing.T) {
	for _, test := range []struct {
		name   string
		class  *storagev1.StorageClass
		reason string
	}{
		{name: "missing", reason: controllers.ReasonStorageClassNotFound},
		{name: "not-rwx", class: &storagev1.StorageClass{ObjectMeta: metav1.ObjectMeta{Name: "portable-rwx"}, Provisioner: "example.invalid/csi"}, reason: controllers.ReasonStorageClassNotRWX},
	} {
		t.Run(test.name, func(t *testing.T) {
			scheme := testScheme(t)
			objects := []client.Object{testHost(), testWorkspace(clusterv1alpha1.RetentionPolicyDelete)}
			if test.class != nil {
				objects = append(objects, test.class)
			}
			c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&clusterv1alpha1.T4Workspace{}).WithObjects(objects...).Build()
			r := &controllers.WorkspaceReconciler{Client: c, Scheme: scheme}
			reconcileMany(t, 2, func() error {
				_, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: types.NamespacedName{Namespace: "team", Name: "workspace-a"}})
				return err
			})
			var pvcs corev1.PersistentVolumeClaimList
			if err := c.List(context.Background(), &pvcs, client.InNamespace("team")); err != nil {
				t.Fatal(err)
			}
			if len(pvcs.Items) != 0 {
				t.Fatalf("fail-closed path created %d PVCs", len(pvcs.Items))
			}
			var got clusterv1alpha1.T4Workspace
			if err := c.Get(context.Background(), types.NamespacedName{Namespace: "team", Name: "workspace-a"}, &got); err != nil {
				t.Fatal(err)
			}
			condition := findCondition(got.Status.Conditions, "StorageReady")
			if condition == nil || condition.Status != metav1.ConditionFalse || condition.Reason != test.reason {
				t.Fatalf("StorageReady = %#v, want False/%s", condition, test.reason)
			}
		})
	}
}

func TestRetainDeletionOrphansPVCBeforeRemovingFinalizer(t *testing.T) {
	scheme := testScheme(t)
	workspace := testWorkspace(clusterv1alpha1.RetentionPolicyRetain)
	workspace.UID = "workspace-uid"
	workspace.Finalizers = []string{clusterv1alpha1.WorkspaceFinalizer}
	pvc := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{
			Name:      controllers.WorkspacePVCName(workspace),
			Namespace: workspace.Namespace,
			OwnerReferences: []metav1.OwnerReference{{
				APIVersion: clusterv1alpha1.GroupVersion.String(), Kind: "T4Workspace", Name: workspace.Name, UID: workspace.UID, Controller: ptr(true),
			}},
		},
		Spec: corev1.PersistentVolumeClaimSpec{AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}},
	}
	c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&clusterv1alpha1.T4Workspace{}).WithObjects(testHost(), rwxStorageClass(), workspace, pvc).Build()
	if err := c.Delete(context.Background(), workspace); err != nil {
		t.Fatal(err)
	}
	r := &controllers.WorkspaceReconciler{Client: c, Scheme: scheme}
	reconcileMany(t, 2, func() error {
		_, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(workspace)})
		return err
	})
	var retained corev1.PersistentVolumeClaim
	if err := c.Get(context.Background(), client.ObjectKeyFromObject(pvc), &retained); err != nil {
		t.Fatalf("retained PVC was deleted: %v", err)
	}
	if len(retained.OwnerReferences) != 0 || retained.Annotations[clusterv1alpha1.RetainedPVCAnnotation] != "true" {
		t.Fatalf("retained PVC was not orphaned safely: %#v", retained.ObjectMeta)
	}
	var gone clusterv1alpha1.T4Workspace
	if err := c.Get(context.Background(), client.ObjectKeyFromObject(workspace), &gone); !apierrors.IsNotFound(err) {
		t.Fatalf("workspace should be deleted after retention, got %v", err)
	}
}

func TestWorkspaceDeletionWaitsForSessionResources(t *testing.T) {
	scheme := testScheme(t)
	workspace := testWorkspace(clusterv1alpha1.RetentionPolicyRetain)
	workspace.UID = "workspace-uid"
	workspace.Finalizers = []string{clusterv1alpha1.WorkspaceFinalizer}
	pvc := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{
			Name: controllers.WorkspacePVCName(workspace), Namespace: workspace.Namespace,
			OwnerReferences: []metav1.OwnerReference{{APIVersion: clusterv1alpha1.GroupVersion.String(), Kind: "T4Workspace", Name: workspace.Name, UID: workspace.UID, Controller: ptr(true)}},
		},
		Spec: corev1.PersistentVolumeClaimSpec{AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}},
	}
	session := testSession()
	session.Spec.WorkspaceRef = workspace.Name
	c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&clusterv1alpha1.T4Workspace{}).WithObjects(workspace, pvc, session).Build()
	if err := c.Delete(context.Background(), workspace); err != nil { t.Fatal(err) }
	r := &controllers.WorkspaceReconciler{Client: c, Scheme: scheme}
	if _, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(workspace)}); err != nil { t.Fatal(err) }
	var waiting clusterv1alpha1.T4Workspace
	if err := c.Get(context.Background(), client.ObjectKeyFromObject(workspace), &waiting); err != nil { t.Fatalf("workspace deletion did not wait: %v", err) }
	condition := findCondition(waiting.Status.Conditions, "Ready")
	if condition == nil || condition.Reason != "SessionsRemain" { t.Fatalf("Ready = %#v, want SessionsRemain", condition) }
	var retained corev1.PersistentVolumeClaim
	if err := c.Get(context.Background(), client.ObjectKeyFromObject(pvc), &retained); err != nil { t.Fatalf("workspace PVC changed during wait: %v", err) }
	if len(retained.OwnerReferences) != 1 { t.Fatalf("workspace PVC was orphaned before sessions exited: %#v", retained.OwnerReferences) }
}

func TestSessionWaitsForBoundRWXThenCreatesExactlyOnePodAndService(t *testing.T) {
	scheme := testScheme(t)
	workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
	workspace.Status.PVCName = "workspace-a-data"
	workspace.Status.Phase = clusterv1alpha1.InfrastructurePending
	pvc := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{Name: workspace.Status.PVCName, Namespace: "team"},
		Spec:       corev1.PersistentVolumeClaimSpec{AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}},
		Status:     corev1.PersistentVolumeClaimStatus{Phase: corev1.ClaimPending},
	}
	session := testSession()
	c := fake.NewClientBuilder().WithScheme(scheme).
		WithStatusSubresource(&clusterv1alpha1.T4Workspace{}, &clusterv1alpha1.T4Session{}, &corev1.PersistentVolumeClaim{}, &corev1.Pod{}).
		WithObjects(testHost(), workspace, pvc, session).Build()
	r := &controllers.SessionReconciler{Client: c, Scheme: scheme, RuntimeImage: "registry.example/t4/session@sha256:0123456789abcdef"}
	reconcileMany(t, 2, func() error {
		_, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)})
		return err
	})
	assertObjectCounts(t, c, 0, 0)

	if err := c.Get(context.Background(), client.ObjectKeyFromObject(pvc), pvc); err != nil {
		t.Fatal(err)
	}
	pvc.Status.Phase = corev1.ClaimBound
	pvc.Status.Capacity = corev1.ResourceList{corev1.ResourceStorage: apiresource.MustParse("10Gi")}
	if err := c.Status().Update(context.Background(), pvc); err != nil {
		t.Fatal(err)
	}
	reconcileMany(t, 4, func() error {
		_, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)})
		return err
	})
	assertObjectCounts(t, c, 1, 1)

	var pods corev1.PodList
	if err := c.List(context.Background(), &pods, client.InNamespace("team")); err != nil {
		t.Fatal(err)
	}
	pod := pods.Items[0]
	if pod.Spec.AutomountServiceAccountToken == nil || *pod.Spec.AutomountServiceAccountToken {
		t.Fatal("session pod must disable automatic ServiceAccount token mounting")
	}
	if pod.Spec.Containers[0].Image != r.RuntimeImage {
		t.Fatalf("controller did not use administrator-owned runtime image: %q", pod.Spec.Containers[0].Image)
	}
	if pod.Spec.Containers[0].SecurityContext == nil || pod.Spec.Containers[0].SecurityContext.Privileged != nil && *pod.Spec.Containers[0].SecurityContext.Privileged {
		t.Fatal("session runtime is not restricted")
	}
	if !hasMount(pod.Spec.Containers[0].VolumeMounts, "workspace", "/workspace") || !hasMount(pod.Spec.Containers[0].VolumeMounts, "shared-memory", "/dev/shm") {
		t.Fatalf("session mounts = %#v", pod.Spec.Containers[0].VolumeMounts)
	}
	if pod.Spec.ServiceAccountName != controllers.DefaultSessionServiceAccount {
		t.Fatalf("session ServiceAccount = %q", pod.Spec.ServiceAccountName)
	}
	serverIdentity := ""
	for _, env := range pod.Spec.Containers[0].Env {
		if env.ValueFrom != nil && env.ValueFrom.SecretKeyRef != nil {
			t.Fatalf("session environment references a credential Secret: %#v", env)
		}
		if env.Name == "T4_CLUSTER_SERVER_SERVICE_ACCOUNT" {
			serverIdentity = env.Value
		}
	}
	if serverIdentity != controllers.DefaultServerServiceAccount {
		t.Fatalf("expected server ServiceAccount = %q", serverIdentity)
	}
	if !hasMount(pod.Spec.Containers[0].VolumeMounts, "kubernetes-api-access", "/var/run/secrets/kubernetes.io/serviceaccount") {
		t.Fatal("explicit Kubernetes reviewer projection is not mounted")
	}
	var projection *corev1.ProjectedVolumeSource
	for _, volume := range pod.Spec.Volumes {
		if volume.Name == "kubernetes-api-access" {
			projection = volume.Projected
		}
	}
	if projection == nil || len(projection.Sources) != 3 {
		t.Fatalf("Kubernetes reviewer projection = %#v", projection)
	}
	serviceToken := projection.Sources[0].ServiceAccountToken
	if serviceToken == nil || serviceToken.Audience != controllers.KubernetesAPIAudience || serviceToken.ExpirationSeconds == nil || *serviceToken.ExpirationSeconds != controllers.SessionReviewerTokenExpirationSeconds || serviceToken.Path != "token" {
		t.Fatalf("reviewer token projection = %#v", serviceToken)
	}
	clusterCA := projection.Sources[1].ConfigMap
	if clusterCA == nil || clusterCA.Name != "kube-root-ca.crt" || len(clusterCA.Items) != 1 || clusterCA.Items[0].Key != "ca.crt" || clusterCA.Items[0].Path != "ca.crt" {
		t.Fatalf("cluster CA projection = %#v", clusterCA)
	}
	namespace := projection.Sources[2].DownwardAPI
	if namespace == nil || len(namespace.Items) != 1 || namespace.Items[0].Path != "namespace" || namespace.Items[0].FieldRef == nil || namespace.Items[0].FieldRef.FieldPath != "metadata.namespace" {
		t.Fatalf("namespace projection = %#v", namespace)
	}
}

func TestSessionRejectsUnownedDeterministicResources(t *testing.T) {
	scheme := testScheme(t)
	workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
	workspace.Status.PVCName = "workspace-a-data"
	pvc := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{Name: workspace.Status.PVCName, Namespace: "team"},
		Spec: corev1.PersistentVolumeClaimSpec{AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}},
		Status: corev1.PersistentVolumeClaimStatus{Phase: corev1.ClaimBound},
	}
	session := testSession()
	service := &corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: controllers.SessionServiceName(session), Namespace: "team"}}
	c := fake.NewClientBuilder().WithScheme(scheme).
		WithStatusSubresource(&clusterv1alpha1.T4Session{}, &corev1.PersistentVolumeClaim{}).
		WithObjects(testHost(), workspace, pvc, session, service).Build()
	r := &controllers.SessionReconciler{Client: c, Scheme: scheme, RuntimeImage: "registry.example/session@sha256:deadbeef"}
	if _, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)}); err != nil { t.Fatal(err) }
	var got clusterv1alpha1.T4Session
	if err := c.Get(context.Background(), client.ObjectKeyFromObject(session), &got); err != nil { t.Fatal(err) }
	condition := findCondition(got.Status.Conditions, "Available")
	if condition == nil || condition.Reason != "ServiceOwnershipConflict" || got.Status.Phase != clusterv1alpha1.InfrastructureFailed {
		t.Fatalf("collision status = %#v/%q", condition, got.Status.Phase)
	}
	var pods corev1.PodList
	if err := c.List(context.Background(), &pods, client.InNamespace("team")); err != nil { t.Fatal(err) }
	if len(pods.Items) != 0 { t.Fatalf("collision created %d pods", len(pods.Items)) }
}

func TestSessionRecreatesPodWhenImmutableDesiredStateChanges(t *testing.T) {
	scheme := testScheme(t)
	workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
	workspace.Status.PVCName = "workspace-a-data"
	pvc := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{Name: workspace.Status.PVCName, Namespace: "team"},
		Spec: corev1.PersistentVolumeClaimSpec{AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}},
		Status: corev1.PersistentVolumeClaimStatus{Phase: corev1.ClaimBound},
	}
	session := testSession()
	session.UID = "session-uid"
	c := fake.NewClientBuilder().WithScheme(scheme).
		WithStatusSubresource(&clusterv1alpha1.T4Session{}, &corev1.PersistentVolumeClaim{}, &corev1.Pod{}).
		WithObjects(testHost(), workspace, pvc, session).Build()
	r := &controllers.SessionReconciler{Client: c, Scheme: scheme, RuntimeImage: "registry.example/session@sha256:old"}
	reconcileMany(t, 2, func() error {
		_, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)})
		return err
	})
	var original corev1.Pod
	if err := c.Get(context.Background(), types.NamespacedName{Namespace: "team", Name: controllers.SessionPodName(session)}, &original); err != nil { t.Fatal(err) }
	originalHash := original.Annotations[clusterv1alpha1.SessionPodSpecHashAnnotation]
	r.RuntimeImage = "registry.example/session@sha256:new"
	if _, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)}); err != nil { t.Fatal(err) }
	var deleted corev1.Pod
	if err := c.Get(context.Background(), types.NamespacedName{Namespace: "team", Name: controllers.SessionPodName(session)}, &deleted); !apierrors.IsNotFound(err) {
		t.Fatalf("outdated pod remains after immutable desired state changed: %v", err)
	}
	reconcileMany(t, 2, func() error {
		_, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)})
		return err
	})
	var replacement corev1.Pod
	if err := c.Get(context.Background(), types.NamespacedName{Namespace: "team", Name: controllers.SessionPodName(session)}, &replacement); err != nil { t.Fatal(err) }
	if replacement.Spec.Containers[0].Image != r.RuntimeImage || replacement.Annotations[clusterv1alpha1.SessionPodSpecHashAnnotation] == originalHash {
		t.Fatalf("replacement pod did not converge: image=%q annotations=%#v", replacement.Spec.Containers[0].Image, replacement.Annotations)
	}
}

func TestSessionDeletionCleansResourcesBeforeFinalizer(t *testing.T) {
	scheme := testScheme(t)
	session := testSession()
	session.UID = "session-uid"
	session.Finalizers = []string{clusterv1alpha1.SessionFinalizer}
	pod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: controllers.SessionPodName(session), Namespace: "team"}}
	service := &corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: controllers.SessionServiceName(session), Namespace: "team"}}
	c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&clusterv1alpha1.T4Session{}).WithObjects(session, pod, service).Build()
	if err := c.Delete(context.Background(), session); err != nil {
		t.Fatal(err)
	}
	r := &controllers.SessionReconciler{Client: c, Scheme: scheme, RuntimeImage: "registry.example/session@sha256:deadbeef"}
	reconcileMany(t, 3, func() error {
		_, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)})
		return err
	})
	assertObjectCounts(t, c, 0, 0)
	var gone clusterv1alpha1.T4Session
	if err := c.Get(context.Background(), client.ObjectKeyFromObject(session), &gone); !apierrors.IsNotFound(err) {
		t.Fatalf("session finalizer removed before cleanup completed: %v", err)
	}
}

func testScheme(t *testing.T) *runtime.Scheme {
	t.Helper()
	scheme := runtime.NewScheme()
	for _, add := range []func(*runtime.Scheme) error{corev1.AddToScheme, storagev1.AddToScheme, clusterv1alpha1.AddToScheme} {
		if err := add(scheme); err != nil {
			t.Fatal(err)
		}
	}
	return scheme
}

func testHost() *clusterv1alpha1.T4ClusterHost {
	return &clusterv1alpha1.T4ClusterHost{
		ObjectMeta: metav1.ObjectMeta{Name: "host-a", Namespace: "team", UID: "host-uid"},
		Spec:       clusterv1alpha1.T4ClusterHostSpec{StorageClassName: "portable-rwx", RuntimeProfiles: []string{"default"}},
	}
}

func rwxStorageClass() *storagev1.StorageClass {
	return &storagev1.StorageClass{
		ObjectMeta:  metav1.ObjectMeta{Name: "portable-rwx", Annotations: map[string]string{clusterv1alpha1.RWXStorageClassAnnotation: string(corev1.ReadWriteMany)}},
		Provisioner: "example.invalid/csi",
	}
}

func testWorkspace(policy clusterv1alpha1.RetentionPolicy) *clusterv1alpha1.T4Workspace {
	return &clusterv1alpha1.T4Workspace{
		ObjectMeta: metav1.ObjectMeta{Name: "workspace-a", Namespace: "team", Generation: 3},
		Spec: clusterv1alpha1.T4WorkspaceSpec{
			HostRef: "host-a", DisplayName: "Workspace A", Owner: "team-a", Size: apiresource.MustParse("10Gi"), RetentionPolicy: policy,
		},
	}
}

func testSession() *clusterv1alpha1.T4Session {
	return &clusterv1alpha1.T4Session{
		ObjectMeta: metav1.ObjectMeta{Name: "session-a", Namespace: "team", Generation: 2},
		Spec:       clusterv1alpha1.T4SessionSpec{HostRef: "host-a", WorkspaceRef: "workspace-a", Title: "Session A", RuntimeProfile: "default", GUIEnabled: true},
	}
}

func reconcileMany(t *testing.T, count int, reconcile func() error) {
	t.Helper()
	for i := 0; i < count; i++ {
		if err := reconcile(); err != nil {
			t.Fatalf("reconcile %d: %v", i+1, err)
		}
	}
}

func assertObjectCounts(t *testing.T, c client.Client, wantPods, wantServices int) {
	t.Helper()
	var pods corev1.PodList
	var services corev1.ServiceList
	if err := c.List(context.Background(), &pods, client.InNamespace("team")); err != nil {
		t.Fatal(err)
	}
	if err := c.List(context.Background(), &services, client.InNamespace("team")); err != nil {
		t.Fatal(err)
	}
	if len(pods.Items) != wantPods || len(services.Items) != wantServices {
		t.Fatalf("pods/services = %d/%d, want %d/%d", len(pods.Items), len(services.Items), wantPods, wantServices)
	}
}

func findCondition(conditions []metav1.Condition, conditionType string) *metav1.Condition {
	for i := range conditions {
		if conditions[i].Type == conditionType {
			return &conditions[i]
		}
	}
	return nil
}

func contains(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func hasMount(mounts []corev1.VolumeMount, name, path string) bool {
	for _, mount := range mounts {
		if mount.Name == name && mount.MountPath == path {
			return true
		}
	}
	return false
}

func ptr[T any](value T) *T { return &value }
