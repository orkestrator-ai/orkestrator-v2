/** Real docker-exec settle, opt-in on a disposable daemon; no credentials or network. */
import { expect, test } from "bun:test";
import { dockerClaudeStateSettler } from "../src/core/claude-terminal-settle";
import { runCommand } from "../src/core/shell";

const image = process.env.ORKESTRATOR_QUALIFICATION_IMAGE;
const enabled = process.env.RUN_LIVE_DOCKER_TESTS === "1" && Boolean(image);

test.skipIf(!enabled)(
  "docker settle shares the hook lock and preserves newer snapshots",
  async () => {
    const docker = async (...args: string[]) =>
      (await runCommand("docker", args, { timeoutMs: 120_000 })).stdout.trim();
    const container = await docker(
      "run",
      "-d",
      "--network",
      "none",
      "--entrypoint",
      "sleep",
      image!,
      "300",
    );
    try {
      const hook = (state: string) =>
        docker("exec", container, "/usr/local/bin/orkestrator-state-signal", state);
      const snapshot = () => docker("exec", container, "cat", "/tmp/.claude-state-snapshot");
      await hook("working");
      expect(await snapshot()).toBe("working 1 0");
      expect(
        await dockerClaudeStateSettler(container, { revision: 1, completions: 0 }, "failed"),
      ).toBe(true);
      expect(await snapshot()).toBe("failed 2 0");
      await hook("working");
      expect(
        await dockerClaudeStateSettler(container, { revision: 1, completions: 0 }, "idle"),
      ).toBe(false);
      expect(await snapshot()).toBe("working 3 0");
      // Hold the hook's lock: the real docker command must refuse the write.
      await docker(
        "exec",
        "-d",
        container,
        "sh",
        "-c",
        "exec 9>/tmp/.claude-state-snapshot.lock; flock 9; touch /tmp/settle-test-locked; while [ ! -f /tmp/settle-test-release ]; do sleep 0.1; done",
      );
      for (let attempt = 0; attempt < 100; attempt++) {
        const ready = await docker(
          "exec",
          container,
          "sh",
          "-c",
          "test -f /tmp/settle-test-locked && echo ready || true",
        );
        if (ready === "ready") break;
      }
      expect(await docker("exec", container, "test", "-f", "/tmp/settle-test-locked")).toBe("");
      expect(
        await dockerClaudeStateSettler(container, { revision: 3, completions: 0 }, "idle"),
      ).toBe(false);
      expect(await snapshot()).toBe("working 3 0");
      await docker("exec", container, "touch", "/tmp/settle-test-release");
      await docker(
        "exec",
        container,
        "flock",
        "-w",
        "5",
        "/tmp/.claude-state-snapshot.lock",
        "true",
      );
      expect(
        await dockerClaudeStateSettler(container, { revision: 3, completions: 0 }, "idle"),
      ).toBe(true);
      expect(await snapshot()).toBe("idle 4 0");
    } finally {
      await docker("rm", "-f", container);
    }
  },
  120_000,
);
