/**
 * Shared harness for the real-stack command-node QA scripts
 * (`qa-command-nodes.ts`, `qa-coordinator-image-mail.ts`).
 *
 * Each backend runs from source with a temporary data directory, a loopback
 * listener on an ephemeral port (never the fixed 34121/34122) and a private
 * random gateway token that is never printed. Only processes started here are
 * ever signalled, through the handle recorded at spawn time.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { DEFAULT_CONTROL_MCP_PORT, DEFAULT_GATEWAY_PORT } from "../apps/backend/src/fixed-ports.js";

const repo = path.resolve(import.meta.dir, "..");

/** Every backend these scripts started, for the last-resort kill on a crash. */
export const children: ChildProcess[] = [];

export interface QaRun {
  check(id: string, description: string, ok: boolean, detail?: string): void;
  results: Array<{ id: string; check: string; ok: boolean }>;
  log(...args: unknown[]): void;
}

/** Assertions that print `PASS`/`FAIL` lines under one prefix and stop at the first failure. */
export function qaRun(prefix: string): QaRun {
  const results: QaRun["results"] = [];
  const log = (...args: unknown[]) => console.log(`[${prefix}]`, ...args);
  return {
    results,
    log,
    check(id, description, ok, detail = "") {
      results.push({ id, check: description, ok });
      log(`${ok ? "PASS" : "FAIL"} ${id} ${description}${ok || !detail ? "" : ` (${detail})`}`);
      if (!ok) throw new Error(`QA assertion failed: ${id} ${description}`);
    },
  };
}

async function freePort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
      });
    });
    if (port !== DEFAULT_GATEWAY_PORT && port !== DEFAULT_CONTROL_MCP_PORT) return port;
  }
}

export type Node = {
  name: string;
  dir: string;
  token: string;
  port: number;
  commandNode: boolean;
  child?: ChildProcess;
  output: string[];
  id?: string;
};

export async function makeNode(name: string, commandNode: boolean): Promise<Node> {
  return {
    name,
    dir: await mkdtemp(path.join(tmpdir(), `ork-cn-qa-${name.toLowerCase()}-`)),
    token: randomBytes(24).toString("base64url"),
    port: await freePort(),
    commandNode,
    output: [],
  };
}

/**
 * Start a backend. `isolateHome` points `HOME` (and so every agent CLI's
 * credential lookup) at the node's temporary directory, for scripts that open
 * agent tabs and must make no provider request even by accident.
 */
export function start(node: Node, options: { isolateHome?: boolean } = {}): Promise<void> {
  const args = [
    "apps/backend/src/main.ts",
    "--data-dir",
    path.join(node.dir, "data"),
    "--host",
    "127.0.0.1",
    "--allow-non-tailscale-bind",
    "--port",
    String(node.port),
    "--strict-gateway-port",
    "--runtime-flavor",
    "agent-test",
    "--worktree-dir",
    path.join(node.dir, "worktrees"),
    ...(node.commandNode ? ["--command-node"] : []),
  ];
  const child = spawn("bun", args, {
    cwd: repo,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ...(options.isolateHome
        ? { HOME: node.dir, XDG_CONFIG_HOME: path.join(node.dir, "xdg-config") }
        : {}),
      ORKESTRATOR_GATEWAY_TOKEN: node.token,
      ORKESTRATOR_CONTROL_MCP_PORT: "0",
    },
  });
  node.child = child;
  children.push(child);
  child.stderr?.on("data", (chunk: Buffer) => node.output.push(chunk.toString()));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${node.name} did not start`)), 90_000);
    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      node.output.push(text);
      buffer += text;
      for (const line of buffer.split("\n").slice(0, -1)) {
        if (line.includes('"orkestrator-backend-ready"')) {
          clearTimeout(timer);
          resolve();
        }
      }
      buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${node.name} exited early (${code})`));
    });
  });
}

export async function stop(node: Node): Promise<void> {
  const child = node.child;
  if (!child || child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  await exited;
  clearTimeout(timer);
}

export const origin = (node: Node) => `http://127.0.0.1:${node.port}`;

export async function request(
  node: Node,
  pathname: string,
  init: { method?: string; body?: unknown; token?: string | null } = {},
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${origin(node)}${pathname}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: {
      ...(init.token === null ? {} : { authorization: `Bearer ${init.token ?? node.token}` }),
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: response.status, json };
}

export async function invoke<T>(
  node: Node,
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const { status, json } = await request(node, "/__orkestrator/invoke", {
    body: { command, args },
  });
  const payload = json as { result?: T; error?: string };
  if (status !== 200) throw new Error(`${node.name} ${command}: ${payload?.error ?? status}`);
  return payload.result as T;
}

/** The error a command answers with, or "" when it succeeded. */
export async function refusal(
  node: Node,
  command: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  try {
    await invoke(node, command, args);
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export async function until<T>(
  label: string,
  read: () => Promise<T>,
  ok: (value: T) => boolean,
  ms = 60_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  let last: T | undefined;
  while (Date.now() < deadline) {
    try {
      last = await read();
      if (ok(last)) return last;
    } catch {
      // Not yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(last)?.slice(0, 300)}`);
}

export function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "ignore" });
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${code}`)),
    );
  });
}

export async function project(
  node: Node,
  files: Record<string, string>,
): Promise<{ id: string; dir: string }> {
  const dir = path.join(node.dir, "repos", "site");
  await mkdir(dir, { recursive: true });
  await run("git", ["init", "-q", "-b", "main"], dir);
  await run(
    "git",
    [
      "-c",
      "user.email=qa@example.com",
      "-c",
      "user.name=QA",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    ],
    dir,
  );
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), content);
  }
  const created = await invoke<{ id: string }>(node, "add_project", {
    gitUrl: "https://github.com/acme/site.git",
    localPath: dir,
  });
  return { id: created.id, dir };
}

export async function addNode(command: Node, target: Node) {
  return invoke<{ nodeId: string; connection: { state: string; remoteMode?: string } }>(
    command,
    "add_node",
    {
      routes: [{ id: "loopback", kind: "https", enabled: true, origin: origin(target) }],
      token: target.token,
      displayName: target.name,
    },
  );
}
