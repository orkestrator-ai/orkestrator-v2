/**
 * Live check: how fast a Codex bridge stops after the backend that spawned it
 * dies mid-turn, and what the next bridge reports for that turn
 * (docs/todo/transcripts-and-observation/0050-transcript-history-efficiency.md,
 * Code item 6).
 *
 * A `sleep` process stands in for the backend (`ORKESTRATOR_PARENT_PID`). The
 * script starts a real bridge and app-server on a throwaway `CODEX_HOME`
 * holding a copy of `~/.codex/auth.json`, prompts a turn that runs a 90 s
 * shell script, SIGKILLs the stand-in, and times when the bridge notices, when
 * the bridge, app-server and the agent's command are gone, and what the
 * rollout and dispatch journal hold. It then starts a second bridge on the same
 * state, as a restarted backend would, and reads the session's status.
 *
 * Uses a real Codex account (one short turn). Prints and writes only timings,
 * counts and states; the temporary home is deleted afterwards.
 *
 *   bun scripts/codex-parent-exit-live.ts --codex <binary> [--root <repo>] [--out <file>]
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

interface Options {
  root: string;
  codex: string;
  out?: string;
}

function parseArgs(argv: string[]): Options {
  const options: Partial<Options> = { root: resolve(import.meta.dir, "..") };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1];
    if (argv[index] === "--root" && value) options.root = resolve(value);
    else if (argv[index] === "--codex" && value) options.codex = resolve(value);
    else if (argv[index] === "--out" && value) options.out = resolve(value);
    else continue;
    index += 1;
  }
  if (!options.codex) throw new Error("--codex <path to the pinned codex binary> is required");
  return options as Options;
}

function isAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function descendants(pid: number): number[] {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid="])
    .toString()
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number));
  const found: number[] = [];
  const queue = [pid];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const [child, ppid] of rows) {
      if (ppid === parent && child !== undefined) {
        found.push(child);
        queue.push(child);
      }
    }
  }
  return found;
}

function commandOf(pid: number): string {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)]).toString();
  } catch {
    return "";
  }
}

function listJsonl(dir: string): string[] {
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(".jsonl")) files.push(path);
    }
  };
  try {
    walk(dir);
  } catch {
    // No rollout yet.
  }
  return files;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const home = mkdtempSync(join(tmpdir(), "codex-parent-exit-"));
  chmodSync(home, 0o700);
  const codexHome = join(home, "codex-home");
  const workspace = join(home, "workspace");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  copyFileSync(join(homedir(), ".codex", "auth.json"), join(codexHome, "auth.json"));
  chmodSync(join(codexHome, "auth.json"), 0o600);
  writeFileSync(join(workspace, "wait.sh"), "#!/bin/sh\nsleep 90\necho finished\n");
  chmodSync(join(workspace, "wait.sh"), 0o755);

  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const token = randomBytes(24).toString("base64url");
  const base = `http://127.0.0.1:${port}`;
  const bridgeEnv = {
    ...process.env,
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    CODEX_PATH: options.codex,
    CODEX_HOME: codexHome,
    CWD: workspace,
    CODEX_BRIDGE_TOKEN: token,
  };
  const request = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, json: (await response.json().catch(() => null)) as any };
  };
  const waitReady = async (): Promise<void> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        if ((await request("GET", "/session/list")).status === 200) return;
      } catch {
        // Not listening yet.
      }
      await delay(100);
    }
    throw new Error("bridge did not start");
  };
  const startBridge = (extraEnv: Record<string, string>): ChildProcess =>
    spawn("bun", [join(options.root, "bridges/codex-bridge/src/index.ts")], {
      cwd: workspace,
      env: { ...bridgeEnv, ...extraEnv },
      stdio: ["ignore", "ignore", "pipe"],
      detached: true,
    });

  const parent = spawn("sleep", ["600"], { detached: true, stdio: "ignore" });
  const bridge = startBridge({ ORKESTRATOR_PARENT_PID: String(parent.pid) });
  let stderr = "";
  bridge.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  let restarted: ChildProcess | undefined;
  const result: Record<string, unknown> = { root: options.root };
  try {
    await waitReady();
    const created = await request("POST", "/session/create", { mode: "build" });
    const sessionId: string = created.json.sessionId ?? created.json.id;
    const prompted = await request("POST", `/session/${sessionId}/prompt`, {
      prompt:
        "Run the shell command `./wait.sh` in the current directory exactly once and wait for it to finish, then reply with the single word done.",
      requestId: randomUUID(),
    });
    result.promptStatus = prompted.status;

    let agentCommands: number[] = [];
    for (let attempt = 0; attempt < 600 && agentCommands.length === 0; attempt += 1) {
      agentCommands = descendants(bridge.pid!).filter((pid) => commandOf(pid).includes("wait.sh"));
      await delay(100);
    }
    result.agentCommandRunning = agentCommands.length > 0;
    await delay(1_000);
    const tree = descendants(bridge.pid!);
    const appServers = tree.filter((pid) => commandOf(pid).includes("app-server"));
    const agentProcesses = tree.filter((pid) => !appServers.includes(pid));

    const killedAt = performance.now();
    process.kill(parent.pid!, "SIGKILL");
    const marks: Record<string, number | undefined> = {};
    const mark = (name: string, done: boolean): void => {
      if (done && marks[name] === undefined) marks[name] = Math.round(performance.now() - killedAt);
    };
    while (performance.now() - killedAt < 40_000) {
      mark("detectedMs", stderr.includes("is gone; shutting down"));
      mark("bridgeGoneMs", !isAlive(bridge.pid));
      mark(
        "appServerGoneMs",
        appServers.every((pid) => !isAlive(pid)),
      );
      mark(
        "agentProcessesGoneMs",
        agentProcesses.every((pid) => !isAlive(pid)),
      );
      if (Object.keys(marks).length === 4) break;
      await delay(25);
    }
    Object.assign(result, marks, {
      appServers: appServers.length,
      agentProcesses: agentProcesses.length,
      interruptLine: stderr
        .split("\n")
        .find((line) => line.includes("running turn(s)"))
        ?.replace(/^.*\] /, ""),
    });

    const turnEvents = listJsonl(join(codexHome, "sessions")).flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            const record = JSON.parse(line);
            return record.type === "event_msg" ? String(record.payload?.type) : "";
          } catch {
            return "";
          }
        })
        .filter((type) => /^(task_|turn_)/.test(type)),
    );
    result.rolloutTurnEvents = turnEvents;
    const store = join(codexHome, "orkestrator-bridge");
    const journalFile = readdirSync(store).find((name) => name.startsWith("dispatch-journal"));
    if (journalFile) {
      const journal = JSON.parse(readFileSync(join(store, journalFile), "utf8"));
      result.journalStates = Object.values(journal.records ?? journal).map(
        (record: any) => record.terminalStatus ?? record.state,
      );
    }

    // The next backend starts a bridge on the same state.
    restarted = startBridge({});
    await waitReady();
    let status: any;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      status = (await request("GET", `/session/${sessionId}/status`)).json;
      if (status && status.phase !== "recovering") break;
      await delay(200);
    }
    result.afterRestart = {
      phase: status?.phase,
      status: status?.status,
      interruption: status?.interruption,
    };
  } finally {
    for (const child of [bridge, restarted, parent]) {
      try {
        if (child?.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    rmSync(home, { recursive: true, force: true });
  }
  const json = JSON.stringify(result, null, 2);
  if (options.out) writeFileSync(options.out, `${json}\n`);
  console.log(json);
}

await main();
process.exit(0);
