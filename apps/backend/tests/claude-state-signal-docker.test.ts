import { expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentToolsServer } from "../src/core/agent-tools.js";
import { StorageService } from "../src/core/storage.js";
import { claudeStateSignalInstaller } from "../src/core/claude-state-signal.js";
import {
  ClaudeStatePollManager,
  CLAUDE_STATE_SAFETY_READ_INTERVAL_MS,
} from "../src/core/tmux-poll.js";
import { ManualTime } from "../src/core/recurring-test-support.js";
import { runCommand } from "../src/core/shell.js";
import { dockerOwnerNamespace } from "../src/core/docker-ownership.js";
import { lifecycleEnvironment, memoryLifecycleContext } from "./container-lifecycle-fixtures.js";

// Build this checkout with `mise run docker:build:dev`; never use `latest`.
// The Linux Engine workflow passes its per-run qualification image.
const image = process.env.ORKESTRATOR_TEST_STATE_SIGNAL_IMAGE;
const dockerTest = image ? test : test.skip;

dockerTest(
  "real container hooks reach the production signal route and recover dropped rings",
  async () => {
    if (!image || !/^orkestrator-v2:(dev|qualification)-/.test(image))
      throw new Error("Use this checkout's development or qualification image");
    const dir = await mkdtemp(join(tmpdir(), "ork-state-signal-docker-"));
    const storage = new StorageService(dir);
    await storage.init();
    const server = new AgentToolsServer(storage, "0.0.0.0");
    let containerId: string | undefined;
    let manager: ClaudeStatePollManager | undefined;
    const docker = async (args: string[]) =>
      (await runCommand("docker", args, { timeoutMs: 30_000 })).stdout.trim();
    const until = async (predicate: () => boolean) => {
      const deadline = Date.now() + 10_000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error("State signal condition timed out");
        await Bun.sleep(20);
      }
    };
    try {
      await server.start();
      containerId = await docker([
        "run",
        "--detach",
        "--label",
        "app=orkestrator-v2",
        "--label",
        `orkestrator-owner=${dockerOwnerNamespace(dir)}`,
        "--user",
        "node",
        "--entrypoint",
        "sleep",
        image,
        "infinity",
      ]);
      const imageId = await docker(["inspect", "--format", "{{.Image}}", containerId]);
      const environment = lifecycleEnvironment({
        containerId,
        status: "running",
        containerLifecycle: {
          schemaVersion: 1,
          revision: 1,
          lastRuntimeGeneration: 1,
          runtime: { containerId, runtimeGeneration: 1, owner: dockerOwnerNamespace(dir), imageId },
          storage: { format: "legacy-layer", workspaceGeneration: 1 },
          outcomes: [],
        },
      });
      const { context } = memoryLifecycleContext([environment], dir);
      await storage.addEnvironment(environment);
      context.storage = storage;
      context.agentTools = server;
      const states: string[] = [];
      const probes: string[] = [];
      const completed: string[] = [];
      context.emit = (_event, payload) => {
        states.push((payload as { state: string }).state);
      };
      context.probeAgentCreatedPullRequest = async (id) => {
        probes.push(id);
      };
      context.notifyAgentTurnCompleted = async (id) => {
        completed.push(id);
      };
      const time = new ManualTime(Date.now());
      let interval = 0;
      manager = new ClaudeStatePollManager({
        signal: claudeStateSignalInstaller,
        nowMs: time.now,
        schedule: (callback, ms) => {
          interval = ms;
          return time.setInterval(callback, ms);
        },
        cancel: time.clear.bind(time),
      });

      // Execute the actual commands installed into Claude settings by the entrypoint.
      const entrypoint = await readFile(
        join(import.meta.dir, "../../../docker/entrypoint.sh"),
        "utf8",
      );
      const body = entrypoint.match(
        /cat > "\$HOME\/\.claude\/settings\.json" << 'EOF'\n([\s\S]*?)\nEOF\n/,
      )![1]!;
      const { hooks } = JSON.parse(body) as {
        hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      };
      const hook = async (event: string, drop = false) => {
        const command = hooks[event]![0]!.hooks[0]!.command;
        await docker([
          "exec",
          ...(drop ? ["-e", "ORKESTRATOR_STATE_SIGNAL_CONFIG=/tmp/absent-config"] : []),
          containerId!,
          "sh",
          "-c",
          command,
        ]);
      };
      await hook("Stop", true);
      expect(await claudeStateSignalInstaller.support(containerId, context)).toBe("supported");
      manager.start(containerId, context);
      await until(
        () => interval === CLAUDE_STATE_SAFETY_READ_INTERVAL_MS && states.at(-1) === "waiting",
      );
      await hook("UserPromptSubmit");
      await until(() => states.at(-1) === "working");
      await hook("Stop");
      await until(() => states.at(-1) === "waiting" && probes.length === 1);

      // With no renderer subscribed, lose both POSTs and reconcile the same final state.
      await storage.updateEnvironment(environment.id, {
        hasUnreadWork: false,
        prUrl: "https://github.com/example/project/pull/1",
        prState: "open",
        hasMergeConflicts: true,
      });
      const armed = await storage.armPrRecheckAfterAgentCompletion(environment.id);
      expect(armed.armedAt).toBeTruthy();
      await hook("UserPromptSubmit", true);
      await hook("Stop", true);
      await time.advance(CLAUDE_STATE_SAFETY_READ_INTERVAL_MS);
      await until(() => probes.length === 2 && completed.length === 1);
      await time.advance(CLAUDE_STATE_SAFETY_READ_INTERVAL_MS);
      await until(() => interval === 1_000);
      expect(probes).toHaveLength(2);
      expect(completed).toHaveLength(1);
      const recovered = await storage.getEnvironment(environment.id);
      expect(recovered?.hasUnreadWork).toBe(true);
      expect(recovered?.agentSessionCompletedAt).toBeTruthy();
    } finally {
      if (containerId) {
        manager?.shutdown(containerId);
        await docker(["rm", "--force", containerId]);
      }
      await server.stop();
      await rm(dir, { recursive: true, force: true });
    }
  },
  60_000,
);
