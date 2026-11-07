/**
 * Phase 2 exit, desktop (plan item 2013): one Electron renderer holds its
 * command scope and a leaf scope at once, against two running `dev:test`
 * profiles, over the direct route and then the relay.
 *
 * Playwright cannot drive a profile's own Electron, so this spec launches its
 * own (a disposable agent-test profile, windows hidden on macOS) and connects
 * its window to the command profile's gateway as a remote command node
 * (`connections.connect`), with the leaf profile attached to that command
 * node. The renderer's dev-only harness `window.orkestratorScopeProof` opens
 * the leaf through the preload's `node(nodeId)`: main opens the node scope,
 * probes the leaf's direct origin, and otherwise binds the command node's
 * relay. The relay is forced by refusing, in main only, every request to the
 * leaf's origin (main's `fetch` is the only path main has to it; the command
 * node still reaches the leaf). Long-lived connections are counted per origin
 * from main's established TCP sockets (`lsof`); the renderer itself talks to
 * nodes over IPC, so its resource timing shows no node origin at all.
 *
 * ORKESTRATOR_AGENT_TEST_PROFILE=<cmd> ORKESTRATOR_AGENT_TEST_LEAF_PROFILE=<leaf> \
 *   bunx playwright test --config e2e/agent-testing/playwright.scope-proof.config.ts --project electron
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ElectronApplication, Page } from "playwright";
import { _electron as electron } from "playwright";

import { resolveRuntimeProfile } from "../../apps/desktop/electron/runtime-profile";
import { initializeProfile, reserveLoopbackPorts } from "../../apps/desktop/scripts/dev/profile-io";
import { ownProcessGroup, stopProcessGroup } from "../process-cleanup";
import { closeElectronWithin } from "./design-electron-cleanup";
import { expect, test } from "./electron-fixtures";
import { ELECTRON_TEST_SWITCHES } from "./electron-launch-switches";
import { dismissStartupDialogs } from "./electron-startup-dialogs";
import {
  SKIP_REASON,
  attachLeaf,
  commandProfile,
  createLeafEnvironment,
  deleteLeafEnvironment,
  gateway,
  leafProfile,
  repositoryRoot,
  scopeProofFailures,
  writeEvidence,
  type Gateway,
  type ScopeProofReport,
} from "./scope-proof-support";

const packageRoot = path.join(repositoryRoot, "apps", "desktop");
const webRoot = path.join(repositoryRoot, "apps", "web");
const electronExecutable = path.join(packageRoot, "node_modules", ".bin", "electron");
const QUIET_WINDOW_MS = Number(process.env.ORKESTRATOR_AGENT_TEST_SCOPE_PROOF_WINDOW_MS ?? 20_000);

test.skip(!commandProfile || !leafProfile, SKIP_REASON);

test.beforeAll(() => {
  const build = spawnSync("bun", ["scripts/electron-bundle.ts"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
});

/** Established TCP connections from Electron main, by remote port. */
function mainConnections(pid: number): Record<string, number> {
  const listed = spawnSync(
    "lsof",
    ["-a", "-p", String(pid), "-iTCP", "-sTCP:ESTABLISHED", "-n", "-P", "-Fn"],
    {
      encoding: "utf8",
    },
  );
  const counts: Record<string, number> = {};
  for (const line of listed.stdout.split("\n")) {
    const match = /^n[^>]+->([^:]+):(\d+)$/u.exec(line.trim());
    if (match) counts[match[2]!] = (counts[match[2]!] ?? 0) + 1;
  }
  return counts;
}

type ScopeProofApi = {
  run(input: unknown): Promise<unknown>;
  close(nodeId: string): void;
  scopes(): unknown;
};

async function harnessReady(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            typeof (globalThis as unknown as { orkestratorScopeProof?: unknown })
              .orkestratorScopeProof,
        ),
      { timeout: 60_000, message: "the agent-test renderer installs the scope-proof harness" },
    )
    .toBe("object");
}

async function proveRoute(
  app: ElectronApplication,
  page: Page,
  input: {
    command: Gateway;
    leaf: Gateway;
    commandNodeId: string;
    leafNodeId: string;
    relay: boolean;
  },
): Promise<void> {
  const route = input.relay ? "relay" : "direct";
  const environment = await createLeafEnvironment(
    input.leaf,
    `scope-proof-desktop-${route}-${Date.now()}`,
  );
  try {
    const report = (await page.evaluate(
      (args) =>
        (
          globalThis as unknown as { orkestratorScopeProof: ScopeProofApi }
        ).orkestratorScopeProof.run(args),
      { leafNodeId: input.leafNodeId, leafEnvironmentId: environment.id, keepOpen: true },
    )) as ScopeProofReport;
    await page.waitForTimeout(QUIET_WINDOW_MS);
    // Electron main's own pid: `app.process()` may be the `electron` launcher script.
    const pid = await app.evaluate(() => process.pid);
    const ports = mainConnections(pid);
    const commandPort = new URL(input.command.origin).port;
    const leafPort = new URL(input.leaf.origin).port;
    const scopesWhileHeld = await page.evaluate(() =>
      (
        globalThis as unknown as { orkestratorScopeProof: ScopeProofApi }
      ).orkestratorScopeProof.scopes(),
    );
    const rendererOrigins = await page.evaluate(() => {
      const out: Record<string, string[]> = {};
      for (const entry of performance.getEntriesByType("resource") as PerformanceResourceTiming[]) {
        const origin = new URL(entry.name).origin;
        const list = (out[origin] ??= []);
        if (!list.includes(entry.nextHopProtocol)) list.push(entry.nextHopProtocol);
      }
      return out;
    });
    const requests = await app.evaluate(
      () => (globalThis as { __scopeProofRequests?: unknown }).__scopeProofRequests ?? null,
    );
    const openStreams = (await app.evaluate(
      () => (globalThis as { __scopeProofOpenStreams?: unknown }).__scopeProofOpenStreams ?? {},
    )) as Record<string, Record<string, number>>;
    const streamCount = (role: string) =>
      Object.values(openStreams[role] ?? {}).reduce((sum, count) => sum + count, 0);
    await page.evaluate(
      (nodeId) =>
        (
          globalThis as unknown as { orkestratorScopeProof: ScopeProofApi }
        ).orkestratorScopeProof.close(nodeId),
      input.leafNodeId,
    );
    const roleOf = (origin: string) =>
      origin === input.command.origin
        ? "command"
        : origin === input.leaf.origin
          ? "leaf"
          : "renderer-dev-server";
    writeEvidence(`desktop-${route}`, {
      host: "desktop",
      route,
      commandProfile,
      leafProfile,
      report: {
        ...report,
        route: report.route && {
          ...report.route,
          baseUrl: report.route.baseUrl && roleOf(new URL(report.route.baseUrl).origin),
        },
      },
      scopesWhileHeld,
      quietWindowMs: QUIET_WINDOW_MS,
      // Event streams main opened after the spec instrumented it (the command
      // connection's own stream predates that) and still had open.
      mainLongLivedRequestsPerOrigin: {
        command: { count: streamCount("command"), paths: openStreams.command ?? {} },
        leaf: { count: streamCount("leaf"), paths: openStreams.leaf ?? {} },
      },
      // TCP sockets, including idle keep-alive ones in Node's pool.
      mainEstablishedSocketsPerOrigin: {
        command: ports[commandPort] ?? 0,
        leaf: ports[leafPort] ?? 0,
      },
      mainRequestsPerOrigin: requests,
      rendererNextHopProtocolPerOrigin: Object.fromEntries(
        Object.entries(rendererOrigins).map(([origin, protocols]) => [roleOf(origin), protocols]),
      ),
      leafOriginRefusedInMain: input.relay,
    });
    expect(
      scopeProofFailures(report, {
        commandNodeId: input.commandNodeId,
        leafNodeId: input.leafNodeId,
        relayed: input.relay,
      }),
    ).toEqual([]);
    // The renderer never reaches a node origin itself: everything goes through main.
    expect(rendererOrigins[input.command.origin]).toBeUndefined();
    expect(rendererOrigins[input.leaf.origin]).toBeUndefined();
    if (input.relay) {
      // The leaf's stream goes through the command node; main holds none to the leaf.
      expect(streamCount("leaf")).toBe(0);
      expect(openStreams.command?.["/__orkestrator/nodes/<leaf>/__orkestrator/events"] ?? 0).toBe(
        1,
      );
    } else {
      expect(openStreams.leaf?.["/__orkestrator/events"] ?? 0).toBe(1);
    }
  } finally {
    await deleteLeafEnvironment(input.leaf, environment.id);
  }
}

test("one Electron renderer holds the command scope and a leaf scope (direct, then relay)", async () => {
  test.setTimeout(600_000);
  const command = gateway(commandProfile);
  const leaf = gateway(leafProfile);
  const { nodeId: leafNodeId } = await attachLeaf(command, leaf);
  const { nodeId: commandNodeId } = await command.invoke<{ nodeId: string }>("get_node_status");

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "scope-proof-electron-"));
  const [rendererPort, gatewayPort] = (await reserveLoopbackPorts(2)) as [number, number];
  const profile = resolveRuntimeProfile({
    repositoryRoot,
    requestedId: "scope-proof-electron",
    flavor: "agent-test",
    rendererPort,
    gatewayPort,
    roots: {
      developmentRoot: path.join(temporaryRoot, "dev"),
      productionDataDir: path.join(temporaryRoot, "production"),
      homeDir: temporaryRoot,
    },
  });
  const profilePath = await initializeProfile(profile);
  const rendererUrl = `http://127.0.0.1:${rendererPort}`;
  let vite: ChildProcess | null = null;
  let app: ElectronApplication | null = null;
  try {
    vite = spawn("bun", ["run", "dev"], {
      cwd: webRoot,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        VITE_DEV_HOST: "127.0.0.1",
        VITE_DEV_PORT: String(rendererPort),
        VITE_ORKESTRATOR_PROFILE: profile.id,
        VITE_ORKESTRATOR_PROFILE_FLAVOR: "agent-test",
      },
    });
    ownProcessGroup(vite);
    await expect
      .poll(
        async () =>
          fetch(rendererUrl)
            .then((r) => r.ok)
            .catch(() => false),
        { timeout: 60_000 },
      )
      .toBe(true);
    app = await electron.launch({
      executablePath: electronExecutable,
      args: [...ELECTRON_TEST_SWITCHES, path.join(packageRoot, "dist", "electron", "main.js")],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        ELECTRON_DEV: "1",
        VITE_DEV_SERVER_URL: rendererUrl,
        ORKESTRATOR_RUNTIME_PROFILE_FILE: profilePath,
        ORKESTRATOR_HOST_REACHABILITY_CHECK: "off",
        ORKESTRATOR_AGENT_TEST_HIDDEN_WINDOWS: "1",
        ORKESTRATOR_CONTROL_MCP_PORT: "0",
      },
    });
    const electronApp = app;
    dismissStartupDialogs(electronApp);
    const page = await electronApp.firstWindow();
    page.setDefaultTimeout(30_000);
    await expect(page).toHaveTitle(profile.electronTitle, { timeout: 90_000 });

    // The command node is the command profile's backend: a remote connection.
    // Its token goes only to the renderer's secure connection store, as a user's would.
    await page.evaluate(
      async ({ address, token }) => {
        const api = (
          globalThis as unknown as {
            orkestrator: { connections: { connect(input: object): Promise<unknown> } };
          }
        ).orkestrator;
        await api.connections.connect({ address, token, nickname: "Scope proof command node" });
      },
      { address: command.origin, token: command.secret() },
    );
    await expect
      .poll(
        async () => {
          const id = await page
            .evaluate(
              () =>
                (globalThis as { orkestratorDesktopIdentity?: { backendId?: string | null } })
                  .orkestratorDesktopIdentity?.backendId ?? null,
            )
            .catch(() => null);
          if (id !== commandNodeId) await page.reload().catch(() => undefined);
          return id;
        },
        { timeout: 90_000, intervals: [2_000] },
      )
      .toBe(commandNodeId);
    await harnessReady(page);

    // Count main's requests per origin (paths only), and keep every event
    // stream it opens from now on counted until its body ends, is cancelled or
    // aborted: those are its long-lived requests. Responses pass unchanged
    // except that an event stream's body is re-wrapped to see it end.
    await electronApp.evaluate(
      (_electron, origins) => {
        const main = globalThis as typeof globalThis & {
          __scopeProofRequests?: Record<string, Record<string, number>>;
          __scopeProofOpenStreams?: Record<string, Record<string, number>>;
          __scopeProofRefuse?: string | null;
        };
        main.__scopeProofRequests = {};
        main.__scopeProofOpenStreams = {};
        main.__scopeProofRefuse = null;
        const inner = globalThis.fetch;
        globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          const role =
            url.origin === origins.command
              ? "command"
              : url.origin === origins.leaf
                ? "leaf"
                : null;
          const key = url.pathname.replace(/\/nodes\/[^/]+/u, "/nodes/<leaf>");
          if (role) {
            const perRole = (main.__scopeProofRequests![role] ??= {});
            perRole[key] = (perRole[key] ?? 0) + 1;
          }
          if (main.__scopeProofRefuse && url.origin === main.__scopeProofRefuse) {
            return Promise.reject(new TypeError("fetch failed (refused by the scope-proof spec)"));
          }
          if (!role) return inner(input, init);
          return inner(input, init).then((response) => {
            const type = response.headers.get("content-type") ?? "";
            if (!response.body || !type.includes("text/event-stream")) return response;
            const open = (main.__scopeProofOpenStreams![role] ??= {});
            open[key] = (open[key] ?? 0) + 1;
            let ended = false;
            const end = () => {
              if (ended) return;
              ended = true;
              open[key] = (open[key] ?? 1) - 1;
            };
            init?.signal?.addEventListener("abort", end, { once: true });
            const source = response.body.getReader();
            const body = new ReadableStream<Uint8Array>({
              async pull(controller) {
                try {
                  const next = await source.read();
                  if (next.done) {
                    end();
                    controller.close();
                  } else controller.enqueue(next.value);
                } catch (error) {
                  end();
                  controller.error(error);
                }
              },
              cancel(reason) {
                end();
                return source.cancel(reason);
              },
            });
            return new Response(body, {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            });
          });
        }) as typeof fetch;
      },
      { command: command.origin, leaf: leaf.origin },
    );

    await proveRoute(electronApp, page, { command, leaf, commandNodeId, leafNodeId, relay: false });

    // Relay: main can no longer reach the leaf's own origin.
    await electronApp.evaluate((_electron, leafOrigin) => {
      (globalThis as { __scopeProofRefuse?: string | null }).__scopeProofRefuse = leafOrigin;
      (globalThis as { __scopeProofRequests?: object }).__scopeProofRequests = {};
    }, leaf.origin);
    await proveRoute(electronApp, page, { command, leaf, commandNodeId, leafNodeId, relay: true });
  } finally {
    await closeElectronWithin(app).catch(() => undefined);
    if (vite) await stopProcessGroup(vite).catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
