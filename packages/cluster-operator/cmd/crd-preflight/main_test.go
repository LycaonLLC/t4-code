package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const candidateCRD = `apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: widgets.cluster.t4.dev
spec:
  group: cluster.t4.dev
  scope: Namespaced
  names:
    plural: widgets
    singular: widget
    kind: Widget
    listKind: WidgetList
  versions:
    - name: v1alpha1
      served: true
      storage: true
      subresources:
        status: {}
      schema:
        openAPIV3Schema:
          type: object
          required: [spec]
          properties:
            apiVersion:
              type: string
            kind:
              type: string
            metadata:
              type: object
            spec:
              type: object
              required: [code]
              x-kubernetes-validations:
                - rule: self.code.startsWith('ok')
                  message: code must start with ok
              properties:
                code:
                  type: string
                  maxLength: 3
            status:
              type: object
              properties:
                phase:
                  type: string
                  enum: [Ready]
`

func TestValidateFixturesRejectsProposedSpecTighteningAndCEL(t *testing.T) {
	for _, test := range []struct {
		name          string
		code          string
		expectedError string
	}{
		{name: "openapi maxLength", code: "okay", expectedError: "proposed OpenAPI validation failed"},
		{name: "CEL rule", code: "bad", expectedError: "proposed CEL create validation failed"},
	} {
		t.Run(test.name, func(t *testing.T) {
			crds, fixtures := writeCandidate(t, `apiVersion: cluster.t4.dev/v1alpha1
kind: Widget
metadata:
  name: legacy
spec:
  code: `+test.code+"\n"+`status:
  phase: Ready
`)
			err := validateFixtures(crds, fixtures)
			if err == nil {
				t.Fatal("fixture incompatible with the proposed spec schema was accepted")
			}
			if !strings.Contains(err.Error(), test.expectedError) {
				t.Fatalf("validation error %q does not identify %q", err, test.expectedError)
			}
		})
	}
}

func TestValidateFixturesRejectsPersistedStatusAgainstProposedSchema(t *testing.T) {
	crds, fixtures := writeCandidate(t, `apiVersion: cluster.t4.dev/v1alpha1
kind: Widget
metadata:
  name: legacy
spec:
  code: ok
status:
  phase: Legacy
`)
	if err := validateFixtures(crds, fixtures); err == nil {
		t.Fatal("persisted status incompatible with the proposed status schema was accepted")
	}
}

func TestValidateFixturesRejectsUnchangedLegacyValuesUnderTransitionCEL(t *testing.T) {
	tests := []struct {
		name         string
		fixture      string
		expectedPath string
		candidate    func(string) string
	}{
		{
			name:         "spec transition rule",
			expectedPath: "fixture.spec.code",
			fixture: `apiVersion: cluster.t4.dev/v1alpha1
kind: Widget
metadata:
  name: legacy
spec:
  code: bad
status:
  phase: Ready
`,
			candidate: func(crd string) string {
				crd = strings.Replace(crd, "rule: self.code.startsWith('ok')", `rule: "true"`, 1)
				return strings.Replace(crd, "                  maxLength: 3", "                  maxLength: 3\n                  x-kubernetes-validations:\n                    - rule: oldSelf.startsWith('ok')", 1)
			},
		},
		{
			name:         "status transition rule",
			expectedPath: "fixture.status.phase",
			fixture: `apiVersion: cluster.t4.dev/v1alpha1
kind: Widget
metadata:
  name: legacy
spec:
  code: ok
status:
  phase: Pending
`,
			candidate: func(crd string) string {
				return strings.Replace(crd, "                  enum: [Ready]", "                  enum: [Ready, Pending]\n                  x-kubernetes-validations:\n                    - rule: oldSelf == 'Ready'", 1)
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			crds, fixtures := writeCandidate(t, test.fixture)
			if err := os.WriteFile(filepath.Join(crds, "widget.yaml"), []byte(test.candidate(candidateCRD)), 0o644); err != nil {
				t.Fatal(err)
			}
			err := validateFixtures(crds, fixtures)
			if err == nil {
				t.Fatal("unchanged persisted value blocked by transition CEL was accepted")
			}
			if !strings.Contains(err.Error(), "proposed CEL unchanged-update validation failed") {
				t.Fatalf("validation error does not identify unchanged-update semantics: %v", err)
			}
			if !strings.Contains(err.Error(), test.expectedPath) {
				t.Fatalf("validation error %q does not identify field %q", err, test.expectedPath)
			}
		})
	}
}

func TestVerifyServedSchemasRejectsRetainedEstablishedWithStaleSchema(t *testing.T) {
	crds, _ := writeCandidate(t, `apiVersion: cluster.t4.dev/v1alpha1
kind: Widget
metadata:
  name: legacy
spec:
  code: ok
`)
	staleDiscovery := strings.NewReader(`{
  "openapi": "3.0.0",
  "components": {"schemas": {
    "cluster.t4.dev.v1alpha1.Widget": {
      "type": "object",
      "required": ["spec"],
      "properties": {
        "apiVersion": {"type": "string"},
        "kind": {"type": "string"},
        "metadata": {"type": "object"},
        "spec": {
          "type": "object",
          "required": ["code"],
          "x-kubernetes-validations": [{"rule": "self.code.startsWith('ok')", "message": "code must start with ok"}],
          "properties": {"code": {"type": "string", "maxLength": 8}}
        },
        "status": {"type": "object", "properties": {"phase": {"type": "string", "enum": ["Ready"]}}}
      },
      "x-kubernetes-group-version-kind": [{"group":"cluster.t4.dev","version":"v1alpha1","kind":"Widget"}]
    }
  }}
}`)
	if err := verifyServedSchemas(crds, staleDiscovery); err == nil {
		t.Fatal("stale served OpenAPI schema was accepted after Established")
	}
}

func TestVerifyServedSchemasAcceptsExactProposedSemantics(t *testing.T) {
	crds, _ := writeCandidate(t, `apiVersion: cluster.t4.dev/v1alpha1
kind: Widget
metadata:
  name: legacy
spec:
  code: ok
`)
	discovery := strings.NewReader(`{
  "openapi": "3.0.0",
  "components": {"schemas": {
    "cluster.t4.dev.v1alpha1.Widget": {
      "type": "object",
      "required": ["spec"],
      "properties": {
        "apiVersion": {"type": "string"},
        "kind": {"type": "string"},
        "metadata": {"type": "object"},
        "spec": {
          "type": "object",
          "required": ["code"],
          "x-kubernetes-validations": [{"rule": "self.code.startsWith('ok')", "message": "code must start with ok"}],
          "properties": {"code": {"type": "string", "maxLength": 3}}
        },
        "status": {"type": "object", "properties": {"phase": {"type": "string", "enum": ["Ready"]}}}
      },
      "x-kubernetes-group-version-kind": [{"group":"cluster.t4.dev","version":"v1alpha1","kind":"Widget"}]
    }
  }}
}`)
	if err := verifyServedSchemas(crds, discovery); err != nil {
		t.Fatalf("exact proposed schema rejected: %v", err)
	}
}

func writeCandidate(t *testing.T, fixture string) (string, string) {
	t.Helper()
	root := t.TempDir()
	crds := filepath.Join(root, "crds")
	fixtures := filepath.Join(root, "fixtures")
	for _, directory := range []string{crds, fixtures} {
		if err := os.Mkdir(directory, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(crds, "widget.yaml"), []byte(candidateCRD), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(fixtures, "widget.yaml"), []byte(fixture), 0o644); err != nil {
		t.Fatal(err)
	}
	return crds, fixtures
}

