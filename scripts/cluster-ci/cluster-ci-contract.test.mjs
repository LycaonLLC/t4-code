import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import yaml from "js-yaml";

import {
  IMAGE_COMPONENTS,
  OBSERVATION_SYSTEMS,
  PROOF_SCENARIOS,
  createFileEvidence,
  redactFrame,
  validateProofManifest,
} from "./proof-contract.mjs";
import {
  collectReadOnlyClusterSnapshot,
  validateClusterSnapshot,
  validateDefaultOffRender,
} from "./readonly-cluster-proof.mjs";
import { HARBOR_REGISTRY_ALIASES, normalizeRegistryAuth } from "./normalize-registry-auth.mjs";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const DIGEST = `sha256:${"a".repeat(64)}`;
const FILE_SHA = "b".repeat(64);
const OBSERVED_AT = "2026-07-20T12:34:56.000Z";
const repoRoot = resolve(import.meta.dirname, "../..");

function fileEvidence(path) {
  return { path: `artifacts/cluster-proof/${path}`, sha256: FILE_SHA };
}

function validProof() {
  const suffixes = {
    controller: "t4-cluster-operator",
    "cluster-server": "t4-cluster-server",
    "session-runtime": "t4-session-runtime",
  };
  return {
    schemaVersion: "t4-cluster-proof/1",
    source: {
      repository: "z-peterson/t4-code",
      commit: COMMIT,
      woodpecker: {
        repositoryId: 71,
        pipelineId: 401,
        pipelineNumber: 99,
        url: "https://woodpecker.example.test/repos/71/pipeline/99",
      },
    },
    images: IMAGE_COMPONENTS.map((component) => {
      const repository = `harbor.example.test/t4/${suffixes[component]}`;
      return {
        component,
        repository,
        tag: COMMIT,
        digest: DIGEST,
        reference: `${repository}@${DIGEST}`,
        sbom: fileEvidence(`images/${component}.spdx.json`),
        provenance: fileEvidence(`images/${component}.provenance.json`),
        vulnerability: {
          ...fileEvidence(`images/${component}.trivy.json`),
          scanner: "trivy",
          critical: 0,
          high: 0,
        },
      };
    }),
    scenarios: PROOF_SCENARIOS.map((id) => ({
      id,
      status: "passed",
      observedAt: OBSERVED_AT,
      assertions: [`${id}.observable-contract`],
      evidence: [fileEvidence(`scenarios/${id}.json`)],
    })),
    observations: OBSERVATION_SYSTEMS.map((system, index) => ({
      system,
      observedAt: OBSERVED_AT,
      url: `https://${system}.example.test/evidence/${index + 1}`,
      ids: [`${system}-${index + 1}`],
      evidence: fileEvidence(`observations/${system}.json`),
    })),
    artifacts: {
      frames: [
        { ...fileEvidence("frames/omp-app.json"), redacted: true },
      ],
      screenshots: [
        { ...fileEvidence("screenshots/desktop.png"), redacted: true, viewport: "desktop" },
        { ...fileEvidence("screenshots/mobile.png"), redacted: true, viewport: "mobile" },
      ],
      videos: [
        { ...fileEvidence("videos/desktop.webm"), redacted: true, viewport: "desktop" },
        { ...fileEvidence("videos/mobile.webm"), redacted: true, viewport: "mobile" },
      ],
    },
  };
}

function liveClusterResponses() {
  return {
    deployments: {
      items: [
        {
          metadata: { name: "t4-cluster-controller" },
          spec: {
            replicas: 2,
            strategy: { type: "RollingUpdate", rollingUpdate: { maxUnavailable: 0 } },
          },
          status: { observedGeneration: 4, availableReplicas: 2 },
        },
        {
          metadata: { name: "t4-cluster-server" },
          spec: {
            replicas: 3,
            strategy: { type: "RollingUpdate", rollingUpdate: { maxUnavailable: 0 } },
          },
          status: { observedGeneration: 6, availableReplicas: 3 },
        },
      ],
    },
    leases: {
      items: [
        {
          metadata: { name: "t4-cluster-controller" },
          spec: { holderIdentity: "controller-7cbbc8-x7v2k", renewTime: OBSERVED_AT },
        },
      ],
    },
    customresourcedefinitions: {
      items: ["t4clusterhosts", "t4workspaces", "t4sessions"].map((plural) => ({
        spec: {
          group: "cluster.t4.dev",
          scope: "Namespaced",
          names: { plural },
          versions: [{ name: "v1alpha1", served: true, storage: true }],
        },
      })),
    },
    t4clusterhosts: {
      items: [{ metadata: { name: "development" }, status: { observedGeneration: 2 } }],
    },
    t4workspaces: {
      items: [
        {
          metadata: { name: "proof-workspace" },
          spec: { retentionPolicy: "Retain" },
          status: {
            observedGeneration: 3,
            pvcRef: { name: "proof-workspace" },
            phase: "Ready",
          },
        },
      ],
    },
    t4sessions: {
      items: [
        {
          metadata: { name: "proof-session" },
          spec: { workspaceRef: "proof-workspace" },
          status: { observedGeneration: 5, phase: "Running" },
        },
      ],
    },
    persistentvolumeclaims: {
      items: [
        {
          metadata: { name: "proof-workspace" },
          spec: { accessModes: ["ReadWriteMany"], storageClassName: "t4-workspaces-rwx" },
          status: { phase: "Bound", capacity: { storage: "20Gi" } },
        },
      ],
    },
    pods: {
      items: [
        {
          metadata: { name: "t4-session-proof-session", labels: { "cluster.t4.dev/session": "proof-session" } },
          spec: { nodeName: "k3s-worker-01" },
          status: { phase: "Running" },
        },
      ],
    },
    services: {
      items: [
        {
          metadata: { name: "t4-cluster-server" },
          spec: { ports: [{ name: "omp-app", port: 8080 }, { name: "admin", port: 9090 }] },
        },
      ],
    },
  };
}

test("Woodpecker keeps upstream gates and serializes bounded cluster publication", async () => {
  const pipeline = yaml.load(await readFile(resolve(repoRoot, ".woodpecker.yml"), "utf8"));
  assert.equal(typeof pipeline, "object");
  const steps = pipeline.steps;
  const coreCommands = steps["upstream-core"].commands;
  for (const command of [
    "pnpm check",
    "pnpm test",
    "pnpm build",
    "pnpm test:e2e",
    "pnpm test:packaging",
  ]) {
    assert.ok(coreCommands.includes(command), `upstream-core must run ${command}`);
  }
  assert.ok(steps["legacy-bridge-continuity"].commands.includes("pnpm test:legacy-bridge-continuity"));
  assert.ok(
    steps["android-debug"].commands.includes("pnpm --filter @t4-code/mobile check:android:debug"),
  );
  assert.ok(steps["cluster-ci-contracts"].commands.includes("pnpm test:cluster:ci"));
  assert.ok(
    steps["cluster-operator-tests"].commands.includes("go test ./api/... ./controllers/... ./cmd/..."),
  );
  assert.ok(
    steps["cluster-operator-tests"].commands.some((command) =>
      command.includes("go test -c ./charttests"),
    ),
  );
  assert.ok(
    steps["cluster-chart-tests"].commands.includes("helm lint ../../../deploy/charts/t4-cluster"),
  );
  assert.ok(
    steps["cluster-chart-tests"].commands.some((command) => command.endsWith("chart-contract.test")),
  );
  assert.ok(
    steps["cluster-server-tests"].commands.includes("pnpm --filter @t4-code/cluster-server test"),
  );
  assert.equal(JSON.stringify(pipeline).includes("from_secret"), false);
  assert.deepEqual(steps["harbor-auth"].depends_on, ["cluster-chart-tests", "android-debug"]);
  assert.equal(
    steps["harbor-auth"].backend_options.kubernetes.serviceAccountName,
    "woodpecker-dev-verifier",
  );
  assert.deepEqual(steps["build-controller"].depends_on, ["harbor-auth"]);
  assert.deepEqual(steps["live-cluster-observations"].depends_on, ["cleanup-image-registry-auth"]);
  assert.deepEqual(steps["publish-live-proof"].depends_on, ["harbor-auth-live-proof"]);

  const orderedBuilds = ["build-controller", "build-cluster-server", "build-session-runtime"];
  for (const [index, name] of orderedBuilds.entries()) {
    const step = steps[name];
    assert.equal(step.backend_options.kubernetes.serviceAccountName, "woodpecker-ci-untrusted");
    assert.ok(step.backend_options.kubernetes.resources.limits.memory);
    if (index > 0) assert.deepEqual(step.depends_on, [orderedBuilds[index - 1]]);
  }
  assert.match(steps["build-controller"].commands[0], /t4-cluster-operator/u);
  assert.match(steps["build-cluster-server"].commands[0], /t4-cluster-server/u);
  assert.match(steps["build-session-runtime"].commands[0], /t4-session-runtime/u);

  for (const script of ["build-image.sh", "capture-image-evidence.sh", "publish-artifact.sh"]) {
    const source = await readFile(resolve(repoRoot, "scripts/cluster-ci", script), "utf8");
    assert.doesNotMatch(source, /HARBOR_(?:USERNAME|PASSWORD)/u);
    assert.match(source, /DOCKER_CONFIG/u);
  }
});

test("registry auth is restricted to the fixed internal and tailnet Harbor aliases", () => {
  const auth = "dXNlcjpwYXNz";
  const normalized = normalizeRegistryAuth({
    auths: {
      "harbor.tailb18de3.ts.net": { auth },
      "unrelated.example": { auth: "dW53YW50ZWQ6Y3JlZGVudGlhbA==" },
    },
  });
  assert.deepEqual(Object.keys(normalized.auths), HARBOR_REGISTRY_ALIASES);
  assert.ok(Object.values(normalized.auths).every((entry) => entry.auth === auth));
  assert.equal("unrelated.example" in normalized.auths, false);
  assert.throws(() => normalizeRegistryAuth({ auths: {} }), /no bounded registry authentication entry/u);
});

test("proof schema is strict and enumerates every bounded evidence domain", async () => {
  const schema = JSON.parse(
    await readFile(resolve(repoRoot, "scripts/cluster-ci/cluster-proof.schema.json"), "utf8"),
  );
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.$defs.scenario.properties.id.enum, PROOF_SCENARIOS);
  assert.deepEqual(schema.$defs.observation.properties.system.enum, OBSERVATION_SYSTEMS);
  assert.deepEqual(schema.$defs.image.properties.component.enum, IMAGE_COMPONENTS);
  assert.equal(schema.$defs.artifacts.properties.frames.maxItems, 32);
  assert.equal(schema.$defs.artifacts.properties.videos.maxItems, 8);
});

test("proof validation accepts exact run/image/scenario identity and rejects fabricated gaps", () => {
  const proof = validProof();
  assert.equal(validateProofManifest(proof), proof);

  const missingScenario = structuredClone(proof);
  missingScenario.scenarios.pop();
  assert.throws(() => validateProofManifest(missingScenario), /scenario coverage/u);

  const failedScenario = structuredClone(proof);
  failedScenario.scenarios[0].status = "failed";
  assert.throws(() => validateProofManifest(failedScenario), /must be passed/u);

  const mutableImage = structuredClone(proof);
  mutableImage.images[0].reference = `${mutableImage.images[0].repository}:latest`;
  assert.throws(() => validateProofManifest(mutableImage), /immutable digest/u);

  const unredacted = structuredClone(proof);
  unredacted.artifacts.frames[0].redacted = false;
  assert.throws(() => validateProofManifest(unredacted), /redacted/u);

  const extra = structuredClone(proof);
  extra.source.token = "must-not-survive";
  assert.throws(() => validateProofManifest(extra), /unexpected field/u);
});

test("file evidence is content-addressed instead of trusting a claimed result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "t4-cluster-proof-"));
  const absolutePath = join(directory, "observation.json");
  await writeFile(absolutePath, '{"observed":true}\n', "utf8");
  const evidence = await createFileEvidence(absolutePath, {
    artifactRoot: directory,
    artifactPrefix: "artifacts/cluster-proof/observations",
  });
  assert.equal(evidence.path, "artifacts/cluster-proof/observations/observation.json");
  assert.match(evidence.sha256, /^[0-9a-f]{64}$/u);
  assert.notEqual(evidence.sha256, FILE_SHA);
});

test("frame redaction strips authority-sensitive content and bounds retained state", () => {
  const redacted = redactFrame({
    type: "session.state",
    sessionId: "proof-session",
    cursor: 11,
    revision: 7,
    authorization: "Bearer secret",
    token: "secret-token",
    prompt: "private prompt",
    transcript: [{ text: "private output" }],
    payload: { cookie: "private-cookie", status: "running" },
  });
  assert.deepEqual(redacted, {
    type: "session.state",
    sessionId: "proof-session",
    cursor: 11,
    revision: 7,
    authorization: "[REDACTED]",
    token: "[REDACTED]",
    prompt: "[REDACTED]",
    transcript: "[REDACTED]",
    payload: { cookie: "[REDACTED]", status: "running" },
  });
  assert.throws(() => redactFrame({ payload: "x".repeat(70_000) }), /bound/u);
});

test("read-only collection executes only bounded Kubernetes GETs", async () => {
  const responses = liveClusterResponses();
  const calls = [];
  const snapshot = await collectReadOnlyClusterSnapshot({
    namespace: "t4-development",
    run: async (command, args) => {
      calls.push([command, args]);
      assert.equal(command, "kubectl");
      assert.equal(args[0], "get");
      assert.ok(!args.some((arg) => ["apply", "create", "delete", "patch", "replace"].includes(arg)));
      return JSON.stringify(responses[args[1]]);
    },
  });
  assert.equal(calls.length, 9);
  assert.equal(validateClusterSnapshot(snapshot), snapshot);
});

test("live snapshot validation enforces HA, Lease, CRD, RWX, placement, and service ports", () => {
  const responses = liveClusterResponses();
  assert.equal(validateClusterSnapshot(responses), responses);

  const noLeader = structuredClone(responses);
  noLeader.leases.items[0].spec.holderIdentity = "";
  assert.throws(() => validateClusterSnapshot(noLeader), /leader Lease/u);

  const wrongStorage = structuredClone(responses);
  wrongStorage.persistentvolumeclaims.items[0].spec.accessModes = ["ReadWriteOnce"];
  assert.throws(() => validateClusterSnapshot(wrongStorage), /ReadWriteMany/u);

  const forbiddenPlacement = structuredClone(responses);
  forbiddenPlacement.pods.items[0].spec.nodeName = "k3s-worker-03";
  assert.throws(() => validateClusterSnapshot(forbiddenPlacement), /durable session placement/u);
});

test("default-off proof evaluates rendered resources rather than chart source text", () => {
  assert.deepEqual(
    validateDefaultOffRender([
      { apiVersion: "apiextensions.k8s.io/v1", kind: "CustomResourceDefinition", metadata: { name: "t4sessions.cluster.t4.dev" } },
    ]),
    { clusterOperatorEnabled: false, workloadCount: 0 },
  );
  assert.throws(
    () =>
      validateDefaultOffRender([
        { apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "t4-cluster-server" } },
      ]),
    /default-off render created workload/u,
  );
});
