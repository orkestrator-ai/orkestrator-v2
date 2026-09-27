/**
 * Real-Docker qualification for the container lifecycle.
 *
 * Opt-in: RUN_LIVE_DOCKER_TESTS=1 and ORKESTRATOR_QUALIFICATION_IMAGE=<image>
 * (a manifest-bearing image; never retag `orkestrator-v2:latest` for this).
 *
 * Every resource carries `orkestrator-qualification=<run>` plus an owner label
 * derived from a private temporary data directory, so no real Orkestrator
 * backend on the same daemon treats it as its own. `afterAll` removes exactly
 * the resources labelled with this run and nothing else — never a prune.
 *
 * Scenario ids refer to the matrix in
 * docs/improvements/containers/plan/14-integrated-qualification-and-rollout.md.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "../../../apps/backend/src/core/shell";
import { dockerOwnerNamespace } from "../../../apps/backend/src/core/docker-ownership";
import {
  drainContainerProcesses,
  observeContainerBoot,
  waitForContainerBoot,
} from "../../../apps/backend/src/core/container-readiness";

const IMAGE = process.env.ORKESTRATOR_QUALIFICATION_IMAGE?.trim() ?? "";
const ENABLED = process.env.RUN_LIVE_DOCKER_TESTS === "1" && IMAGE.length > 0;
const live = ENABLED ? test : test.skip;
const RUN = `q${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const RUN_LABEL = `orkestrator-qualification=${RUN}`;
const LIVE_TIMEOUT_MS = 240_000;

let dataDir = "";
let owner = "";

async function docker(args: string[], timeoutMs = 120_000): Promise<string> {
  return (await runCommand("docker", args, { timeoutMs })).stdout.trim();
}

/** A labelled container running the image's real entrypoint in full-network mode. */
async function startQualificationContainer(
  name: string,
  options: { init?: boolean } = {},
): Promise<string> {
  const id = await docker([
    "run",
    "-d",
    "--name",
    `ork-${RUN}-${name}`,
    "--label",
    RUN_LABEL,
    "--label",
    "app=orkestrator-v2",
    "--label",
    `orkestrator-owner=${owner}`,
    ...(options.init ? ["--init"] : []),
    "--cap-add",
    "NET_ADMIN",
    "-e",
    "NETWORK_MODE=full",
    "-e",
    "GIT_URL=https://example.invalid/none.git",
    IMAGE,
  ]);
  return id;
}

beforeAll(async () => {
  if (!ENABLED) return;
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-qualification-"));
  owner = dockerOwnerNamespace(dataDir);
});

afterAll(async () => {
  if (!ENABLED) return;
  // Containers carry the run label or (when created by backend code under
  // test) this run's private owner label; nothing else is touched.
  const ids = new Set<string>();
  for (const filter of [`label=${RUN_LABEL}`, `label=orkestrator-owner=${owner}`]) {
    for (const id of (await docker(["ps", "-aq", "--filter", filter]).catch(() => "")).split(
      "\n",
    )) {
      if (id) ids.add(id);
    }
  }
  if (ids.size > 0) await docker(["rm", "-f", ...ids]).catch(() => undefined);
  // Volumes are labelled with this run's private owner namespace.
  const volumes = (
    await docker(["volume", "ls", "-q", "--filter", `label=orkestrator-owner=${owner}`]).catch(
      () => "",
    )
  )
    .split("\n")
    .filter(Boolean);
  if (volumes.length > 0) await docker(["volume", "rm", ...volumes]).catch(() => undefined);
  // Networks carry the run label or, when backend code created them, this
  // run's private owner label.
  const networks = new Set<string>();
  for (const filter of [`label=${RUN_LABEL}`, `label=orkestrator-owner=${owner}`]) {
    for (const id of (
      await docker(["network", "ls", "-q", "--filter", filter]).catch(() => "")
    ).split("\n")) {
      if (id) networks.add(id);
    }
  }
  if (networks.size > 0) await docker(["network", "rm", ...networks]).catch(() => undefined);
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
});

describe("C09 readiness belongs to the current boot", () => {
  live(
    "a restarted container never reports a previous boot's readiness",
    async () => {
      const id = await startQualificationContainer("c09");
      const firstBoot = await waitForContainerBoot(id);
      expect(firstBoot).toMatch(/^[0-9a-f-]{36}$/);
      expect(
        await docker(["exec", id, "sh", "-c", "test -f /tmp/.entrypoint-complete && echo yes"]),
      ).toBe("yes");

      // The first boot's "ready" record and legacy markers stay in the
      // container filesystem across a restart; only the current boot counts.
      await docker(["stop", "-t", "5", id]);
      await docker(["start", id]);
      let sawStale = false;
      const deadline = Date.now() + 120_000;
      let secondBoot: string | null = null;
      while (Date.now() < deadline) {
        const observation = await observeContainerBoot(id);
        if (observation.kind === "current" && observation.bootId === firstBoot) sawStale = true;
        if (observation.kind === "current" && observation.phase === "ready") {
          secondBoot = observation.bootId;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(sawStale).toBe(false);
      expect(secondBoot).not.toBeNull();
      expect(secondBoot).not.toBe(firstBoot);
    },
    LIVE_TIMEOUT_MS,
  );

  live(
    "a forged ready record from another PID 1 does not release readiness",
    async () => {
      const id = await startQualificationContainer("c09-forged");
      await waitForContainerBoot(id);
      await docker([
        "exec",
        id,
        "sh",
        "-c",
        `printf '%s\\n' '{"version":1,"bootId":"00000000-0000-0000-0000-000000000000","pid1Start":"1","phase":"ready","failureCode":null,"updatedAt":"x"}' > /run/orkestrator/boot-status.json`,
      ]);
      expect(await observeContainerBoot(id)).toEqual({ kind: "pending" });
    },
    LIVE_TIMEOUT_MS,
  );
});

describe("C11 explicit stop drains workload under init", () => {
  live(
    "signals exec descendants, reaps orphans and records what survived",
    async () => {
      const id = await startQualificationContainer("c11", { init: true });
      await waitForContainerBoot(id);
      // The network policy stays readable under init.
      expect(await docker(["exec", id, "cat", "/etc/orkestrator/network-mode"])).toBe("full");
      // An orphaned grandchild (reparented to init), a process tree, and a
      // shell that ignores SIGTERM.
      await docker(["exec", "-d", id, "sh", "-c", "sleep 600 & exit 0"]);
      await docker(["exec", "-d", id, "sh", "-c", "sleep 600 & sleep 600 & wait"]);
      await docker(["exec", "-d", id, "sh", "-c", "trap '' TERM; while :; do sleep 1; done"]);
      await new Promise((resolve) => setTimeout(resolve, 500));

      const drain = await drainContainerProcesses(id, 3);
      expect(drain).not.toBeNull();
      expect(drain!.signalled).toBeGreaterThanOrEqual(4);
      expect(drain!.remaining).toBeGreaterThanOrEqual(1);
      const zombies = await docker(["exec", id, "sh", "-c", "ps -eo stat= | grep -c '^Z' || true"]);
      expect(Number(zombies)).toBe(0);
      await docker(["stop", "-t", "3", id]);
      expect(await docker(["inspect", "-f", "{{.State.Running}}", id])).toBe("false");
    },
    LIVE_TIMEOUT_MS,
  );
});

describe("C12 persistent workspace survives stop/start and runtime replacement", () => {
  live(
    "retains tracked, untracked, ignored, binary, modes, symlinks, branches and unpushed commits",
    async () => {
      const { memoryLifecycleContext, lifecycleEnvironment } =
        await import("./container-lifecycle-fixtures");
      const { ensureStorageVolumes, initializeStorageSet, planStorageSet, storageMountArguments } =
        await import("../../../apps/backend/src/core/container-storage");
      const { resolveDockerImage } = await import("../../../apps/backend/src/core/docker-image");
      const { context } = memoryLifecycleContext(
        [lifecycleEnvironment({ id: `env-${RUN}` })],
        dataDir,
      );
      const resolved = await resolveDockerImage(IMAGE);
      if (resolved.kind !== "present") throw new Error("qualification image missing");
      const storage = planStorageSet(`env-${RUN}`, owner, 1);
      await ensureStorageVolumes(context, `env-${RUN}`, storage);
      expect(await initializeStorageSet(context, resolved.imageId, `env-${RUN}`, storage)).toEqual({
        ok: true,
      });

      const run = async (name: string) =>
        docker([
          "run",
          "-d",
          "--name",
          `ork-${RUN}-${name}`,
          "--label",
          RUN_LABEL,
          "--label",
          "app=orkestrator-v2",
          "--label",
          `orkestrator-owner=${owner}`,
          "--cap-add",
          "NET_ADMIN",
          "-e",
          "NETWORK_MODE=full",
          ...storageMountArguments(storage),
          resolved.imageId,
        ]);
      const first = await run("c12-a");
      await waitForContainerBoot(first);
      const fixture = [
        "set -e",
        "cd /workspace",
        "git init -q -b main . && git config user.email q@example.invalid && git config user.name q",
        "printf 'tracked\\n' > tracked.txt && printf 'ignored.log\\n' > .gitignore",
        "git add . && git commit -qm base",
        "git checkout -qb feature && printf 'unpushed\\n' > feature.txt && git add feature.txt && git commit -qm unpushed",
        "printf 'edited\\n' >> tracked.txt",
        "printf 'untracked\\n' > untracked.txt && printf 'noise\\n' > ignored.log",
        "head -c 4096 /dev/urandom > binary.bin && sha256sum binary.bin > /tmp/binary.sum",
        "printf '#!/bin/sh\\n' > run.sh && chmod 750 run.sh",
        "ln -s tracked.txt internal-link && ln -s /etc/hostname external-link",
        "cat /tmp/binary.sum",
      ].join("\n");
      const binarySum = (await docker(["exec", first, "bash", "-c", fixture])).split(" ")[0];
      const snapshot = [
        "cd /workspace",
        "git rev-parse HEAD feature main",
        "git branch --show-current",
        "git status --porcelain --ignored | sort",
        "stat -c '%a' run.sh",
        "readlink internal-link external-link",
        "sha256sum binary.bin | cut -d' ' -f1",
      ].join(" && ");
      const before = await docker(["exec", first, "bash", "-c", snapshot]);
      expect(before).toContain(binarySum!);

      // Stop/start the same runtime.
      await docker(["stop", "-t", "5", first]);
      await docker(["start", first]);
      await waitForContainerBoot(first);
      expect(await docker(["exec", first, "bash", "-c", snapshot])).toBe(before);

      // Replace the runtime entirely: the storage set is the workspace.
      await docker(["rm", "-f", first]);
      const second = await run("c12-b");
      await waitForContainerBoot(second);
      expect(await docker(["exec", second, "bash", "-c", snapshot])).toBe(before);
      expect(
        await docker(["exec", second, "sh", "-c", "mountpoint -q /workspace && echo mounted"]),
      ).toBe("mounted");
      await docker(["rm", "-f", second]);
      await docker(["volume", "rm", ...(storage.volumes ?? []).map((volume) => volume.name)]);
    },
    LIVE_TIMEOUT_MS,
  );
});

describe("C12 backend-created runtime on persistent storage", () => {
  live(
    "mounts the workspace and every provider state path from the storage set",
    async () => {
      const { memoryLifecycleContext, lifecycleEnvironment } =
        await import("./container-lifecycle-fixtures");
      const { ensureStorageVolumes, initializeStorageSet, planStorageSet } =
        await import("../../../apps/backend/src/core/container-storage");
      const { PROVIDER_STATE_LAYOUT } =
        await import("../../../apps/backend/src/core/container-state-layout");
      const { createDockerContainer } =
        await import("../../../apps/backend/src/core/commands-containers");
      const { resolveDockerImage } = await import("../../../apps/backend/src/core/docker-image");
      const environment = lifecycleEnvironment({
        id: `env-${RUN}-created`,
        networkAccessMode: "full",
      });
      const { context } = memoryLifecycleContext([environment], dataDir);
      // No host credential directory is mounted into a qualification runtime.
      Object.assign(context, { runtimeFlavor: "agent-test", credentialSources: new Set() });
      Object.assign(context.storage, {
        getProject: async () => ({
          id: "project-1",
          name: "Project",
          gitUrl: "https://example.invalid/none.git",
          localPath: null,
          addedAt: new Date(0).toISOString(),
          order: 0,
        }),
        loadConfig: async () => ({
          version: "1.0.0",
          global: { allowedDomains: [] },
          repositories: {},
        }),
      });
      const resolved = await resolveDockerImage(IMAGE);
      if (resolved.kind !== "present") throw new Error("qualification image missing");
      const storage = planStorageSet(environment.id, owner, 1);
      await ensureStorageVolumes(context, environment.id, storage);
      expect(
        await initializeStorageSet(context, resolved.imageId, environment.id, storage),
      ).toEqual({
        ok: true,
      });
      const containerId = await createDockerContainer(environment, context, {
        imageId: resolved.imageId,
        runtimeGeneration: 1,
        storage,
      });
      await docker(["start", containerId]);
      await waitForContainerBoot(containerId);
      const check = PROVIDER_STATE_LAYOUT.map(
        (entry) =>
          `mountpoint -q ${entry.containerPath} && [ "$(stat -c %U ${entry.containerPath})" = node ] && touch ${entry.containerPath}/.probe || echo FAIL:${entry.containerPath}`,
      ).join("; ");
      const result = await docker([
        "exec",
        containerId,
        "bash",
        "-c",
        `mountpoint -q /workspace || echo FAIL:/workspace; ${check}`,
      ]);
      expect(result).toBe("");
      // Credentials the entrypoint writes stay outside the preserved set.
      expect(
        await docker([
          "exec",
          containerId,
          "sh",
          "-c",
          "mountpoint -q /home/node/.claude && echo mounted || echo layer",
        ]),
      ).toBe("layer");
      await docker(["rm", "-f", containerId]);
    },
    LIVE_TIMEOUT_MS,
  );
});

describe("C20 staged portable inputs", () => {
  live(
    "a staged-inputs runtime can read only the allowlist of enabled providers",
    async () => {
      const { memoryLifecycleContext, lifecycleEnvironment } =
        await import("./container-lifecycle-fixtures");
      const { createDockerContainer } =
        await import("../../../apps/backend/src/core/commands-containers");
      const { resolveDockerImage } = await import("../../../apps/backend/src/core/docker-image");
      const fixtureHome = path.join(dataDir, "fixture-home");
      const SENTINEL = `ORKSENTINEL${RUN}`;
      const write = async (file: string, content: string) => {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, content);
      };
      await write(path.join(fixtureHome, ".claude", ".credentials.json"), '{"claudeAiOauth":{}}');
      await write(path.join(fixtureHome, ".claude", "CLAUDE.md"), "fixture memory");
      await write(path.join(fixtureHome, ".claude", "history.jsonl"), `${SENTINEL}-HISTORY`);
      await write(path.join(fixtureHome, ".claude", "projects", "p", "s.jsonl"), `${SENTINEL}-T`);
      await write(path.join(fixtureHome, ".codex", "auth.json"), '{"fixture":true}');
      await write(path.join(fixtureHome, ".codex", "sessions", "r.jsonl"), `${SENTINEL}-CODEX`);
      await write(path.join(fixtureHome, ".pi", "agent", "auth.json"), `${SENTINEL}-DISABLED-PI`);
      const saved = {
        claude: process.env.ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR,
        codex: process.env.CODEX_HOME,
        host: process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME,
      };
      process.env.ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR = path.join(fixtureHome, ".claude");
      process.env.CODEX_HOME = path.join(fixtureHome, ".codex");
      process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME = fixtureHome;
      try {
        const environment = lifecycleEnvironment({
          id: `env-${RUN}-inputs`,
          networkAccessMode: "full",
        });
        const { context } = memoryLifecycleContext([environment], dataDir);
        Object.assign(context, {
          runtimeFlavor: "agent-test",
          credentialSources: new Set(["claude", "codex", "pi"]),
        });
        Object.assign(context.storage, {
          getProject: async () => ({
            id: "project-1",
            name: "Project",
            gitUrl: "https://example.invalid/none.git",
            localPath: null,
            addedAt: new Date(0).toISOString(),
            order: 0,
          }),
          loadConfig: async () => ({
            version: "1.0.0",
            // Pi is authorized by the profile but not enabled: not staged.
            global: { allowedDomains: [], enabledAgentPlatforms: ["claude", "codex"] },
            repositories: {},
          }),
        });
        const resolved = await resolveDockerImage(IMAGE);
        if (resolved.kind !== "present") throw new Error("qualification image missing");
        const containerId = await createDockerContainer(environment, context, {
          imageId: resolved.imageId,
          runtimeGeneration: 1,
        });
        // Every bind source is inside this environment's staged revision.
        const mounts = JSON.parse(
          await docker(["inspect", "-f", "{{json .Mounts}}", containerId]),
        ) as Array<{ Type: string; Source: string; Destination: string; RW: boolean }>;
        const binds = mounts.filter((mount) => mount.Type === "bind");
        expect(binds.length).toBeGreaterThan(0);
        for (const bind of binds) {
          expect(bind.Source.startsWith(path.join(dataDir, "portable-inputs"))).toBe(true);
          expect(bind.RW).toBe(false);
        }
        expect(binds.map((bind) => bind.Destination).sort()).toEqual([
          "/claude-config",
          "/codex-home",
        ]);
        await docker(["start", containerId]);
        await waitForContainerBoot(containerId);
        const sentinelScan = await docker([
          "exec",
          containerId,
          "sh",
          "-c",
          `grep -rl ${SENTINEL} /claude-config /codex-home /pi-config /home/node /tmp /run 2>/dev/null | head -5; true`,
        ]);
        expect(sentinelScan).toBe("");
        expect(
          await docker([
            "exec",
            "-u",
            "node",
            containerId,
            "sh",
            "-c",
            "cat /home/node/.codex/auth.json; test -f /home/node/.claude/CLAUDE.md && echo claude-md",
          ]),
        ).toBe('{"fixture":true}claude-md');
        await docker(["rm", "-f", containerId]);
      } finally {
        for (const [key, value] of [
          ["ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR", saved.claude],
          ["CODEX_HOME", saved.codex],
          ["ORKESTRATOR_AGENT_TEST_HOST_HOME", saved.host],
        ] as const) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    },
    LIVE_TIMEOUT_MS,
  );
});
