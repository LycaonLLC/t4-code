#!/usr/bin/env bun

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { OmpAuthorityBridgeClient } from "../src/omp-authority-bridge-client.ts";

interface VerifiedRuntime {
  readonly sourceCommit: string;
  readonly sourceRepository: string;
  readonly sourceTag: string;
  readonly version: string;
}

function runtime(value: unknown): VerifiedRuntime {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("compatibility matrix verifiedRuntime is invalid");
  const record = value as Record<string, unknown>;
  for (const key of ["sourceCommit", "sourceRepository", "sourceTag", "version"] as const) {
    if (typeof record[key] !== "string" || record[key].length === 0)
      throw new Error(`compatibility matrix verifiedRuntime.${key} is invalid`);
  }
  return record as unknown as VerifiedRuntime;
}

async function gitHead(sourceRoot: string): Promise<string> {
  const child = Bun.spawn(["git", "rev-parse", "HEAD"], {
    cwd: sourceRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`cannot resolve current OMP source: ${stderr.trim().slice(-1_024)}`);
  return stdout.trim();
}

async function main(): Promise<void> {
  const repoRoot = resolve(import.meta.dirname, "../../..");
  const sourceRoot = process.env.T4_CURRENT_OMP_SOURCE_DIR;
  const exactSourceRoot = sourceRoot ? resolve(repoRoot, sourceRoot) : "";
  if (!exactSourceRoot.startsWith(`${repoRoot}/.current-continuity/`))
    throw new Error("T4_CURRENT_OMP_SOURCE_DIR must be the checked-out current continuity source");
  const matrix = JSON.parse(await readFile(join(repoRoot, "compat", "omp-app-matrix.json"), "utf8")) as {
    verifiedRuntime?: unknown;
  };
  const expected = runtime(matrix.verifiedRuntime);
  if (expected.sourceRepository !== "https://github.com/wolfiesch/oh-my-pi")
    throw new Error("verified runtime repository is not the owned OMP fork");
  if ((await gitHead(exactSourceRoot)) !== expected.sourceCommit)
    throw new Error("checked-out current OMP source does not match verifiedRuntime.sourceCommit");
  const cli = join(exactSourceRoot, "packages", "coding-agent", "src", "cli.ts");
  if (!(await stat(cli)).isFile()) throw new Error("current OMP CLI source is missing");

  const root = await mkdtemp(join(tmpdir(), "t4-current-omp-bridge-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const profile = `current-proof-${Bun.randomUUIDv7().slice(-12)}`;
  const client = new OmpAuthorityBridgeClient({
    executable: process.execPath,
    argv: [cli, "bridge", "--stdio"],
    cwd: exactSourceRoot,
    environment: {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      XDG_CACHE_HOME: join(home, ".cache"),
      PI_NOTIFICATIONS: "off",
      OMP_PROFILE: profile,
    },
  });
  try {
    await Promise.all([mkdir(home, { recursive: true, mode: 0o700 }), mkdir(workspace)]);
    const ready = await client.start();
    if (ready.ompVersion !== expected.version || ready.ompBuild !== "source")
      throw new Error("current OMP bridge identity does not match the verified runtime");
    const authorities = client.createAuthorities();
    const host = await authorities.hostInfo();
    const sessions = await authorities.sessionAuthority.list();
    if (!host.transcriptImageRoot.startsWith(home))
      throw new Error("current OMP bridge escaped the disposable profile");
    if (sessions.length !== 0 || !authorities.discovery.inventoryComplete?.())
      throw new Error("current OMP bridge did not return one complete disposable inventory");

    const evidence = {
      schemaVersion: 1,
      runtime: {
        repository: expected.sourceRepository,
        tag: expected.sourceTag,
        commit: expected.sourceCommit,
        version: ready.ompVersion,
        build: ready.ompBuild,
      },
      bridge: {
        protocol: "t4-omp-authority/1",
        methods: [...ready.methods].sort(),
        completeInventory: true,
        sessionCount: sessions.length,
      },
      passed: true,
    };
    const evidenceRoot = join(repoRoot, "artifacts", "current-omp-bridge");
    await mkdir(evidenceRoot, { recursive: true });
    await writeFile(join(evidenceRoot, `${process.platform}-${process.arch}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    await client.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

await main();
