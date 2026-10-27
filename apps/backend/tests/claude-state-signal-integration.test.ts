import { resetNetworkOwnerCache } from "../src/core/container-network-owner";
import { expect, test, describe } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backendClaudeStateSignal,
  claudeStateSignalSupport,
  claudeStateSignalInstaller,
} from "../src/core/claude-state-signal.js";
import { ManualTime, flushMicrotasks } from "../src/core/recurring-test-support.js";
import type { ClaudeStateSignalSupport } from "../src/core/tmux-poll.js";
import type { ManifestRead } from "../src/core/docker-image.js";
import {
  lifecycleEnvironment,
  memoryLifecycleContext,
  withDockerScript,
} from "./container-lifecycle-fixtures.js";
import { ClaudeStatePollManager, parseClaudeStateSnapshot } from "../src/core/tmux-poll.js";

const SCRIPT = join(import.meta.dir, "../../../docker/orkestrator-state-signal.sh");
const credential = {
  url: "http://host.docker.internal:43123/claude-state-signal",
  token: "A".repeat(43),
};

describe("Claude state signal capability gate", () => {
  test("missing environment or runtime image remains retryable", async () => {
    for (const environments of [[], [lifecycleEnvironment({ containerId: "container-1" })]]) {
      const { context } = memoryLifecycleContext(environments, "/tmp/signal-support");
      let reads = 0;
      expect(
        await claudeStateSignalSupport("container-1", context, async () => {
          reads += 1;
          return { kind: "legacy" };
        }),
      ).toBe("unknown");
      expect(reads).toBe(0);
    }
  });

  test("retries missing image identity once it becomes available", async () => {
    const environment = lifecycleEnvironment({ containerId: "container-1", status: "running" });
    const { context, environments } = memoryLifecycleContext([environment], "/tmp/signal-support");
    let credentials = 0;
    context.agentTools = {
      connection: () => ({ ...credential }),
      revokeEnvironment: () => undefined,
      issueStateSignal: () => {
        credentials += 1;
        return { ...credential, revoke() {} };
      },
    } as typeof context.agentTools;
    context.storage.setEnvironmentAgentActivity = async (_id, state, occurredAt) => ({
      ...environment,
      agentActivitySources: { "claude-terminal": { state, updatedAt: occurredAt } },
    });
    const time = new ManualTime();
    let supportCalls = 0;
    const manager = new ClaudeStatePollManager({
      readState: async () => "waiting 0 0",
      nowMs: time.now,
      schedule: time.setInterval.bind(time),
      cancel: time.clear.bind(time),
      signal: {
        support: async (id, ctx) => {
          supportCalls += 1;
          return claudeStateSignalSupport(id, ctx, async () => ({
            kind: "manifest",
            manifest: {
              schemaVersion: 1,
              appVersion: "1.0.0",
              sourceRevision: null,
              architecture: "arm64",
              runtimes: {},
              agents: {},
              bridges: [],
              stateFormats: {},
              capabilities: { "claude-state-signal": 2 },
            },
          }));
        },
        install: async () => undefined,
      },
    });
    try {
      manager.start("container-1", context);
      await flushMicrotasks();
      expect(credentials).toBe(0);
      environment.containerLifecycle = {
        schemaVersion: 1,
        revision: 1,
        lastRuntimeGeneration: 1,
        runtime: {
          containerId: "container-1",
          runtimeGeneration: 1,
          owner: "test",
          imageId: "sha256:image",
        },
        storage: { format: "legacy-layer", workspaceGeneration: 1 },
        outcomes: [],
      };
      environments.set(environment.id, environment);
      await time.advance(300_000);
      manager.start("container-1", context);
      await flushMicrotasks();
      expect(supportCalls).toBe(2);
      expect(credentials).toBe(1);
    } finally {
      manager.shutdown("container-1");
    }
  });

  test("distinguishes temporary inspection failure from fixed image capabilities", async () => {
    const environment = lifecycleEnvironment({
      containerId: "container-1",
      containerLifecycle: {
        schemaVersion: 1,
        revision: 1,
        lastRuntimeGeneration: 1,
        storage: { format: "legacy-layer", workspaceGeneration: 1 },
        outcomes: [],
        runtime: {
          containerId: "container-1",
          runtimeGeneration: 1,
          owner: "test",
          imageId: "sha256:image",
        },
      },
    });
    const { context } = memoryLifecycleContext([environment], "/tmp/signal-support");
    const cases: Array<[ManifestRead, ClaudeStateSignalSupport]> = [
      [{ kind: "unavailable" }, "unknown"],
      [{ kind: "legacy" }, "unsupported"],
      [{ kind: "invalid", reason: "malformed" }, "unsupported"],
    ];
    for (const version of [undefined, 0, 1, 2, 3]) {
      cases.push([
        {
          kind: "manifest",
          manifest: {
            schemaVersion: 1,
            appVersion: "1.0.0",
            sourceRevision: null,
            architecture: "arm64",
            runtimes: {},
            agents: {},
            bridges: [],
            stateFormats: {},
            capabilities: version === undefined ? {} : { "claude-state-signal": version },
          },
        },
        version !== undefined && version >= 2 ? "supported" : "unsupported",
      ]);
    }
    for (const [answer, expected] of cases) {
      let image: string | undefined;
      expect(
        await claudeStateSignalSupport("container-1", context, async (imageId) => {
          image = imageId;
          return answer;
        }),
      ).toBe(expected);
      expect(image).toBe("sha256:image");
    }
  });
});

test("the production backend builds its polls with the Docker installer", () => {
  const original = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "production";
    expect(backendClaudeStateSignal()).toBe(claudeStateSignalInstaller);
    process.env.NODE_ENV = "test";
    expect(backendClaudeStateSignal()).toBeUndefined();
  } finally {
    process.env.NODE_ENV = original;
  }
});

test("production install prepares the host and firewall before writing and fences retirement", async () => {
  const { context } = memoryLifecycleContext([], "/tmp/signal-install");
  context.agentTools = { servicePort: () => 43123 } as typeof context.agentTools;
  resetNetworkOwnerCache();
  await withDockerScript(
    `#!/bin/sh
case "$*" in
  *"getent hosts host.docker.internal"*) printf '192.0.2.1 host.docker.internal\\n' ;;
  *"getent hosts gateway.docker.internal"*) ;;
  *"inspect"*) printf '192.0.2.1\\n' ;;
  *"network-policy"*) printf '3\\n1234\\n' ;;
esac
# Do not log stdin or the config script (credentials).
printf '%s\\n' "$1 $2 $3 $4 $5" >> "$FAKE_DOCKER_LOG"
`,
    async (log) => {
      await claudeStateSignalInstaller.install(
        "container-1",
        { ...credential, revoke() {} },
        context,
        () => true,
      );
      const calls = (await log.read()).trim().split("\n");
      // The namespace owner is looked up once (a runtime behind an egress
      // gateway reads and changes the gateway's firewall), then cached.
      expect(calls).toHaveLength(7);
      expect(calls[2]).toContain("{{.HostConfig.NetworkMode}}");
      expect(calls[5]).toContain("--user root container-1 /usr/local/bin/update-firewall.sh");
      expect(calls[6]).toBe("exec -i container-1 sh -c");
      await claudeStateSignalInstaller.install(
        "container-1",
        { ...credential, revoke() {} },
        context,
        () => false,
      );
      expect((await log.read()).trim().split("\n")).toHaveLength(12);
    },
  );
});

test("snapshot parsing rejects malformed, oversized and impossible counters", () => {
  expect(parseClaudeStateSnapshot("waiting 2 1")).toEqual({
    state: "waiting",
    revision: 2,
    completions: 1,
  });
  for (const value of [
    "waiting 1 2",
    "working -1 0",
    "idle 1.5 0",
    "waiting 1",
    "waiting 2 1 extra",
    "x".repeat(256),
  ]) {
    expect(parseClaudeStateSnapshot(value)).toEqual({ state: "" });
  }
});

test("hook writers serialize counters and retain a completed turn without any config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ork-state-counters-"));
  const stateFile = join(dir, "state");
  const env = {
    ...process.env,
    ORKESTRATOR_STATE_FILE: stateFile,
    ORKESTRATOR_STATE_SIGNAL_CONFIG: join(dir, "absent"),
  };
  try {
    const writers = Array.from({ length: 20 }, () =>
      Bun.spawn(["sh", SCRIPT, "working"], { env, stdout: "pipe", stderr: "pipe" }),
    );
    expect(await Promise.all(writers.map((writer) => writer.exited))).toEqual(Array(20).fill(0));
    expect(readFileSync(`${stateFile}-snapshot`, "utf8").trim()).toBe("working 20 0");
    expect(spawnSync("sh", [SCRIPT, "waiting"], { env }).status).toBe(0);
    expect(readFileSync(`${stateFile}-snapshot`, "utf8").trim()).toBe("waiting 21 1");
    expect(readFileSync(stateFile, "utf8").trim()).toBe("waiting");
    // A duplicate Stop cannot manufacture another completion.
    expect(spawnSync("sh", [SCRIPT, "waiting"], { env }).status).toBe(0);
    expect(readFileSync(`${stateFile}-snapshot`, "utf8").trim()).toBe("waiting 22 1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
