import { test } from "vitest";
import { runLegacyBridgeContinuity } from "./legacy-bridge-continuity.mjs";

test(
  "preserves T4 client continuity against the pinned legacy OMP appserver",
  async () => {
    const ompRepo = process.env.T4_OMP_SOURCE_DIR;
    if (!ompRepo) throw new Error("set T4_OMP_SOURCE_DIR to the Lycaon OMP source worktree");
    await runLegacyBridgeContinuity(["--omp-repo", ompRepo]);
  },
  600_000,
);
