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
import { formatGithubRangesSeed, githubRangesSeedFile } from "../src/core/github-ranges-cache";
import {
  tempDir,
  withDockerScript,
  writeGithubRangesSeedFixture,
} from "./container-lifecycle-fixtures";

const cleanup: string[] = [];
afterEach(async () => {
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

async function startWith(seedAnswer: string): Promise<{ calls: string[]; dataDir: string }> {
  const dataDir = await tempDir("ork-seed-start-");
  cleanup.push(dataDir);
  await writeGithubRangesSeedFixture(
    dataDir,
    formatGithubRangesSeed(["192.30.252.0/22"], Date.now()),
  );
  const context = {
    storage: { getDataDir: () => dataDir },
  } as unknown as CommandContext;
  let calls: string[] = [];
  await withDockerScript(daemon(seedAnswer), async (log) => {
    await startContainerWithAgentAccounts(context, null, "container-1", runners);
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
});
