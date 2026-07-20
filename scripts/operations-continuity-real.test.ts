import { test } from "vitest";
import { runOperationsContinuity } from "./operations-continuity-real.mjs";

test(
  "preserves OMP and T4 session continuity through ownership, reconnect, restart, and cleanup",
  async () => {
    const ompRepo = process.env.T4_OMP_SOURCE_DIR;
    if (!ompRepo) throw new Error("set T4_OMP_SOURCE_DIR to the Lycaon OMP source worktree");
    await runOperationsContinuity(["--omp-repo", ompRepo]);
  },
  600_000,
);
