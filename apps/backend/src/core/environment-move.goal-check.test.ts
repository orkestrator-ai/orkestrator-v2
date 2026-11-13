// Moving, stopping or deleting an environment drains a running goal check and its descendants.
import { expect, test, setDefaultTimeout } from "bun:test";
import { runGoalCheck } from "./native-agent-goal-check.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { moveEnvironmentTask } from "./environment-move.js";
import { setup, registerEnvironmentMoveFixtureHooks } from "./environment-move-test-support.js";

// This slow-tier file creates real repositories/worktrees and waits for
// subprocess cleanup. Give that fixture work its own bounded host budget;
// explicit operation deadlines and shorter test budgets remain unchanged.
setDefaultTimeout(30_000);
registerEnvironmentMoveFixtureHooks();

test.each(["stop", "delete", "move"] as const)(
  "%s drains a goal check and its descendants before changing the workspace",
  async (action) => {
    const { root, context, commands, startLocal } = await setup();
    const environment = await startLocal();
    const worker = runGoalCheck(environment, context, {
      goalId: "lifecycle-check",
      iteration: 1,
      // The parent pid is written first: the wait below polls only the child's.
      command: "echo $$ > goal-parent.pid; sleep 120 & echo $! > goal-child.pid; wait",
      timeoutMs: 120_000,
    });
    const pidFile = path.join(environment.worktreePath!, "goal-child.pid");
    try {
      const deadline = Date.now() + 10_000;
      while (!(await fs.readFile(pidFile, "utf8").catch(() => ""))) {
        if (Date.now() > deadline) throw new Error("Goal check did not start");
        await Bun.sleep(25);
      }
      const childPid = Number(await fs.readFile(pidFile, "utf8"));
      const parentPid = Number(
        await fs.readFile(path.join(environment.worktreePath!, "goal-parent.pid"), "utf8"),
      );
      const assertExited = (pid: number) => {
        try {
          process.kill(pid, 0);
          return false;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "ESRCH";
        }
      };
      if (action === "move")
        await moveEnvironmentTask(environment.id, path.join(root, "goal-moved"), context);
      else
        await commands.get(action === "stop" ? "stop_environment" : "delete_environment")!(
          { environmentId: environment.id },
          context,
        );
      expect(assertExited(parentPid)).toBe(true);
      expect(assertExited(childPid)).toBe(true);
      await worker;
      expect(
        (await fs.readdir(path.join(context.storage.getDataDir(), "exec-runs"))).filter((name) =>
          name.startsWith("goal-check-"),
        ),
      ).toEqual([]);
    } finally {
      const { stopEnvironmentExecWorkers } = await import("./public-api/exec-control.js");
      await stopEnvironmentExecWorkers(environment.id, context);
      await worker;
    }
  },
  30_000,
);
