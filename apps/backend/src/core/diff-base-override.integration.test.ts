import { expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as shell from "./shell.js";
import {
  diffBaseGitForEnvironment,
  listDiffBaseBranches,
  resolveDiffBaseOverride,
} from "./diff-base-override.js";
import { createEnvironment } from "./storage.js";
import { createPublicApiHarness, headCommit } from "./public-api/test-support.js";
import { environmentBaselineCommit } from "@orkestrator/protocol/diff-stats";
import { discardedRuntimeSetupUpdates } from "./commands-environment.js";

const OVERRIDE_TEST_DEADLINE_MS = 30_000;
const STEP_REPORT_AT_MS = OVERRIDE_TEST_DEADLINE_MS - 2_000;

// Bun reports only "timed out" at a deadline and leaves the test body suspended,
// so its finally never runs. The report has to fire from a timer before that.
// Labels and timings only: no paths, command output or file contents.
function startStepTrace(reportAtMs: number, write: (line: string) => void = console.error) {
  const startedAt = performance.now();
  const finished: string[] = [];
  let running: { label: string; startedAt: number } | undefined;
  const since = (time: number) => Math.round(performance.now() - time);
  const watchdog = setTimeout(() => {
    const load = os
      .loadavg()
      .map((value) => value.toFixed(1))
      .join("/");
    const waiting = running
      ? `waiting on "${running.label}" for ${since(running.startedAt)} ms`
      : "between steps";
    write(
      `[diff-base-override] ${since(startedAt)} ms elapsed, load ${load} on ${os.cpus().length} cores; ` +
        `${waiting}; finished: ${finished.join(", ") || "none"}`,
    );
  }, reportAtMs);
  return {
    async step<T>(label: string, run: () => Promise<T>): Promise<T> {
      running = { label, startedAt: performance.now() };
      const current = running;
      try {
        return await run();
      } finally {
        finished.push(`${label} ${since(current.startedAt)}`);
        running = undefined;
      }
    },
    stop: () => clearTimeout(watchdog),
  };
}

async function withTraceLifetime<T>(trace: { stop: () => void }, run: () => Promise<T>) {
  try {
    return await run();
  } finally {
    trace.stop();
  }
}

for (const phase of ["setup", "cleanup"]) {
  test(`the trace is stopped when ${phase} rejects`, async () => {
    const lines: string[] = [];
    const trace = startStepTrace(10, (line) => lines.push(line));
    await expect(
      withTraceLifetime(trace, async () => {
        try {
          if (phase === "setup") throw new Error("setup failed");
        } finally {
          if (phase === "cleanup") await Promise.reject(new Error("cleanup failed"));
        }
      }),
    ).rejects.toThrow(`${phase} failed`);
    await Bun.sleep(20);
    expect(lines).toEqual([]);
  });
}

test("the step trace names the step still running when it reports", async () => {
  const lines: string[] = [];
  const { promise: reported, resolve } = Promise.withResolvers<void>();
  const trace = startStepTrace(1, (line) => {
    lines.push(line);
    resolve();
  });
  await trace.step("first", async () => undefined);
  await trace.step("stalled", () => reported);
  trace.stop();
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/waiting on "stalled" for \d+ ms; finished: first \d+$/);
});

// Exercise real Git, storage, command registration, scan targeting and file restoration.
test(
  "saved/reset overrides retarget real scans and reverts; replacement drops an unpushed base",
  async () => {
    const trace = startStepTrace(STEP_REPORT_AT_MS);
    const { step } = trace;
    return withTraceLifetime(trace, async () => {
      let harness: Awaited<ReturnType<typeof createPublicApiHarness>> | undefined;
      try {
        const h = await step("createPublicApiHarness", () => createPublicApiHarness());
        harness = h;
        const { projectPath, originPath } = await step("createRepository", () =>
          h.createRepository("comparison"),
        );
        const initial = await step("headCommit", () => headCommit(projectPath));
        const file = path.join(projectPath, "README.md");
        const git = (args: string[]) => shell.runCommand("git", ["-C", projectPath, ...args]);
        await fs.writeFile(file, "unpushed base\n");
        await step("git add", () => git(["add", "."]));
        await step("git commit", () =>
          git([
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-m",
            "Unpushed base",
          ]),
        );
        const unpushed = await step("headCommit", () => headCommit(projectPath));
        const environment = await step("addEnvironment", () =>
          h.storage.addEnvironment({
            ...createEnvironment("project", { environmentType: "local" }),
            worktreePath: projectPath,
            createdFromCommit: initial,
            status: "running",
          }),
        );
        const command = (name: string, args: Record<string, unknown>) =>
          step(name, async () => h.commands.get(name)!(args, h.context));
        const read = (worktreePath: string, comparisonRef: string) =>
          step("readFileList", () =>
            h.context.runtime.diffStats.service.readFileList({
              lookup: { worktreePath },
              comparisonRef,
              includeUncommitted: true,
              refresh: true,
            }),
          );
        await command("set_environment_diff_base", {
          environmentId: environment.id,
          ref: "refs/heads/main",
          commit: unpushed,
        });
        expect((await h.storage.getEnvironment(environment.id))?.diffBaseOverride?.commit).toBe(
          unpushed,
        );
        await read(projectPath, unpushed);
        expect(
          h.context.runtime.diffStats.service
            .revisionedWorktreeSnapshot()
            .entries.find((e) => e.environmentId === environment.id)?.comparisonRef,
        ).toBe(unpushed);
        await fs.writeFile(file, "dirty\n");
        await command("revert_local_file", {
          environmentId: environment.id,
          filePath: "README.md",
          targetBranch: unpushed,
        });
        expect(await fs.readFile(file, "utf8")).toBe("unpushed base\n");
        await command("set_environment_diff_base", {
          environmentId: environment.id,
          ref: null,
          commit: null,
        });
        await read(projectPath, initial);
        expect(
          h.context.runtime.diffStats.service
            .revisionedWorktreeSnapshot()
            .entries.find((e) => e.environmentId === environment.id)?.comparisonRef,
        ).toBe(initial);
        await command("revert_local_file", {
          environmentId: environment.id,
          filePath: "README.md",
          targetBranch: initial,
        });
        expect(await fs.readFile(file, "utf8")).toBe("# comparison\n");
        await command("set_environment_diff_base", {
          environmentId: environment.id,
          ref: "refs/heads/main",
          commit: unpushed,
        });
        const replacement = path.join(h.root, "replacement");
        await step("git clone", () => shell.runCommand("git", ["clone", originPath, replacement]));
        const freshGit = diffBaseGitForEnvironment({
          environmentType: "local",
          worktreePath: replacement,
          containerId: null,
          status: "running",
        });
        await expect(
          step("git cat-file", () => freshGit(["cat-file", "-e", unpushed])),
        ).rejects.toThrow();
        const replaced = await step("updateEnvironment", () =>
          h.storage.updateEnvironment(environment.id, {
            ...discardedRuntimeSetupUpdates(),
            worktreePath: replacement,
          }),
        );
        expect(replaced.diffBaseOverride).toBeNull();
        expect(environmentBaselineCommit(replaced)).toBeUndefined();
        await step("diffStats.sync", () => h.context.runtime.diffStats.sync(h.context));
        await read(replacement, "main");
        await fs.writeFile(path.join(replacement, "README.md"), "dirty again\n");
        await command("revert_local_file", {
          environmentId: environment.id,
          filePath: "README.md",
          targetBranch: "main",
        });
        expect(await fs.readFile(path.join(replacement, "README.md"), "utf8")).toBe(
          "# comparison\n",
        );
        expect(
          await step("listDiffBaseBranches", () => listDiffBaseBranches(freshGit)),
        ).toContainEqual({
          ref: "refs/heads/main",
          name: "main",
          kind: "local",
        });
        await expect(
          step("resolveDiffBaseOverride", () =>
            resolveDiffBaseOverride(freshGit, { ref: "refs/heads/main", commit: unpushed }),
          ),
        ).rejects.toThrow("not in this environment's checkout");
        const missingGit = diffBaseGitForEnvironment({
          ...replaced,
          worktreePath: path.join(h.root, "missing"),
        });
        await expect(
          step("listDiffBaseBranches missing", () => listDiffBaseBranches(missingGit)),
        ).rejects.toThrow();
        expect(() => diffBaseGitForEnvironment({ ...replaced, worktreePath: undefined })).toThrow(
          "no checkout",
        );
      } finally {
        if (harness) await step("cleanup", () => harness!.cleanup());
      }
    });
  },
  OVERRIDE_TEST_DEADLINE_MS,
);

test("container Git quotes arguments, selects /workspace and rejects stopped runtimes", async () => {
  const environment = {
    environmentType: "containerized" as const,
    worktreePath: undefined,
    containerId: "container",
    status: "running" as const,
  };
  const run = spyOn(shell, "runCommand").mockResolvedValue({ stdout: "result", stderr: "" });
  try {
    expect(
      await diffBaseGitForEnvironment(environment)(["log", "refs/heads/it's-main", "$(touch bad)"]),
    ).toBe("result");
    expect(run).toHaveBeenCalledWith(
      "docker",
      [
        "exec",
        "container",
        "bash",
        "-lc",
        `cd /workspace && git 'log' 'refs/heads/it'"'"'s-main' '$(touch bad)'`,
      ],
      { timeoutMs: 30_000, redactValues: undefined, signal: undefined },
    );
    expect(() => diffBaseGitForEnvironment({ ...environment, status: "stopped" })).toThrow(
      "Start the environment",
    );
    expect(() => diffBaseGitForEnvironment({ ...environment, containerId: null })).toThrow(
      "Start the environment",
    );
  } finally {
    run.mockRestore();
  }
});
