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
  const ids = (await docker(["ps", "-aq", "--filter", `label=${RUN_LABEL}`]).catch(() => ""))
    .split("\n")
    .filter(Boolean);
  if (ids.length > 0) await docker(["rm", "-f", ...ids]).catch(() => undefined);
  const volumes = (
    await docker(["volume", "ls", "-q", "--filter", `label=${RUN_LABEL}`]).catch(() => "")
  )
    .split("\n")
    .filter(Boolean);
  if (volumes.length > 0) await docker(["volume", "rm", ...volumes]).catch(() => undefined);
  const networks = (
    await docker(["network", "ls", "-q", "--filter", `label=${RUN_LABEL}`]).catch(() => "")
  )
    .split("\n")
    .filter(Boolean);
  if (networks.length > 0) await docker(["network", "rm", ...networks]).catch(() => undefined);
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
