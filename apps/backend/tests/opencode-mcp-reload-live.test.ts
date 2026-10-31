/**
 * What MCP apply's in-place OpenCode reload relies on, proven on the real
 * pinned `opencode serve` with no credentials (no model is called).
 *
 * Opt-in: RUN_LIVE_OPENCODE_MCP=1, with the pinned binary installed by the
 * toolchain (or OPENCODE_CLI_PATH pointing at one):
 *
 *   RUN_LIVE_OPENCODE_MCP=1 bun test ./tests/opencode-mcp-reload-live.test.ts
 *
 * Everything runs in a temporary home, XDG directories and project; the
 * operator's OpenCode configuration and data are never read or written. The
 * MCP server is the dependency-free probe server the live apply spec uses.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { PINNED_TOOLCHAIN_VERSIONS } from "../../../packages/toolchain/src/manifest";

const ENABLED = process.env.RUN_LIVE_OPENCODE_MCP === "1";
const PROBE = path.resolve(import.meta.dir, "../../../e2e/agent-testing/mcp-probe-server.mjs");

function pinnedBinary(): string {
  if (process.env.OPENCODE_CLI_PATH) return process.env.OPENCODE_CLI_PATH;
  const platform = `${process.platform}-${process.arch}`;
  const dataDir =
    process.platform === "darwin"
      ? path.join(homedir(), "Library", "Application Support", "orkestrator-v2")
      : path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"), "orkestrator-v2");
  return path.join(
    dataDir,
    "toolchains",
    "opencode",
    PINNED_TOOLCHAIN_VERSIONS.opencode,
    platform,
    "opencode",
  );
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const roots: string[] = [];
const children: ChildProcess[] = [];
const probeLogs: string[] = [];
afterAll(async () => {
  // `opencode serve` can outlive SIGTERM while its MCP children run, so
  // stop it hard, then every probe process the logs recorded.
  for (const child of children) child.kill("SIGTERM");
  await Bun.sleep(500);
  for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
  for (const log of probeLogs) {
    for (const line of readFileSync(log, "utf8").split("\n").filter(Boolean)) {
      const { event, pid } = JSON.parse(line) as { event: string; pid: number };
      if (event === "start" && isAlive(pid)) process.kill(pid, "SIGKILL");
    }
  }
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface LiveServer {
  dirs: Record<"home" | "config" | "data" | "cache" | "state" | "project", string>;
  log: string;
  server: (label: string, tag: string) => { type: string; command: string[] };
  call: (method: "GET" | "POST", route: string, body?: unknown) => Promise<unknown>;
  status: () => Promise<string[]>;
}

/** `opencode serve` in throwaway homes, with `write` run before it starts. */
async function startServer(
  write: (server: LiveServer) => void,
  ready: string,
): Promise<LiveServer> {
  const binary = pinnedBinary();
  expect(existsSync(binary), `pinned OpenCode binary at ${binary}`).toBe(true);
  const root = mkdtempSync(path.join(tmpdir(), "opencode-mcp-reload-"));
  roots.push(root);
  const dirs = Object.fromEntries(
    ["home", "config", "data", "cache", "state", "project"].map((name) => {
      const dir = path.join(root, name);
      mkdirSync(dir, { recursive: true });
      return [name, dir];
    }),
  ) as LiveServer["dirs"];
  const log = path.join(root, "probe.jsonl");
  writeFileSync(log, "");
  probeLogs.push(log);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const query = `directory=${encodeURIComponent(dirs.project)}`;
  const live: LiveServer = {
    dirs,
    log,
    server: (label, tag) => ({
      type: "local",
      command: [process.execPath, PROBE, "--label", label, "--tag", tag, "--log", log],
    }),
    call: async (method, route, body) => {
      // A request that reaches the server while its first instance boots can
      // hang (seen on 1.19.4 and 1.19.5), so every call is bounded and the
      // readiness loop below simply asks again.
      const response = await fetch(`${base}${route}?${query}`, {
        signal: AbortSignal.timeout(15_000),
        method,
        ...(body ? { headers: { "content-type": "application/json" } } : {}),
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      expect(response.ok, `${method} ${route}`).toBe(true);
      return response.json() as Promise<unknown>;
    },
    status: async () => Object.keys((await live.call("GET", "/mcp")) as object).sort(),
  };
  write(live);
  const child = spawn(binary, ["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
    cwd: dirs.project,
    env: {
      PATH: process.env.PATH,
      HOME: dirs.home,
      XDG_CONFIG_HOME: dirs.config,
      XDG_DATA_HOME: dirs.data,
      XDG_CACHE_HOME: dirs.cache,
      XDG_STATE_HOME: dirs.state,
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_SHARE: "1",
    },
    stdio: "ignore",
  });
  children.push(child);
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      if ((await live.status()).includes(ready)) return live;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error("opencode serve did not come up");
    await Bun.sleep(250);
  }
}

describe.skipIf(!ENABLED)("OpenCode MCP reload on the pinned binary", () => {
  test("instance.dispose reloads a project MCP file, drops runtime-added servers and keeps sessions", async () => {
    const writeConfig = (live: LiveServer, mcp: Record<string, unknown>) =>
      writeFileSync(path.join(live.dirs.project, "opencode.json"), JSON.stringify({ mcp }));
    const live = await startServer(
      (server) => writeConfig(server, { alpha: server.server("alpha", "v1") }),
      "alpha",
    );
    const { call, status } = live;

    // What Orkestrator's `orkestrator` entry is: added at runtime, not saved.
    await call("POST", "/mcp", { name: "injected", config: live.server("injected", "rt") });
    const session = (await call("POST", "/session", { title: "kept" })) as { id: string };
    expect(await status()).toEqual(["alpha", "injected"]);

    // A saved rename does not reach the running instance on its own.
    writeConfig(live, { beta: live.server("beta", "v2") });
    await Bun.sleep(500);
    expect(await status()).toEqual(["alpha", "injected"]);

    // The apply path: dispose the directory's instance; the next request
    // rebuilds it from the saved files.
    expect(await call("POST", "/instance/dispose")).toBe(true);
    expect(await status()).toEqual(["beta"]);
    await Bun.sleep(1_000);

    const events = readFileSync(live.log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event: string; label: string; pid: number });
    const started = (label: string) =>
      events.filter((event) => event.event === "start" && event.label === label);
    // The old server's process is gone, not left running beside the new one.
    expect(started("alpha").every((event) => !isAlive(event.pid))).toBe(true);
    // The runtime-only entry went with the instance: apply must add it again.
    expect(started("injected").every((event) => !isAlive(event.pid))).toBe(true);
    expect(started("beta").some((event) => isAlive(event.pid))).toBe(true);
    // Conversations are stored, not instance state.
    const sessions = (await call("GET", "/session")) as Array<{ id: string }>;
    expect(sessions.map((entry) => entry.id)).toContain(session.id);
  }, 90_000);

  // Why apply keeps `restart-required` for the user files. If this starts
  // failing because `ubeta` is listed, OpenCode now reloads its user config
  // with the instance: plan `opencode:user-*` sources for the reload too.
  test("the user config folder is cached for the server's lifetime", async () => {
    const writeUser = (live: LiveServer, mcp: Record<string, unknown>) => {
      mkdirSync(path.join(live.dirs.config, "opencode"), { recursive: true });
      writeFileSync(
        path.join(live.dirs.config, "opencode", "opencode.json"),
        JSON.stringify({ mcp }),
      );
    };
    const live = await startServer(
      (server) => writeUser(server, { ualpha: server.server("ualpha", "v1") }),
      "ualpha",
    );
    writeUser(live, { ubeta: live.server("ubeta", "v2") });
    expect(await live.call("POST", "/instance/dispose")).toBe(true);
    expect(await live.status()).toEqual(["ualpha"]);
    expect(await live.call("POST", "/global/dispose")).toBe(true);
    expect(await live.status()).toEqual(["ualpha"]);
  }, 90_000);
});
