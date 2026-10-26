import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentToolsServer } from "../src/core/agent-tools.js";
import { StorageService } from "../src/core/storage.js";
import { containerWorktreeSignalInstaller } from "../src/core/container-worktree-signal-install.js";
import { DiffStatsTracking } from "../src/core/diff-stats-tracking.js";
import type { DiffScanEvent } from "../src/core/diff-stats-service.js";
import { runCommand } from "../src/core/shell.js";
import { dockerOwnerNamespace } from "../src/core/docker-ownership.js";
import { lifecycleEnvironment } from "./container-lifecycle-fixtures.js";

// Build this checkout with `mise run docker:build:dev`; never use `latest`.
// The Linux Engine workflow passes its per-run qualification image.
const image = process.env.ORKESTRATOR_TEST_STATE_SIGNAL_IMAGE;
const dockerTest = image ? test : test.skip;

dockerTest(
  "a real container's worktree watcher arms, rings on change, and falls back when it dies",
  async () => {
    if (!image || !/^orkestrator-v2:(dev|qualification)-/.test(image))
      throw new Error("Use this checkout's development or qualification image");
    const dir = await mkdtemp(join(tmpdir(), "ork-worktree-signal-docker-"));
    const storage = new StorageService(dir);
    await storage.init();
    const server = new AgentToolsServer(storage, "0.0.0.0");
    const scans: Array<Extract<DiffScanEvent, { kind: "scanned" }>> = [];
    const tracking = new DiffStatsTracking({
      emit: () => undefined,
      onScanEvent: (event) => {
        if (event.kind === "scanned") scans.push(event);
      },
      worktreeSignal: containerWorktreeSignalInstaller,
    });
    let containerId: string | undefined;
    const docker = async (args: string[]) =>
      (await runCommand("docker", args, { timeoutMs: 30_000 })).stdout.trim();
    const until = async (predicate: () => boolean, what: string, timeoutMs = 15_000) => {
      const deadline = Date.now() + timeoutMs;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
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
      await docker([
        "exec",
        "--user",
        "root",
        containerId,
        "sh",
        "-c",
        "mkdir -p /workspace && chown node:node /workspace",
      ]);
      await docker([
        "exec",
        containerId,
        "sh",
        "-c",
        [
          "cd /workspace",
          "git init -q -b main",
          "printf 'base\\n' > bun.lock",
          "git add bun.lock",
          "git -c user.email=a@b -c user.name=a commit -q -m base",
          "mkdir -p src node_modules/pkg",
        ].join(" && "),
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
      await storage.addEnvironment(environment);
      const states = () => tracking.worktreeSignals.status().states;

      const armStarted = Date.now();
      await tracking.sync({ storage, agentTools: server });
      await until(() => states().confirmed === 1, "the watcher's ready ring");
      const armMs = Date.now() - armStarted;
      await until(() => scans.length >= 2, "the confirmation rescan");
      const lookup = { containerId };
      const read = () =>
        tracking.service.readFileList({ lookup, comparisonRef: "main", includeUncommitted: true });
      expect((await read()).changes).toEqual([]);

      // Quiet: reads are served from the last scan.
      const quietScans = scans.length;
      for (let index = 0; index < 5; index += 1) {
        await Bun.sleep(1_000);
        await read();
      }
      expect(scans.length).toBe(quietScans);

      // Only a tracked dependency lockfile changes. It must invalidate both
      // the cached list and counts promptly, before the safety scan.
      const beforeLock = scans.length;
      await docker([
        "exec",
        containerId,
        "sh",
        "-c",
        "printf 'dependency\\n' >> /workspace/bun.lock",
      ]);
      await until(() => scans.length > beforeLock, "the lockfile change ring", 5_000);
      expect(((await read()).changes as Array<{ path: string }>).map(({ path }) => path)).toEqual([
        "bun.lock",
      ]);
      expect(scans.at(-1)!.result.stats.filesChanged).toBe(1);
      await Bun.sleep(3_500);
      expect(states().confirmed).toBe(1);
      expect(tracking.worktreeSignals.status().demotions).toEqual({});

      // A writer keeps its fd open after modifying an existing tracked file.
      // MODIFY must ring without waiting for CLOSE_WRITE.
      const beforeOpen = scans.length;
      await docker([
        "exec",
        "--detach",
        containerId,
        "sh",
        "-c",
        "exec 3>>/workspace/bun.lock; printf 'held-open\\n' >&3; touch /tmp/worktree-writer-open; while [ ! -f /tmp/worktree-writer-close ]; do sleep 0.1; done; exec 3>&-; rm /tmp/worktree-writer-open",
      ]);
      await until(() => scans.length > beforeOpen, "a modify ring with the fd still open", 5_000);
      await docker(["exec", containerId, "test", "-f", "/tmp/worktree-writer-open"]);
      expect(scans.at(-1)!.result.stats.additions).toBe(2);
      await docker(["exec", containerId, "touch", "/tmp/worktree-writer-close"]);
      await Bun.sleep(2_500);
      const beforeNew = scans.length;

      // A change rings: one scan, and the read sees it.
      const changedAt = Date.now();
      await docker(["exec", containerId, "sh", "-c", "echo hi > /workspace/src/new.ts"]);
      await until(() => scans.length > beforeNew, "a ring-driven scan");
      const ringToScanMs = Date.now() - changedAt;
      const paths = ((await read()).changes as Array<{ path: string }>).map(
        (change) => change.path,
      );
      expect(paths).toEqual(["bun.lock", "src/new.ts"]);

      // node_modules is outside the watches: no ring, no scan.
      const beforeExcluded = scans.length;
      await docker(["exec", containerId, "sh", "-c", "echo x > /workspace/node_modules/pkg/a.js"]);
      await Bun.sleep(2_500);
      expect(scans.length).toBe(beforeExcluded);

      // A new lineage (the container stopped and started, here a pause and a
      // resync) replaces the watcher rather than adding a second one.
      tracking.service.pause(environment.id);
      expect(states().confirmed).toBe(0);
      await tracking.sync({ storage, agentTools: server });
      await until(() => states().confirmed === 1, "the new lineage's ready ring");
      expect(await docker(["exec", containerId, "pgrep", "-c", "-x", "inotifywait"])).toBe("1");

      await Bun.sleep(3_500);
      expect(tracking.worktreeSignals.status().demotions).toEqual({});

      // The watcher dies on its own: a lost ring drops back to the timers.
      await docker(["exec", containerId, "pkill", "-x", "inotifywait"]);
      await until(() => states().demoted === 1, "the lost ring");
      expect(tracking.worktreeSignals.status().demotions).toEqual({ "watcher-lost": 1 });
      process.stderr.write(
        `[worktree-signal-docker] arm-to-confirmed ${armMs} ms, change-to-scan ${ringToScanMs} ms\n`,
      );
    } finally {
      tracking.shutdown();
      if (containerId) await docker(["rm", "--force", containerId]);
      await server.stop();
      await rm(dir, { recursive: true, force: true });
    }
  },
  120_000,
);
