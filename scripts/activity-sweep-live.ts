/**
 * Live check: latency of the backend's activity sweep against real bridge
 * processes (docs/todo/transcripts-and-observation/0050-transcript-history-efficiency.md,
 * qualification "Activity-sweep p50/p95 for 1, 10 and 100 sessions").
 *
 * For each bridge (Codex and Claude) the script starts a real bridge process
 * on loopback with a throwaway home, creates 100 sessions (no prompt is ever
 * sent, so no provider tokens are spent), and drives the backend's own sweep
 * client — `createNativeAgentProvider` plus `readActivityGroup`, exactly as the
 * activity sweep calls them — over HTTP for groups of 1, 10 and 100 sessions.
 * Each size gets a warm-up, then `--sweeps` timed sweeps. A second pass
 * answers the batch route 404 in front of the real bridge, which is how the
 * provider meets an older bridge, so the per-session fallback is timed against
 * the same process.
 *
 * Codex runs its pinned app-server (`--codex`) on a temporary `CODEX_HOME`
 * holding a copy of `~/.codex/auth.json`; Claude runs with a temporary `HOME`
 * and `CLAUDE_CONFIG_DIR`. Output is timings, counts and states only; every
 * temporary directory is deleted and only processes this script started are
 * signalled.
 *
 *   bun scripts/activity-sweep-live.ts --codex <binary> [--sweeps 50] [--warmup 5] [--out <file>]
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cpus, homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readActivityGroup } from "../apps/backend/src/core/native-agent-activity-reads";
import { createNativeAgentProvider } from "../apps/backend/src/core/native-agent-provider";
import { SESSION_ACTIVITY_BATCH_PATH } from "../packages/protocol/src/session-activity-batch";

type BridgeKind = "codex" | "claude";

interface Options {
  root: string;
  codex: string;
  sweeps: number;
  warmup: number;
  out?: string;
}

const SIZES = [1, 10, 100] as const;

function parseArgs(argv: string[]): Options {
  const options: Partial<Options> = {
    root: resolve(import.meta.dir, ".."),
    sweeps: 50,
    warmup: 5,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1];
    if (argv[index] === "--root" && value) options.root = resolve(value);
    else if (argv[index] === "--codex" && value) options.codex = resolve(value);
    else if (argv[index] === "--sweeps" && value) options.sweeps = Number(value);
    else if (argv[index] === "--warmup" && value) options.warmup = Number(value);
    else if (argv[index] === "--out" && value) options.out = resolve(value);
    else continue;
    index += 1;
  }
  if (!options.codex) throw new Error("--codex <path to the pinned codex binary> is required");
  return options as Options;
}

function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

const round = (value: number) => Math.round(value * 100) / 100;

function summarize(samples: number[]): { p50Ms: number; p95Ms: number; maxMs: number } {
  return {
    p50Ms: round(quantile(samples, 0.5)),
    p95Ms: round(quantile(samples, 0.95)),
    maxMs: round(Math.max(...samples)),
  };
}

interface RunningBridge {
  kind: BridgeKind;
  child: ChildProcess;
  baseUrl: string;
  token: string;
  home: string;
}

async function startBridge(kind: BridgeKind, options: Options): Promise<RunningBridge> {
  const home = mkdtempSync(join(tmpdir(), `activity-sweep-${kind}-`));
  chmodSync(home, 0o700);
  const workspace = join(home, "workspace");
  mkdirSync(workspace, { recursive: true });
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const token = randomBytes(24).toString("base64url");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    CWD: workspace,
  };
  // An inherited parent PID would tie the bridge to whoever ran this script.
  delete env.ORKESTRATOR_PARENT_PID;
  let entry: string;
  if (kind === "codex") {
    const codexHome = join(home, "codex-home");
    mkdirSync(codexHome, { recursive: true });
    copyFileSync(join(homedir(), ".codex", "auth.json"), join(codexHome, "auth.json"));
    chmodSync(join(codexHome, "auth.json"), 0o600);
    Object.assign(env, {
      CODEX_PATH: options.codex,
      CODEX_HOME: codexHome,
      CODEX_BRIDGE_TOKEN: token,
    });
    entry = "bridges/codex-bridge/src/index.ts";
  } else {
    const userHome = join(home, "user-home");
    mkdirSync(join(userHome, ".claude"), { recursive: true });
    Object.assign(env, {
      HOME: userHome,
      CLAUDE_CONFIG_DIR: join(userHome, ".claude"),
      CLAUDE_BRIDGE_TOKEN: token,
    });
    entry = "bridges/claude-bridge/src/index.ts";
  }
  const child = spawn("bun", [join(options.root, entry)], {
    cwd: workspace,
    env,
    stdio: "ignore",
    detached: true,
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/session/list`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (response.status === 200) return { kind, child, baseUrl, token, home };
    } catch {
      // Not listening yet.
    }
    await delay(100);
  }
  stopBridge({ kind, child, baseUrl, token, home });
  throw new Error(`${kind} bridge did not start`);
}

function stopBridge(bridge: RunningBridge): void {
  try {
    if (bridge.child.pid) process.kill(-bridge.child.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
}

async function createSessions(bridge: RunningBridge, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const response = await fetch(`${bridge.baseUrl}/session/create`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: JSON.stringify(bridge.kind === "codex" ? { mode: "build" } : {}),
    });
    const body = (await response.json()) as { sessionId?: string; id?: string };
    const id = body.sessionId ?? body.id;
    if (response.status >= 300 || !id)
      throw new Error(`session create failed (${response.status})`);
    ids.push(id);
  }
  return ids;
}

async function measure(
  bridge: RunningBridge,
  sessionIds: readonly string[],
  options: Options,
  batchRoute: boolean,
): Promise<Record<string, unknown>> {
  const counters = { requests: 0, batchRequests: 0, singleRequests: 0 };
  const states = new Map<string, number>();
  const countingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    counters.requests += 1;
    if (url.pathname === SESSION_ACTIVITY_BATCH_PATH) {
      counters.batchRequests += 1;
      // How the provider meets a bridge that predates the batch route.
      if (!batchRoute) return new Response("Not found", { status: 404 });
    } else if (/^\/session\/[^/]+\/activity$/.test(url.pathname)) {
      counters.singleRequests += 1;
    }
    return fetch(input, init);
  }) as typeof fetch;
  const provider = createNativeAgentProvider(
    {
      agent: bridge.kind,
      baseUrl: bridge.baseUrl,
      authToken: bridge.token,
      requestTimeoutMs: 10_000,
    },
    { fetch: countingFetch },
  );
  const group = sessionIds.map((providerSessionId) => ({ providerSessionId }));
  const sweep = () =>
    readActivityGroup({
      provider,
      sessions: group,
      apply: async (_session, read) => {
        states.set(String(read.state), (states.get(String(read.state)) ?? 0) + 1);
      },
    });
  for (let pass = 0; pass < options.warmup; pass += 1) await sweep();
  const before = { ...counters };
  states.clear();
  const samples: number[] = [];
  for (let pass = 0; pass < options.sweeps; pass += 1) {
    const startedAt = performance.now();
    await sweep();
    samples.push(performance.now() - startedAt);
  }
  return {
    sessions: sessionIds.length,
    route: batchRoute ? "batch" : "single (batch route answered 404)",
    sweeps: options.sweeps,
    ...summarize(samples),
    requestsPerSweep: (counters.requests - before.requests) / options.sweeps,
    batchRequestsPerSweep: (counters.batchRequests - before.batchRequests) / options.sweeps,
    singleRequestsPerSweep: (counters.singleRequests - before.singleRequests) / options.sweeps,
    statesPerSweep: Object.fromEntries(
      [...states].map(([state, count]) => [state, count / options.sweeps]),
    ),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const machine = (() => {
    try {
      return execFileSync("sysctl", ["-n", "hw.model"]).toString().trim();
    } catch {
      return "unknown";
    }
  })();
  const report: Record<string, unknown> = {
    machine,
    cpu: cpus()[0]?.model,
    cores: cpus().length,
    bun: Bun.version,
    sweeps: options.sweeps,
    warmup: options.warmup,
    bridges: {},
  };
  for (const kind of ["codex", "claude"] as const) {
    const bridge = await startBridge(kind, options);
    try {
      const sessionIds = await createSessions(bridge, Math.max(...SIZES));
      const cases: Record<string, unknown>[] = [];
      for (const size of SIZES) {
        cases.push(await measure(bridge, sessionIds.slice(0, size), options, true));
      }
      cases.push(await measure(bridge, sessionIds.slice(0, 10), options, false));
      (report.bridges as Record<string, unknown>)[kind] = cases;
    } finally {
      stopBridge(bridge);
      await delay(500);
      try {
        if (bridge.child.pid) process.kill(-bridge.child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      rmSync(bridge.home, { recursive: true, force: true });
    }
  }
  const json = JSON.stringify(report, null, 2);
  if (options.out) writeFileSync(options.out, `${json}\n`);
  console.log(json);
}

await main();
process.exit(0);
