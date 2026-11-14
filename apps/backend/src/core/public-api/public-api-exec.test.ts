import { afterEach, describe, expect, jest, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import type { PublicExecOutputWindow } from "@orkestrator/protocol/public-api-resources";
import { runCommand } from "../shell.js";
import { ExecScope, exec, waitTerminal } from "./public-api-exec-test-support.js";

/**
 * The `environment.exec` tests that replace shared module functions
 * (`runCommand`, `fs.lstat`) or need Docker. They stay serial: a spy installed
 * here would be seen by any test running beside it. The real-process tests are
 * in `public-api-exec-processes.test.ts`.
 */

jest.setTimeout(60_000);

const scope = new ExecScope();

afterEach(async () => {
  await scope.cleanup();
});

describe("environment.exec", () => {
  test.each([false, true])(
    "a container transport failure (timeout=%s) permits a late remote claim",
    async (timedOut) => {
      const { harness } = await scope.setup();
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
    const { harness } = await scope.setup();
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
    const { harness } = await scope.setup();
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
});
