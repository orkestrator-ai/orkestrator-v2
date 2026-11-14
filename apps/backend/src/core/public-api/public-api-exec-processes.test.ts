import { afterAll, beforeAll, describe, expect, jest, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PublicExecOutputWindow } from "@orkestrator/protocol/public-api-resources";
import {
  ExecScope,
  exec,
  output,
  shortenExecWorkerTimers,
  waitStarted,
  waitTerminal,
} from "./public-api-exec-test-support.js";

/**
 * `environment.exec` against real local processes: the environment-side
 * worker, its state file and bounded artifacts, and the backend's
 * reconciliation. Every test owns a harness (data directory, storage, worker
 * processes) and nothing global, so they run concurrently; the tests that spy
 * on shared modules stay serial in `public-api-exec.test.ts`.
 */

jest.setTimeout(60_000);

let restoreWorkerTimers: (() => void) | undefined;
beforeAll(() => {
  restoreWorkerTimers = shortenExecWorkerTimers();
});
afterAll(() => {
  restoreWorkerTimers?.();
});

function execTest(name: string, run: (scope: ExecScope) => Promise<void>): void {
  test.concurrent(name, async () => {
    const scope = new ExecScope();
    try {
      await run(scope);
    } finally {
      await scope.cleanup();
    }
  });
}

describe("environment.exec", () => {
  execTest("an immediate exit remains authoritative after controller startup", async (scope) => {
    const { harness } = await scope.setup();
    const started = await exec(harness, "instant-exit", { argv: ["true"] });
    const final = await waitTerminal(harness, started.receipt!.operationId);
    expect(final.state).toBe("succeeded");
    const statePath = path.join(harness.dataDir, "exec-runs", final.operationId, "state.json");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(JSON.parse(await fs.readFile(statePath, "utf8")).status).toBe("exited");
  });
  execTest("reports the process's own exit status and keeps streams separate", async (scope) => {
    const { harness } = await scope.setup();
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

  execTest("preserves argv exactly, with no shell interpretation", async (scope) => {
    const { harness } = await scope.setup();
    const argv = ["printf", "%s|", "a b", "$(whoami)", ";rm -rf x", "é🙂", "*"];
    const started = await exec(harness, "x2", { argv });
    const final = await waitTerminal(harness, started.receipt!.operationId);
    expect(final.state).toBe("succeeded");
    expect((await output(harness, final.operationId, "stdout")).text).toBe(
      "a b|$(whoami)|;rm -rf x|é🙂|*|",
    );
  });

  execTest("runs in a workspace-relative cwd with stdin and extra environment", async (scope) => {
    const { harness, worktree } = await scope.setup();
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

  execTest("accepts stdin larger than a single Linux argv entry", async (scope) => {
    const { harness } = await scope.setup();
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

  execTest(
    "refuses a cwd that escapes the workspace, including through a symlink",
    async (scope) => {
      const { harness, worktree } = await scope.setup();
      const escaped = await exec(harness, "x4", { argv: ["true"], cwd: "../outside" });
      expect(!escaped.ok && escaped.error.code).toBe("invalid-input");
      await fs.symlink(harness.root, path.join(worktree, "link"));
      const viaLink = await exec(harness, "x5", { argv: ["true"], cwd: "link" });
      const final = await waitTerminal(harness, viaLink.receipt!.operationId);
      expect(final.state).toBe("failed");
      expect(final.execution?.reason).toContain("cwd-outside-workspace");
    },
  );

  execTest("a timeout terminates the command and is reported as such", async (scope) => {
    const { harness } = await scope.setup();
    const started = await exec(harness, "x6", { argv: ["sleep", "30"], timeoutMs: 1_000 });
    const final = await waitTerminal(harness, started.receipt!.operationId);
    expect(final.state).toBe("failed");
    expect(final.execution).toMatchObject({ timedOut: true });
  });

  execTest("a command ignoring TERM is killed after the timeout grace period", async (scope) => {
    const { harness } = await scope.setup();
    const started = await exec(harness, "ignore-term", {
      argv: ["sh", "-c", "trap '' TERM; sleep 1000"],
      timeoutMs: 1_000,
    });
    const final = await waitTerminal(harness, started.receipt!.operationId, 12_000);
    expect(final.state).toBe("failed");
    expect(final.execution?.timedOut).toBe(true);
  });

  execTest("cancellation targets the exact worker and drains its descendants", async (scope) => {
    const { harness } = await scope.setup();
    const started = await exec(harness, "x7", { argv: ["sh", "-c", "sleep 30 & sleep 30 & wait"] });
    const operationId = started.receipt!.operationId;
    // Let the worker start its command.
    await waitStarted(harness, operationId);
    const cancelled = await harness.call("run.cancel", { operationId }, { requestId: "cancel-x7" });
    expect(cancelled.ok).toBe(true);
    const final = await waitTerminal(harness, operationId);
    expect(final.state).toBe("cancelled");
    const state = JSON.parse(
      await fs.readFile(path.join(harness.dataDir, "exec-runs", operationId, "state.json"), "utf8"),
    ) as { pgid: number };
    expect(() => process.kill(-state.pgid, 0)).toThrow();
  });

  execTest("cancel kills a command that ignores TERM", async (scope) => {
    const { harness } = await scope.setup();
    const started = await exec(harness, "cancel-ignore", {
      argv: ["sh", "-c", "trap '' TERM; sleep 1000"],
    });
    const operationId = started.receipt!.operationId;
    await waitStarted(harness, operationId);
    const cancelled = await harness.call(
      "run.cancel",
      { operationId },
      { requestId: "cancel-ignore-request" },
    );
    expect(cancelled.ok).toBe(true);
    expect((await waitTerminal(harness, operationId, 12_000)).state).toBe("cancelled");
  });

  execTest("output beyond the limit stops the command and is flagged", async (scope) => {
    const { harness } = await scope.setup();
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

  execTest(
    "the worker survives a backend restart and its result is reconciled, not re-run",
    async (scope) => {
      const { harness, worktree } = await scope.setup();
      const marker = path.join(worktree, "runs.log");
      const started = await exec(harness, "x9", {
        argv: ["sh", "-c", `echo run >> ${JSON.stringify(marker)}; sleep 1`],
      });
      const operationId = started.receipt!.operationId;
      const restarted = await harness.restart();
      scope.adopt(restarted);
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
    },
  );

  execTest(
    "a launcher that fails before claiming the command settles it as failed",
    async (scope) => {
      const toolchainBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-exec-bun-"));
      try {
        // Like the mise shim that could not resolve from `/`: the control's
        // Bun exits before it reads its input.
        await fs.writeFile(path.join(toolchainBinDir, "bun"), "#!/bin/sh\nexit 127\n", {
          mode: 0o755,
        });
        const { harness, worktree } = await scope.setup({ context: { toolchainBinDir } });
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
    },
  );

  execTest(
    "a launcher that fails after claiming the command waits for its worker",
    async (scope) => {
      const toolchainBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-exec-bun-"));
      const fakeBun = path.join(toolchainBinDir, "bun");
      try {
        // The control claims and starts the worker, then its response is lost.
        await fs.writeFile(
          fakeBun,
          `#!/bin/sh\n${JSON.stringify(process.execPath)} "$@" >/dev/null\nexit 1\n`,
          { mode: 0o755 },
        );
        const { harness, worktree } = await scope.setup({ context: { toolchainBinDir } });
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
    },
  );

  execTest("stopping the environment cancels its running commands first", async (scope) => {
    const { harness } = await scope.setup();
    const started = await exec(harness, "x10", { argv: ["sleep", "30"] });
    const operationId = started.receipt!.operationId;
    const { stopEnvironmentExecWorkers } = await import("./exec-control.js");
    await stopEnvironmentExecWorkers("env-exec", harness.context);
    const final = await waitTerminal(harness, operationId);
    expect(final.state).toBe("cancelled");
  });

  execTest("environment stop drains a command that ignores TERM", async (scope) => {
    const { harness } = await scope.setup();
    const started = await exec(harness, "stop-ignore", {
      argv: ["sh", "-c", "trap '' TERM; sleep 1000"],
    });
    await waitStarted(harness, started.receipt!.operationId);
    const { stopEnvironmentExecWorkers } = await import("./exec-control.js");
    await stopEnvironmentExecWorkers("env-exec", harness.context);
    expect((await waitTerminal(harness, started.receipt!.operationId, 12_000)).state).toBe(
      "cancelled",
    );
  });

  execTest("bounds per-environment concurrency", async (scope) => {
    const { harness } = await scope.setup();
    const ids: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const started = await exec(harness, `c${index}`, { argv: ["sleep", "5"] });
      ids.push(started.receipt!.operationId);
    }
    const refused = await exec(harness, "c-over", { argv: ["sleep", "5"] });
    expect(!refused.ok && refused.error.code).toBe("busy");
    // Each cancel waits for the worker's cancel poll; cancel them together.
    await Promise.all(
      ids.map((operationId) =>
        harness.call("run.cancel", { operationId }, { requestId: `cc-${operationId}` }),
      ),
    );
  });

  execTest("bounds concurrent admission under a race", async (scope) => {
    const { harness } = await scope.setup();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        exec(harness, `parallel-${index}`, { argv: ["sleep", "30"] }),
      ),
    );
    const admitted = results.filter((result) => result.ok);
    expect(admitted.length).toBeLessThanOrEqual(4);
    expect(results.filter((result) => !result.ok)).toHaveLength(8 - admitted.length);
    await Promise.all(
      admitted.map((result) =>
        harness.call(
          "run.cancel",
          { operationId: result.receipt!.operationId },
          { requestId: `cancel-${result.receipt!.operationId}` },
        ),
      ),
    );
  });
});
