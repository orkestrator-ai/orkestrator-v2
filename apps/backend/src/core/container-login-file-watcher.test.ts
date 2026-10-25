import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CommandContext } from "./commands-context.js";
import { ContainerLoginFileWatcher } from "./container-login-file-watcher.js";
import type { Environment } from "./models.js";

const savedHostHome = process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME;
const savedDataHome = process.env.XDG_DATA_HOME;
let root: string;

function environment(id: string, overrides: Partial<Environment> = {}): Environment {
  return { id, containerId: `container-${id}`, status: "running", ...overrides } as Environment;
}

function harness(options: { environments: Environment[]; leaseHeld?: boolean }) {
  const synced: string[] = [];
  const hooks: { afterSync?: () => void | string } = {};
  const context = {
    runtimeFlavor: "agent-test",
    credentialSources: new Set(["grok", "opencode", "pi"]),
    registryWriterLease:
      options.leaseHeld === undefined ? undefined : { isHeld: () => options.leaseHeld },
    storage: {
      loadConfig: async () => ({
        global: { enabledAgentPlatforms: ["grok", "opencode", "pi"] },
      }),
      loadEnvironments: async () => options.environments,
    },
  } as unknown as CommandContext;
  const scheduled: Array<() => void> = [];
  const watcher = new ContainerLoginFileWatcher(context, {
    syncContainer: async (provider, containerId) => {
      synced.push(`${provider}:${containerId}`);
      return hooks.afterSync?.();
    },
    timers: {
      setTimeout: (callback) => {
        scheduled.push(callback);
        return scheduled.length;
      },
      clearTimeout: () => undefined,
    },
  });
  return { watcher, synced, scheduled, hooks, context };
}

const grokAuth = () => path.join(root, "host-home", ".grok", "auth.json");
const piAuth = () => path.join(root, "host-home", ".pi", "agent", "auth.json");

async function write(file: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  // A new inode each time, as the CLIs' rename does.
  await fs.writeFile(`${file}.tmp`, contents);
  await fs.rename(`${file}.tmp`, file);
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "ork-login-watch-")));
  process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME = path.join(root, "host-home");
  process.env.XDG_DATA_HOME = path.join(root, "host-data");
});

afterEach(async () => {
  if (savedHostHome === undefined) delete process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME;
  else process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME = savedHostHome;
  if (savedDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = savedDataHome;
  await fs.rm(root, { recursive: true, force: true });
});

describe("ContainerLoginFileWatcher", () => {
  test("pushes a changed host file to every running container that may receive it", async () => {
    const run = harness({
      environments: [
        environment("a"),
        environment("stopped", { status: "stopped" } as Partial<Environment>),
        environment("revoked", { revokedInputProviders: ["grok"] }),
        environment("local", { containerId: null } as Partial<Environment>),
        environment("b"),
      ],
    });
    // Initial absence still reconciles imported Grok logins.
    expect(await run.watcher.tick()).toEqual(["grok"]);
    run.synced.length = 0;
    await write(grokAuth(), "{}");
    expect(await run.watcher.tick()).toEqual(["grok"]);
    expect(run.synced).toEqual(["grok:container-a", "grok:container-b"]);
    // Unchanged: nothing is read or pushed.
    run.synced.length = 0;
    expect(await run.watcher.tick()).toEqual([]);
    expect(run.synced).toEqual([]);
    // A renewal and a second provider in one pass; the revoked container still
    // gets Pi.
    await write(grokAuth(), '{"renewed":{}}');
    await write(piAuth(), "{}");
    expect(await run.watcher.tick()).toEqual(["grok", "pi"]);
    expect(run.synced).toEqual([
      "grok:container-a",
      "grok:container-b",
      "pi:container-a",
      "pi:container-revoked",
      "pi:container-b",
    ]);
  });

  test("a host file that disappears is pushed too, so a sign-out reaches containers", async () => {
    const run = harness({ environments: [environment("a")] });
    await write(grokAuth(), "{}");
    await run.watcher.tick();
    run.synced.length = 0;
    await fs.rm(grokAuth());
    expect(await run.watcher.tick()).toEqual(["grok"]);
    expect(run.synced).toEqual(["grok:container-a"]);
  });

  test("a backend without the writer lease leaves containers to the writer", async () => {
    const run = harness({ environments: [environment("a")], leaseHeld: false });
    await write(grokAuth(), "{}");
    expect(await run.watcher.tick()).toEqual([]);
    expect(run.synced).toEqual([]);
  });

  test("retries only failed targets for an unchanged file", async () => {
    const run = harness({ environments: [environment("a"), environment("b")] });
    await write(grokAuth(), "{}");
    let attempts = 0;
    run.hooks.afterSync = () => {
      if (++attempts === 1) throw new Error("temporary transport failure");
    };
    await run.watcher.tick();
    run.synced.length = 0;
    expect(await run.watcher.tick()).toEqual(["grok"]);
    expect(run.synced).toEqual(["grok:container-a"]);
    expect(await run.watcher.tick()).toEqual([]);
  });

  test("failed and skipped outcomes stay pending, and a storage failure loses no delivery", async () => {
    const run = harness({ environments: [environment("a")] });
    await write(grokAuth(), "{}");
    for (const outcome of ["failed", "skipped"]) {
      run.hooks.afterSync = () => outcome;
      expect(await run.watcher.tick()).toEqual(["grok"]);
    }
    run.hooks.afterSync = undefined;
    expect(await run.watcher.tick()).toEqual(["grok"]);
    expect(await run.watcher.tick()).toEqual([]);
    const { watcher, synced, context } = harness({ environments: [environment("b")] });
    // Fingerprints must not be acknowledged before config/storage is readable.
    const load = context.storage.loadConfig;
    context.storage.loadConfig = async () => {
      throw new Error("storage unavailable");
    };
    await watcher.tick();
    context.storage.loadConfig = load;
    expect(await watcher.tick()).toEqual(["grok"]);
    expect(synced).toEqual(["grok:container-b"]);
  });

  test("initial absence reaches existing containers and newly running targets reconcile unchanged files", async () => {
    const environments = [environment("a")];
    const run = harness({ environments });
    expect(await run.watcher.tick()).toEqual(["grok"]);
    expect(run.synced).toEqual(["grok:container-a"]);
    environments.push(environment("b"));
    run.synced.length = 0;
    await run.watcher.tick();
    expect(run.synced).toEqual(["grok:container-b"]);
  });

  test("stop cancels the schedule and cuts a pass short before its next container", async () => {
    const run = harness({ environments: [environment("a"), environment("b")] });
    run.watcher.start();
    expect(run.scheduled).toHaveLength(1);
    await write(grokAuth(), "{}");
    run.hooks.afterSync = () => run.watcher.stop();
    run.scheduled[0]!();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(run.synced).toEqual(["grok:container-a"]);
    // Stopped: the finished pass schedules nothing more.
    expect(run.scheduled).toHaveLength(1);
  });
});
