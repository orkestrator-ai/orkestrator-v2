import { describe, expect, mock, spyOn, test } from "bun:test";
import http from "node:http";

import { createCommandFixtures } from "./command-fixtures";
import type { CommandContext } from "./command-fixtures";
import { installStandaloneBackendLogging } from "../../../apps/backend/src/standalone-logging";
import {
  createProviderStub,
  withService,
  waitForCondition,
} from "../../../apps/backend/src/core/native-agent-service-projection-test-support";

const {
  commandTesting,
  createCommandRegistry,
  createContext,
  createEnvironment,
  createTempDir,
  isProcessRunning,
  requestOk,
  writeBridgeEntrypoint,
} = await createCommandFixtures();

/**
 * A bridge whose health answer the test controls: `/fail?n=N` makes the next
 * N health probes answer 503, `/stall` fails every probe until `/recover`.
 * A 503 fails a probe immediately, so these tests never wait out a timeout.
 */
const CONTROLLABLE_BRIDGE = `
  const http = require("node:http");
  let failRemaining = 0;
  let stalled = false;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/fail") failRemaining = Number(url.searchParams.get("n"));
    else if (url.pathname === "/stall") stalled = true;
    else if (url.pathname === "/recover") stalled = false;
    else if (url.pathname === "/supervision") {
      res.writeHead(200);
      res.end(process.env.ORKESTRATOR_DESKTOP_SUPERVISED || "unset");
      return;
    }
    else if (url.pathname === "/global/health") {
      const healthy = !stalled && failRemaining === 0;
      if (failRemaining > 0) failRemaining -= 1;
      res.writeHead(healthy ? 200 : 503);
      res.end();
      return;
    } else {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200);
    res.end();
  });
  server.listen(Number(process.env.PORT), "127.0.0.1");
  setInterval(() => {}, 60_000);
`;

type Started = { port: number; pid: number; wasRunning: boolean; authToken: string };

async function startControllableBridge(
  environmentId: string,
  liveWork: () => boolean,
): Promise<{
  commands: ReturnType<typeof createCommandRegistry>;
  context: CommandContext;
  environmentId: string;
  first: Started;
  hasObservedLiveWork: ReturnType<typeof mock>;
}> {
  const appRoot = await createTempDir("ork-electron-app-bridge-reuse-");
  const worktreePath = await createTempDir("ork-electron-worktree-bridge-reuse-");
  await writeBridgeEntrypoint(appRoot, "codex-bridge", CONTROLLABLE_BRIDGE);
  const environment = createEnvironment({ id: environmentId, worktreePath });
  const { context } = createContext(environment);
  context.appRoot = appRoot;
  context.resourceRoot = appRoot;
  const hasObservedLiveWork = mock(async () => liveWork());
  context.nativeAgents = { hasObservedLiveWork } as unknown as CommandContext["nativeAgents"];
  const commands = createCommandRegistry();
  const first = (await commands.get("start_local_codex_server_cmd")?.(
    { environmentId },
    context,
  )) as Started;
  expect(first.wasRunning).toBe(false);
  return { commands, context, environmentId, first, hasObservedLiveWork };
}

describe("local bridge reuse under load", () => {
  test("does not pass desktop supervision to a spawned bridge", async () => {
    const previous = process.env.ORKESTRATOR_DESKTOP_SUPERVISED;
    process.env.ORKESTRATOR_DESKTOP_SUPERVISED = "1";
    try {
      expect(
        installStandaloneBackendLogging({ dataDir: "/unused", runtimeFlavor: "production" }),
      ).toBeNull();
      const { first } = await startControllableBridge("env-bridge-supervision-env", () => false);
      const supervision = await new Promise<string>((resolve, reject) => {
        http
          .get(`http://127.0.0.1:${first.port}/supervision`, (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk: string) => (body += chunk));
            response.on("end", () => resolve(body));
          })
          .on("error", reject);
      });
      expect(supervision).toBe("unset");
    } finally {
      if (previous === undefined) delete process.env.ORKESTRATOR_DESKTOP_SUPERVISED;
      else process.env.ORKESTRATOR_DESKTOP_SUPERVISED = previous;
    }
  });

  test("keeps a live bridge that misses a health probe and then answers", async () => {
    // A host saturated by a test suite can stall a healthy bridge past one
    // probe. Replacing it on that alone killed the agent mid-turn.
    const { commands, context, environmentId, first, hasObservedLiveWork } =
      await startControllableBridge("env-bridge-reuse-blip", () => false);
    await expect(requestOk(first.port, "/fail?n=2")).resolves.toBe(true);

    const second = (await commands.get("start_local_codex_server_cmd")?.(
      { environmentId },
      context,
    )) as Started;

    expect(second).toMatchObject({ wasRunning: true, pid: first.pid, port: first.port });
    expect(hasObservedLiveWork).not.toHaveBeenCalled();
  });

  test("leaves an unresponsive bridge running while its sessions have work in progress", async () => {
    const { commands, context, environmentId, first } = await startControllableBridge(
      "env-bridge-reuse-busy",
      () => true,
    );
    await expect(requestOk(first.port, "/stall")).resolves.toBe(true);

    await expect(
      commands.get("start_local_codex_server_cmd")?.({ environmentId }, context),
    ).rejects.toMatchObject({ retryable: true });
    expect(isProcessRunning(first.pid)).toBe(true);

    // The activity sweep must not read the stalled bridge as absent, which
    // would record its running turn as idle.
    await expect(
      commands.get("peek_local_agent_bridge")?.({ environmentId, agent: "codex" }, context),
    ).rejects.toThrow("not answering health checks");

    // Once the bridge answers again it is reused, not replaced.
    await expect(requestOk(first.port, "/recover")).resolves.toBe(true);
    const recovered = (await commands.get("start_local_codex_server_cmd")?.(
      { environmentId },
      context,
    )) as Started;
    expect(recovered).toMatchObject({ wasRunning: true, pid: first.pid });
  });

  test("keeps the bridge while a provider send has not yet produced an activity observation", async () => {
    const { commands, context, environmentId, first } = await startControllableBridge(
      "env-1",
      () => false,
    );
    let finishSend: (() => void) | undefined;
    const sendHeld = new Promise<void>((resolve) => {
      finishSend = resolve;
    });
    const { provider, send } = createProviderStub("codex", { send: async () => sendHeld });
    await withService(
      { prefix: "ork-bridge-inflight-dispatch-", provider: async () => provider },
      async ({ service }) => {
        context.nativeAgents = service;
        const dispatch = service.dispatchPrompt({
          environmentId: "env-1",
          agent: "codex",
          logicalSessionKey: "tab-1",
          prompt: "Run work",
          requestId: "dispatch-1",
        });
        try {
          await waitForCondition(() => send.mock.calls.length > 0);
          expect(await service.hasObservedLiveWork("env-1", "codex")).toBe(true);
          await expect(requestOk(first.port, "/stall")).resolves.toBe(true);
          await expect(
            commands.get("start_local_codex_server_cmd")?.({ environmentId }, context),
          ).rejects.toMatchObject({ retryable: true });
          expect(isProcessRunning(first.pid)).toBe(true);
        } finally {
          finishSend?.();
          await dispatch;
        }
      },
    );
  });

  test("starts a fresh grace period after recovery is observed by a peek", async () => {
    const { commands, context, environmentId, first } = await startControllableBridge(
      "env-bridge-reuse-recovered",
      () => true,
    );
    await expect(requestOk(first.port, "/stall")).resolves.toBe(true);
    await expect(
      commands.get("start_local_codex_server_cmd")?.({ environmentId }, context),
    ).rejects.toMatchObject({ retryable: true });
    commandTesting.markLocalServerUnresponsiveSince(
      `codex:${environmentId}`,
      Date.now() - 3 * 60_000,
    );
    await expect(requestOk(first.port, "/recover")).resolves.toBe(true);
    await expect(
      commands.get("peek_local_agent_bridge")?.({ environmentId, agent: "codex" }, context),
    ).resolves.toMatchObject({ port: first.port });
    await expect(requestOk(first.port, "/stall")).resolves.toBe(true);
    await expect(
      commands.get("start_local_codex_server_cmd")?.({ environmentId }, context),
    ).rejects.toMatchObject({ retryable: true });
    expect(isProcessRunning(first.pid)).toBe(true);
  });

  test("classifies a child that exited during its peek as absent", async () => {
    const { commands, context, environmentId, first } = await startControllableBridge(
      "env-bridge-reuse-exited-peek",
      () => false,
    );
    await expect(requestOk(first.port, "/stall")).resolves.toBe(true);
    const child = commandTesting.getLocalServerProcess(`codex:${environmentId}`);
    expect(child).toBeDefined();
    if (!child) return;
    const originalExitCode = child.exitCode;
    try {
      child.exitCode = 1;
      await expect(
        commands.get("peek_local_agent_bridge")?.({ environmentId, agent: "codex" }, context),
      ).resolves.toBeNull();
    } finally {
      child.exitCode = originalExitCode;
    }
    expect(isProcessRunning(first.pid)).toBe(true);
  });

  test("treats a new failure after a long observation gap as a new stall", async () => {
    const { commands, context, environmentId, first } = await startControllableBridge(
      "env-bridge-reuse-failure-gap",
      () => true,
    );
    await expect(requestOk(first.port, "/stall")).resolves.toBe(true);
    commandTesting.markLocalServerUnresponsiveSince(
      `codex:${environmentId}`,
      Date.now() - 3 * 60_000,
    );
    // Model a bridge that recovered while a cached provider skipped peeks.
    commandTesting.markLocalServerLastFailureAt(`codex:${environmentId}`, Date.now() - 31_000);
    await expect(
      commands.get("start_local_codex_server_cmd")?.({ environmentId }, context),
    ).rejects.toMatchObject({ retryable: true });
    expect(isProcessRunning(first.pid)).toBe(true);
  });

  test("replaces a busy bridge that has stayed unresponsive past the grace period", async () => {
    const { commands, context, environmentId, first } = await startControllableBridge(
      "env-bridge-reuse-wedged",
      () => true,
    );
    await expect(requestOk(first.port, "/stall")).resolves.toBe(true);
    commandTesting.markLocalServerUnresponsiveSince(
      `codex:${environmentId}`,
      Date.now() - 3 * 60_000,
    );

    const replacement = (await commands.get("start_local_codex_server_cmd")?.(
      { environmentId },
      context,
    )) as Started;

    expect(replacement.wasRunning).toBe(false);
    expect(replacement.pid).not.toBe(first.pid);
    expect(isProcessRunning(first.pid)).toBe(false);
  });

  test("replaces an idle unresponsive bridge and logs why", async () => {
    const { commands, context, environmentId, first } = await startControllableBridge(
      "env-bridge-reuse-idle",
      () => false,
    );
    await expect(requestOk(first.port, "/stall")).resolves.toBe(true);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const replacement = (await commands.get("start_local_codex_server_cmd")?.(
        { environmentId },
        context,
      )) as Started;

      expect(replacement.wasRunning).toBe(false);
      expect(replacement.pid).not.toBe(first.pid);
      const logged = warn.mock.calls.map((call) => String(call[0]));
      expect(
        logged.some(
          (line) =>
            line.includes(`codex:${environmentId} (pid ${first.pid})`) &&
            line.includes("health check failed 3 consecutive times"),
        ),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
