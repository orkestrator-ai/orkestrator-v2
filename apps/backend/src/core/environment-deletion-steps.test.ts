import { describe, expect, test } from "bun:test";
import type { EnvironmentDeletionStep } from "@orkestrator/protocol/node-summaries";
import {
  EnvironmentDeletionDeadlineError,
  environmentDeletionSteps,
} from "./environment-deletion-steps.js";

function steps(deadlinesMs: Partial<Record<EnvironmentDeletionStep, number>> = {}) {
  const recorded: EnvironmentDeletionStep[] = [];
  const runner = environmentDeletionSteps({
    environmentId: "e1",
    deadlinesMs,
    record: async (step) => {
      recorded.push(step);
    },
  });
  return { runner, recorded };
}

describe("environment deletion steps", () => {
  test("records each step before its work starts", async () => {
    const { runner, recorded } = steps();
    await runner.enter("terminals");
    const seen = await runner.run("worktree", async () => [...recorded]);
    expect(seen).toEqual(["terminals", "worktree"]);
  });

  test("a step under its deadline returns its result and never sees the signal fire", async () => {
    const { runner } = steps({ worktree: 1_000 });
    let signal: AbortSignal | undefined;
    const result = await runner.run("worktree", async (stepSignal) => {
      signal = stepSignal;
      return "done";
    });
    expect(result).toBe("done");
    await Bun.sleep(20);
    expect(signal?.aborted).toBe(false);
  });

  test("a step past its deadline is signalled, and fails only once its work has stopped", async () => {
    const { runner } = steps({ worktree: 20 });
    let stopped = false;
    const failure = runner
      .run("worktree", (signal) => {
        // Work that takes a moment to stop after it is told to, like a killed child.
        return new Promise<void>((resolve) => {
          signal.addEventListener("abort", () =>
            setTimeout(() => {
              stopped = true;
              resolve();
            }, 30),
          );
        });
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    const error = await failure;
    expect(stopped).toBe(true);
    expect(error).toBeInstanceOf(EnvironmentDeletionDeadlineError);
    expect((error as Error).message).toBe(
      "Deletion stopped while removing the worktree: it took longer than 1 min. Retry to continue.",
    );
  });

  test("a step whose work rejects after the deadline reports the deadline, not its own error", async () => {
    const { runner } = steps({ container: 10 });
    const error = await runner
      .run("container", (signal) => {
        return new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("killed")));
        });
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EnvironmentDeletionDeadlineError);
  });

  test("a step without a deadline is never signalled, and its own failure passes through", async () => {
    const { runner } = steps();
    const error = await runner
      .run("records", async (signal) => {
        await Bun.sleep(20);
        expect(signal.aborted).toBe(false);
        throw new Error("store failed");
      })
      .catch((caught: unknown) => caught);
    expect((error as Error).message).toBe("store failed");
  });

  test("a step record that fails does not stop the delete", async () => {
    const runner = environmentDeletionSteps({
      environmentId: "e1",
      record: async () => {
        throw new Error("record gone");
      },
    });
    await runner.enter("terminals");
    expect(await runner.run("records", async () => 1)).toBe(1);
  });
});
