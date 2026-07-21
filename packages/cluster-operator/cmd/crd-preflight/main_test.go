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
		name string
		code string
	}{
		{name: "openapi maxLength", code: "okay"},
		{name: "CEL rule", code: "bad"},
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
			if err := validateFixtures(crds, fixtures); err == nil {
				t.Fatal("fixture incompatible with the proposed spec schema was accepted")
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

