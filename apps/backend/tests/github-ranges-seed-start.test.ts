/**
 * The start path hands a restricted container a fresh GitHub ranges seed
 * before it boots (to-do 7549 task 2), through a fake `docker` CLI.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import {
  startContainerWithAgentAccounts,
  type ContainerRunners,
} from "../src/core/agent-accounts-containers";
import type { CommandContext } from "../src/core/commands-context";
import { resetNetworkOwnerCache } from "../src/core/container-network-owner";
import type { Environment } from "../src/core/models";
import { formatGithubRangesSeed, githubRangesSeedFile } from "../src/core/github-ranges-cache";
import {
  tempDir,
  withDockerScript,
  writeGithubRangesSeedFixture,
} from "./container-lifecycle-fixtures";

const cleanup: string[] = [];
afterEach(async () => {
  resetNetworkOwnerCache();
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const runners: ContainerRunners = {
  exec: async () => "",
  pipe: async () => undefined,
  label: async () => null,
};

/**
 * A daemon with one stopped runtime, `container-1`, and no gateway. `$SEED`
 * is what the delivery's inspect reports: the restricted marker, role,
 * gateway label and mounts.
 */
function daemon(seedAnswer: string): string {
  return `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$*" in
  *NETWORK_MODE=restricted*) printf '${seedAnswer}\\n' ;;
  *HostConfig.NetworkMode*) printf 'ork-net\\n' ;;
  *State.Running*) printf 'false\\n' ;;
esac
exit 0
`;
}

const GATEWAY = "b".repeat(64);
const SEED_FORMAT = "NETWORK_MODE=restricted";

/**
 * A daemon with one stopped runtime, `container-1`, behind a stopped egress
 * gateway that applies its firewall once started. The gateway's seed inspect
 * reports a gateway created before the bind, so it is given a copy.
 */
function gatewayDaemon(): string {
  return `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$*" in
  *${SEED_FORMAT}*" ${GATEWAY}") printf 'restricted\\tegress-gateway\\t\\t/run;\\n' ;;
  *${SEED_FORMAT}*) printf 'restricted\\t\\tork-env-egress\\t/workspace;\\n' ;;
  *"{{.HostConfig.NetworkMode}} container-1") printf 'container:${GATEWAY}\\n' ;;
  *"--format {{.Id}}"*) printf '${GATEWAY}\\t%s\\t2026-11-15T10:00:00Z\\towner\\tegress-gateway\\tcontainer-1\\tenv-1\\n' "$(cat "$FAKE_DOCKER_LOG.gw" 2>/dev/null || echo false)" ;;
  "start ${GATEWAY}") printf true > "$FAKE_DOCKER_LOG.gw" ;;
  "exec ${GATEWAY} sh -c"*) printf '%s' '{"state":"applied"}' ;;
  *State.Running*) printf 'false\\t2026-11-15T09:00:00Z\\n' ;;
esac
exit 0
`;
}

function contextFor(dataDir: string): CommandContext {
  return { storage: { getDataDir: () => dataDir } } as unknown as CommandContext;
}

async function startWith(
  seedAnswer: string,
  environment: Environment | null = null,
): Promise<{ calls: string[]; dataDir: string }> {
  const dataDir = await tempDir("ork-seed-start-");
  cleanup.push(dataDir);
  await writeGithubRangesSeedFixture(
    dataDir,
    formatGithubRangesSeed(["192.30.252.0/22"], Date.now()),
  );
  let calls: string[] = [];
  await withDockerScript(daemon(seedAnswer), async (log) => {
    await startContainerWithAgentAccounts(contextFor(dataDir), environment, "container-1", runners);
    calls = (await log.read()).split("\n").filter(Boolean);
  });
  return { calls, dataDir };
}

describe("starting a restricted runtime", () => {
  test("a runtime created before the bind is given a fresh seed copy before it starts", async () => {
    const { calls } = await startWith("restricted\\t\\t\\t/workspace;");
    const copy = calls.findIndex(
      (line) => line.startsWith("cp ") && line.endsWith("container-1:/etc/orkestrator-seed"),
    );
    const start = calls.indexOf("start container-1");
    expect(copy).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(copy);
  });

  test("a runtime that binds the seed directory is started with no copy", async () => {
    const { calls, dataDir } = await startWith(
      "restricted\\t\\t\\t/workspace;/etc/orkestrator-seed;",
    );
    expect(calls.some((line) => line.startsWith("cp "))).toBe(false);
    expect(calls).toContain("start container-1");
    // The fresh seed was served as it was, without a fetch.
    expect(await fs.readFile(githubRangesSeedFile(dataDir), "utf8")).toContain("192.30.252.0/22");
  });

  test("a full-mode runtime is neither refreshed nor copied into", async () => {
    const { calls } = await startWith("\\t\\t\\t/workspace;");
    expect(calls.some((line) => line.startsWith("cp "))).toBe(false);
    expect(calls).toContain("start container-1");
  });

  test("a runtime whose environment is in full mode is started without a seed inspect", async () => {
    const environment = { id: "env-1", networkAccessMode: "full" } as unknown as Environment;
    const { calls } = await startWith("restricted\\t\\t\\t/workspace;", environment);
    expect(calls.some((line) => line.includes(SEED_FORMAT))).toBe(false);
    expect(calls.some((line) => line.startsWith("cp "))).toBe(false);
    expect(calls).toContain("start container-1");
  });
});

describe("starting a runtime behind an egress gateway", () => {
  test("the gateway, not the runtime, is given the seed before the gateway boots", async () => {
    const dataDir = await tempDir("ork-seed-start-gateway-");
    cleanup.push(dataDir);
    await writeGithubRangesSeedFixture(
      dataDir,
      formatGithubRangesSeed(["192.30.252.0/22"], Date.now()),
    );
    let calls: string[] = [];
    await withDockerScript(gatewayDaemon(), async (log) => {
      await startContainerWithAgentAccounts(contextFor(dataDir), null, "container-1", runners);
      calls = (await log.read()).split("\n").filter(Boolean);
    });
    const gatewayCopy = calls.findIndex(
      (line) => line.startsWith("cp ") && line.endsWith(`${GATEWAY}:/etc/orkestrator-seed`),
    );
    const gatewayStart = calls.indexOf(`start ${GATEWAY}`);
    expect(gatewayCopy).toBeGreaterThan(-1);
    expect(gatewayStart).toBeGreaterThan(gatewayCopy);
    // The runtime runs no firewall of its own: it is neither inspected for
    // the seed nor copied into, so it adds no Docker call.
    const seedInspects = calls.filter((line) => line.includes(SEED_FORMAT));
    expect(seedInspects).toHaveLength(1);
    expect(seedInspects[0]!.endsWith(` ${GATEWAY}`)).toBe(true);
    expect(calls.some((line) => line.startsWith("cp ") && line.includes("container-1:"))).toBe(
      false,
    );
    expect(calls.indexOf("start container-1")).toBeGreaterThan(gatewayStart);
  });
});
