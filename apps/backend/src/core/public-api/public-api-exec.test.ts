import { afterEach, describe, expect, jest, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PublicReceipt } from "@orkestrator/protocol/public-api";
import type { PublicExecOutputWindow } from "@orkestrator/protocol/public-api-resources";
import { createProject } from "../storage.js";
import { runCommand } from "../shell.js";
import { createPublicApiHarness, type PublicApiHarness } from "./test-support.js";

/**
 * `environment.exec` against real local processes: the environment-side
 * worker, its state file and bounded artifacts, and the backend's
 * reconciliation. Success is read from the recorded process result, never
 * from output.
 */

jest.setTimeout(60_000);

const harnesses: PublicApiHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
});

async function setup(
  options: Parameters<typeof createPublicApiHarness>[0] = {},
): Promise<{ harness: PublicApiHarness; worktree: string }> {
  const harness = await createPublicApiHarness(options);
  harnesses.push(harness);
  const worktree = path.join(harness.root, "worktree");
  await fs.mkdir(path.join(worktree, "sub"), { recursive: true });
  const project = await harness.storage.addProject(
    createProject("https://example.invalid/exec.git"),
  );
  await harness.storage.addEnvironment({
    id: "env-exec",
    projectId: project.id,
    name: "exec",
    branch: "main",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "local",
    worktreePath: worktree,
    setupScriptsComplete: true,
    setupPhase: "ready",
  });
  return { harness, worktree };
}

async function exec(harness: PublicApiHarness, requestId: string, input: Record<string, unknown>) {
  return harness.call("environment.exec", { environmentId: "env-exec", ...input }, { requestId });
}

async function waitTerminal(
  harness: PublicApiHarness,
  operationId: string,
  timeoutMs = 30_000,
): Promise<PublicReceipt> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await harness.call("run.get", { operationId });
    const receipt = response.receipt!;
    if (!["admitted", "running", "unknown"].includes(receipt.state)) return receipt;
    if (Date.now() > deadline) throw new Error(`exec did not finish: ${JSON.stringify(receipt)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function output(
  harness: PublicApiHarness,
  operationId: string,
  stream: "stdout" | "stderr",
): Promise<PublicExecOutputWindow> {
  const response = await harness.call<PublicExecOutputWindow>("run.output", {
    operationId,
    stream,
  });
  if (!response.ok) throw new Error(`run.output failed: ${response.error.message}`);
  return response.result;
}

describe("environment.exec", () => {
  test.each([false, true])(
    "a container transport failure (timeout=%s) permits a late remote claim",
    async (timedOut) => {
      const { harness } = await setup();
      await harness.storage.updateEnvironment("env-exec", {
        environmentType: "containerized",
        containerId: "stub-container",
      });
      const shell = await import("../shell.js");
      const original = shell.runCommand;
      let starts = 0;
      let claimProbes = 0;
      let status: "error" | "missing" | "running" | "exited" = "error";
      const controller = spyOn(shell, "runCommand").mockImplementation(
        async (command, args, options) => {
          if (command !== "docker") return original(command, args, options);
          // A probe can see no claim while the remote controller is still starting.
          if (args?.includes("sh")) {
            claimProbes += 1;
            return { stdout: "unclaimed\n", stderr: "" };
          }
          const payload = JSON.parse(String(options?.stdin));
          if (payload.action === "start") {
            starts += 1;
            throw new shell.CommandFailedError("transport lost", { timedOut });
          }
          if (status === "error") throw new Error("status unavailable");
          return {
            stdout: JSON.stringify({ status, ...(status === "exited" ? { exitCode: 0 } : {}) }),
            stderr: "",
          };
        },
      );
      try {
        const started = await exec(harness, "late-remote", { argv: ["true"] });
        expect(started.receipt?.state).toBe("running");
        const operationId = started.receipt!.operationId;
        expect((await harness.call("run.get", { operationId })).receipt?.state).toBe("running");
        status = "missing";
        expect((await harness.call("run.get", { operationId })).receipt?.state).toBe("running");
        status = "running";
        expect((await harness.call("run.get", { operationId })).receipt?.execution?.state).toBe(
          "running",
        );
        status = "error";
        expect((await harness.call("run.get", { operationId })).receipt?.state).toBe("running");
        status = "exited";
        expect((await harness.call("run.get", { operationId })).receipt?.state).toBe("succeeded");
        expect(starts).toBe(1);
        expect(claimProbes).toBe(0);
      } finally {
        controller.mockRestore();
      }
    },
  );

  test("an unreadable local claim cannot prove that the command never started", async () => {
    const { harness } = await setup();
    const shell = await import("../shell.js");
    const controller = spyOn(shell, "runCommand").mockRejectedValue(
      new Error("launcher unavailable"),
    );
    const claim = spyOn(fs, "lstat").mockRejectedValue(
      Object.assign(new Error("denied"), { code: "EACCES" }),
    );
    try {
      const started = await exec(harness, "unknown-claim", { argv: ["true"] });
      expect(started.receipt?.state).toBe("running");
      expect(
        (await harness.call("run.get", { operationId: started.receipt!.operationId })).receipt
          ?.state,
      ).toBe("running");
    } finally {
      claim.mockRestore();
      controller.mockRestore();
    }
  });

  test("container exec passes large stdin through docker exec", async () => {
    const image = process.env.ORKESTRATOR_TEST_DOCKER_EXEC_IMAGE;
    if (!image) return;
    const { harness } = await setup();
    const local = await harness.storage.getEnvironment("env-exec");
    if (!local) throw new Error("fixture environment missing");
    const { stdout } = await runCommand("docker", [
      "run",
      "--rm",
      "-d",
      "--entrypoint",
      "sleep",
      image,
      "120",
    ]);
    const containerId = stdout.trim();
    try {
      await harness.storage.addEnvironment({
        ...local,
        id: "env-container",
        name: "container-exec",
        environmentType: "containerized",
        containerId,
        worktreePath: undefined,
      });
      const bytes = Buffer.alloc(200_000, 0x61);
      const started = await harness.call(
        "environment.exec",
        {
          environmentId: "env-container",
          argv: ["wc", "-c"],
          stdinBase64: bytes.toString("base64"),
        },
        { requestId: "container-stdin" },
      );
      expect(started.ok).toBe(true);
      const final = await waitTerminal(harness, started.receipt!.operationId);
      expect(final.state).toBe("succeeded");
      const response = await harness.call<PublicExecOutputWindow>("run.output", {
        operationId: final.operationId,
      });
      expect(response.ok && response.result.text.trim()).toBe("200000");
    } finally {
      await runCommand("docker", ["rm", "-f", containerId]).catch(() => undefined);
    }
  });
  test("an immediate exit remains authoritative after controller startup", async () => {
    const { harness } = await setup();
    const started = await exec(harness, "instant-exit", { argv: ["true"] });
    const final = await waitTerminal(harness, started.receipt!.operationId);
    expect(final.state).toBe("succeeded");
    const statePath = path.join(harness.dataDir, "exec-runs", final.operationId, "state.json");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(JSON.parse(await fs.readFile(statePath, "utf8")).status).toBe("exited");
  });
  test("reports the process's own exit status and keeps streams separate", async () => {
    const { harness } = await setup();
    const started = await exec(harness, "x1", {
      argv: ["sh", "-c", "echo out; echo err >&2; exit 3"],
    });
    expect(started.ok).toBe(true);
    const final = await waitTerminal(harness, started.receipt!.operationId);
    expect(final.state).toBe("failed");
    expect(final.error?.code).toBe("exec-failed");
    expect(final.execution).toMatchObject({
      state: "failed",
      exitCode: 3,
      evidence: "process-exit",
    });
    expect((await output(harness, final.operationId, "stdout")).text).toBe("out\n");
    expect((await output(harness, final.operationId, "stderr")).text).toBe("err\n");
  });

  test("preserves argv exactly, with no shell interpretation", async () => {
    const { harness } = await setup();
    const argv = ["printf", "%s|", "a b", "$(whoami)", ";rm -rf x", "é🙂", "*"];
    const started = await exec(harness, "x2", { argv });
    const final = await waitTerminal(harness, started.receipt!.operationId);
    expect(final.state).toBe("succeeded");
    expect((await output(harness, final.operationId, "stdout")).text).toBe(
      "a b|$(whoami)|;rm -rf x|é🙂|*|",
    );
  });

  test("runs in a workspace-relative cwd with stdin and extra environment", async () => {
    const { harness, worktree } = await setup();
    const started = await exec(harness, "x3", {
      argv: ["sh", "-c", 'pwd; printf "%s" "$GREETING"; cat'],
      cwd: "sub",
      env: { GREETING: "hi " },
      stdinBase64: Buffer.from("from stdin").toString("base64"),
    });
    const final = await waitTerminal(harness, started.receipt!.operationId);
    expect(final.state).toBe("succeeded");
    const text = (await output(harness, final.operationId, "stdout")).text;
    expect(text).toBe(`${await fs.realpath(path.join(worktree, "sub"))}\nhi from stdin`);
  });

  test("accepts stdin larger than a single Linux argv entry", async () => {
    const { harness } = await setup();
    const bytes = Buffer.alloc(200_000, 0x61);
    const started = await exec(harness, "large-stdin", {
      argv: ["wc", "-c"],
      stdinBase64: bytes.toString("base64"),
    });
    expect(started.ok).toBe(true);
    const final = await waitTerminal(harness, started.receipt!.operationId);
    expect(final.state).toBe("succeeded");
    expect((await output(harness, final.operationId, "stdout")).text.trim()).toBe("200000");
  });

  test("refuses a cwd that escapes the workspace, including through a symlink", async () => {
    const { harness, worktree } = await setup();
    const escaped = await exec(harness, "x4", { argv: ["true"], cwd: "../outside" });
    expect(!escaped.ok && escaped.error.code).toBe("invalid-input");
    await fs.symlink(harness.root, path.join(worktree, "link"));
    const viaLink = await exec(harness, "x5", { argv: ["true"], cwd: "link" });
    const final = await waitTerminal(harness, viaLink.receipt!.operationId);
    expect(final.state).toBe("failed");
    expect(final.execution?.reason).toContain("cwd-outside-workspace");
  });

  test("a timeout terminates the command and is reported as such", async () => {
    const { harness } = await setup();
    const started = await exec(harness, "x6", { argv: ["sleep", "30"], timeoutMs: 1_000 });
    const final = await waitTerminal(harness, started.receipt!.operationId);
    expect(final.state).toBe("failed");
    expect(final.execution).toMatchObject({ timedOut: true });
  });

  test("a command ignoring TERM is killed after the timeout grace period", async () => {
    const { harness } = await setup();
    const started = await exec(harness, "ignore-term", {
      argv: ["sh", "-c", "trap '' TERM; sleep 1000"],
      timeoutMs: 1_000,
    });
    const final = await waitTerminal(harness, started.receipt!.operationId, 12_000);
    expect(final.state).toBe("failed");
    expect(final.execution?.timedOut).toBe(true);
  });

  test("cancellation targets the exact worker and drains its descendants", async () => {
    const { harness } = await setup();
    const started = await exec(harness, "x7", { argv: ["sh", "-c", "sleep 30 & sleep 30 & wait"] });
    const operationId = started.receipt!.operationId;
    // Let the worker start its command.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const current = await harness.call("run.get", { operationId });
      if (current.receipt?.execution?.startedAt) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const cancelled = await harness.call("run.cancel", { operationId }, { requestId: "cancel-x7" });
    expect(cancelled.ok).toBe(true);
    const final = await waitTerminal(harness, operationId);
    expect(final.state).toBe("cancelled");
    const state = JSON.parse(
      await fs.readFile(path.join(harness.dataDir, "exec-runs", operationId, "state.json"), "utf8"),
    ) as { pgid: number };
    expect(() => process.kill(-state.pgid, 0)).toThrow();
  });

  test("cancel kills a command that ignores TERM", async () => {
    const { harness } = await setup();
    const started = await exec(harness, "cancel-ignore", {
      argv: ["sh", "-c", "trap '' TERM; sleep 1000"],
    });
    const operationId = started.receipt!.operationId;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if ((await harness.call("run.get", { operationId })).receipt?.execution?.startedAt) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const cancelled = await harness.call(
      "run.cancel",
      { operationId },
      { requestId: "cancel-ignore-request" },
    );
    expect(cancelled.ok).toBe(true);
    expect((await waitTerminal(harness, operationId, 12_000)).state).toBe("cancelled");
  });

  test("output beyond the limit stops the command and is flagged", async () => {
    const { harness } = await setup();
    const started = await exec(harness, "x8", {
      argv: ["sh", "-c", "yes 0123456789 | head -c 20000000"],
    });
    const final = await waitTerminal(harness, started.receipt!.operationId);
    expect(final.execution?.outputLimited).toBe(true);
    const tail = await harness.call<PublicExecOutputWindow>("run.output", {
      operationId: final.operationId,
      tailBytes: 11,
    });
    expect(tail.ok && tail.result.totalBytes).toBe(16 * 1024 * 1024);
  });

  test("the worker survives a backend restart and its result is reconciled, not re-run", async () => {
    const { harness, worktree } = await setup();
    const marker = path.join(worktree, "runs.log");
    const started = await exec(harness, "x9", {
      argv: ["sh", "-c", `echo run >> ${JSON.stringify(marker)}; sleep 1`],
    });
    const operationId = started.receipt!.operationId;
    const restarted = await harness.restart();
    harnesses.push(restarted);
    const final = await waitTerminal(restarted, operationId);
    expect(final.state).toBe("succeeded");
    const replay = await restarted.call(
      "environment.exec",
      {
        environmentId: "env-exec",
        argv: ["sh", "-c", `echo run >> ${JSON.stringify(marker)}; sleep 1`],
      },
      { requestId: "x9" },
    );
    expect(replay.receipt?.replayed).toBe(true);
    expect((await fs.readFile(marker, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  test("a launcher that fails before claiming the command settles it as failed", async () => {
    const toolchainBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-exec-bun-"));
    try {
      // Like the mise shim that could not resolve from `/`: the control's
      // Bun exits before it reads its input.
      await fs.writeFile(path.join(toolchainBinDir, "bun"), "#!/bin/sh\nexit 127\n", {
        mode: 0o755,
      });
      const { harness, worktree } = await setup({ context: { toolchainBinDir } });
      const marker = path.join(worktree, "ran");
      const started = await exec(harness, "launcher-down", { argv: ["touch", marker] });
      expect(started.ok).toBe(false);
      expect(!started.ok && started.error.code).toBe("exec-failed");
      const receipt = started.receipt!;
      expect(receipt.state).toBe("failed");
      expect(receipt.execution).toMatchObject({ state: "failed", evidence: "none" });
      expect(receipt.execution?.reason).toContain("never started");
      // Read again: the receipt stays settled; nothing was run or claimed.
      const read = await harness.call("run.get", { operationId: receipt.operationId });
      expect(read.receipt?.state).toBe("failed");
      expect(await fs.stat(marker).catch(() => null)).toBeNull();
      expect(
        await fs
          .stat(path.join(harness.dataDir, "exec-runs", receipt.operationId, "state.json"))
          .catch(() => null),
      ).toBeNull();
    } finally {
      await fs.rm(toolchainBinDir, { recursive: true, force: true });
    }
  });

  test("a launcher that fails after claiming the command waits for its worker", async () => {
    const toolchainBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-exec-bun-"));
    const fakeBun = path.join(toolchainBinDir, "bun");
    try {
      // The control claims and starts the worker, then its response is lost.
      await fs.writeFile(
        fakeBun,
        `#!/bin/sh\n${JSON.stringify(process.execPath)} "$@" >/dev/null\nexit 1\n`,
        { mode: 0o755 },
      );
      const { harness, worktree } = await setup({ context: { toolchainBinDir } });
      const marker = path.join(worktree, "runs.log");
      const started = await exec(harness, "launcher-lost", {
        argv: ["sh", "-c", `echo run >> ${JSON.stringify(marker)}`],
      });
      const operationId = started.receipt!.operationId;
      expect(started.receipt!.state).toBe("running");
      expect(started.receipt!.execution?.state).toBe("pending");
      // Status reads still fail, but the claim proves a worker may exist.
      const pending = await harness.call("run.get", { operationId });
      expect(pending.receipt?.state).toBe("running");
      // Once the control works again, the worker's own result settles it.
      await fs.rm(fakeBun);
      await fs.symlink(process.execPath, fakeBun);
      const final = await waitTerminal(harness, operationId);
      expect(final.state).toBe("succeeded");
      expect((await fs.readFile(marker, "utf8")).trim().split("\n")).toHaveLength(1);
    } finally {
      await fs.rm(toolchainBinDir, { recursive: true, force: true });
    }
  });

  test("stopping the environment cancels its running commands first", async () => {
    const { harness } = await setup();
    const started = await exec(harness, "x10", { argv: ["sleep", "30"] });
    const operationId = started.receipt!.operationId;
    const { stopEnvironmentExecWorkers } = await import("./exec-control.js");
    await stopEnvironmentExecWorkers("env-exec", harness.context);
    const final = await waitTerminal(harness, operationId);
    expect(final.state).toBe("cancelled");
  });

  test("environment stop drains a command that ignores TERM", async () => {
    const { harness } = await setup();
    const started = await exec(harness, "stop-ignore", {
      argv: ["sh", "-c", "trap '' TERM; sleep 1000"],
    });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (
        (await harness.call("run.get", { operationId: started.receipt!.operationId })).receipt
          ?.execution?.startedAt
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const { stopEnvironmentExecWorkers } = await import("./exec-control.js");
    await stopEnvironmentExecWorkers("env-exec", harness.context);
    expect((await waitTerminal(harness, started.receipt!.operationId, 12_000)).state).toBe(
      "cancelled",
    );
  });

  test("bounds per-environment concurrency", async () => {
    const { harness } = await setup();
    const ids: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const started = await exec(harness, `c${index}`, { argv: ["sleep", "5"] });
      ids.push(started.receipt!.operationId);
    }
    const refused = await exec(harness, "c-over", { argv: ["sleep", "5"] });
    expect(!refused.ok && refused.error.code).toBe("busy");
    for (const operationId of ids)
      await harness.call("run.cancel", { operationId }, { requestId: `cc-${operationId}` });
  });

  test("bounds concurrent admission under a race", async () => {
    const { harness } = await setup();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        exec(harness, `parallel-${index}`, { argv: ["sleep", "30"] }),
      ),
    );
    const admitted = results.filter((result) => result.ok);
    expect(admitted.length).toBeLessThanOrEqual(4);
    expect(results.filter((result) => !result.ok)).toHaveLength(8 - admitted.length);
    for (const result of admitted) {
      await harness.call(
        "run.cancel",
        { operationId: result.receipt!.operationId },
        { requestId: `cancel-${result.receipt!.operationId}` },
      );
    }
  });
});
