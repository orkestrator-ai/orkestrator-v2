import { describe, expect, mock, test } from "bun:test";
import { graphRunBranchRefPrefix } from "@orkestrator/protocol/graphs/run";
import type { GraphSystemActionContext } from "./graph-system-action.js";
import { selectWorkspaceAction } from "./graph-system-select.js";
import { graphEnvironmentFixture } from "./graph-run-test-support.js";
import { CommandFailedError } from "./shell.js";

describe("select-workspace status fallback", () => {
  for (const method of ["fast-forward", "reset"] as const) {
    test.each(["clean", "dirty", "failed", "cancelled"] as const)(
      `${method}: a timed-out status that is %s only moves a verified clean checkout`,
      async (outcome) => {
        const environment = graphEnvironmentFixture();
        const previous = "a".repeat(40);
        const chosen = "b".repeat(40);
        const controller = new AbortController();
        const cancelled = new Error("selection cancelled");
        const exhausted = new CommandFailedError("retry failed", { timedOut: true });
        const calls: string[][] = [];
        const output = mock<GraphSystemActionContext["output"]>(async () => undefined);
        const git: GraphSystemActionContext["deps"]["shell"]["git"] = async (
          env,
          args,
          options,
        ) => {
          expect(env).toBe(environment);
          expect(options).toEqual({ signal: controller.signal });
          calls.push(args);
          switch (args[0]) {
            case "symbolic-ref":
              return environment.branch;
            case "status":
              if (outcome === "cancelled") controller.abort(cancelled);
              throw new CommandFailedError("timeout", { timedOut: true });
            case "-c":
              if (outcome === "failed") throw exhausted;
              return outcome === "dirty" ? " M changed.txt\n" : "";
            case "rev-parse":
              return previous;
            case "merge-base":
              if (method === "reset") throw new Error("not an ancestor");
              return "";
            default:
              return "";
          }
        };
        // Keep the action and its branch-move checks real; replace its I/O boundaries.
        const ctx = {
          run: { id: "run-select", activations: [] },
          params: {},
          signal: controller.signal,
          now: () => new Date("2026-10-30T00:00:00Z"),
          environment: async () => environment,
          throwIfAborted: () => controller.signal.throwIfAborted(),
          inputList: async () => [
            {
              type: "workspace@1",
              producer: { activation: "builder" },
              body: {
                value: {
                  branch: `${graphRunBranchRefPrefix("run-select")}builder`,
                  headRef: chosen,
                },
              },
            },
          ],
          requireInput: async () => ({ choice: `${graphRunBranchRefPrefix("run-select")}builder` }),
          slotKey: (suffix?: string) =>
            `select-workspace:select#iter=1${suffix ? `:${suffix}` : ""}`,
          effect: async (_key: string, perform: () => Promise<unknown>) => perform(),
          output,
          deps: {
            shell: { git },
            storage: {
              graphEffects: {
                listGraphEffects: async () => [
                  {
                    key: `select-workspace:select#iter=1:${previous}`,
                    state: "done",
                    data: { headRef: previous },
                  },
                ],
              },
            },
          },
        } as unknown as GraphSystemActionContext;

        const result = selectWorkspaceAction.run!(ctx);
        if (outcome === "clean") {
          await result;
          expect(calls).toContainEqual(
            method === "fast-forward"
              ? ["merge", "--ff-only", "--quiet", chosen]
              : ["reset", "--hard", "--quiet", chosen],
          );
          expect(output).toHaveBeenCalledTimes(1);
          expect(output.mock.calls[0]?.[1]).toMatchObject({ headRef: chosen, baseRef: previous });
        } else {
          if (outcome === "dirty") await expect(result).rejects.toThrow("uncommitted changes");
          else await expect(result).rejects.toBe(outcome === "cancelled" ? cancelled : exhausted);
          expect(calls.some((args) => ["merge", "reset", "update-ref"].includes(args[0]!))).toBe(
            false,
          );
          expect(output).not.toHaveBeenCalled();
        }
        const status = ["status", "--porcelain", "--untracked-files=no"];
        expect(calls.filter((args) => args.includes("status"))).toEqual(
          outcome === "cancelled" ? [status] : [status, ["-c", "core.fsmonitor=false", ...status]],
        );
      },
    );
  }
});
