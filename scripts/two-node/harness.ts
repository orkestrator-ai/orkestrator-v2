/**
 * Processes and transport for the two-backend checks of this checkout
 * (`scripts/qa-remote-goal-hold.ts`).
 *
 * A {@link PeerNode} is one backend of this checkout (`apps/backend/src/main.ts`).
 * Every backend:
 *
 * - has its own temporary data directory, worktree directory and HOME;
 * - listens on loopback on a free port that is never one of
 *   {@link FORBIDDEN_PORTS} (the production gateway and Control MCP ports);
 * - gets a constructed environment ({@link backendEnvironment}): nothing
 *   `ORKESTRATOR_*` is inherited (so a host session's agent MCP variables or
 *   `ORKESTRATOR_VERSION` cannot leak in), no provider credential variable,
 *   a PATH of system directories plus Bun's and Git's only, and
 *   `ORKESTRATOR_HOST_REACHABILITY_CHECK=off`;
 * - runs as `--runtime-flavor agent-test`, so no agent outside a managed
 *   toolchain can start (there is none): no provider turn is possible;
 * - has a private random gateway token that is never printed.
 *
 * Only processes started here are signalled, through the handle recorded at
 * spawn time.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { devNull } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { ControlMcpInvoker } from "../../apps/backend/src/core/control-shared-actions.ts";
import { watchChild } from "./owned-process.ts";

export const ROOT = path.resolve(import.meta.dir, "..", "..");

/** The production gateway, its Control MCP, and the host session's MCP port. */
export const FORBIDDEN_PORTS: ReadonlySet<number> = new Set([34121, 34122, 45507]);

export class SetupError extends Error {}

export type Role = "command" | "leaf";

/** Environment variables a provider SDK or agent CLI reads credentials from. */
const CREDENTIAL_VARIABLE =
  /^(ANTHROPIC_|CLAUDE_|OPENAI_|CODEX_|GEMINI_|GOOGLE_|XAI_|GROK_|CURSOR_|OPENCODE_|OPENROUTER_|AWS_|AZURE_|GITHUB_|GH_|MISTRAL_|DEEPSEEK_|GROQ_|PI_)|(_API_KEY|_TOKEN|_SECRET)$/u;

/** Inherited variables a backend may see; everything else is dropped. */
const INHERITED = ["LANG", "LC_ALL", "LC_CTYPE", "TERM", "USER", "LOGNAME", "SHELL", "TZ"];

function directoryOf(executable: string): string | null {
  const found = Bun.which(executable);
  return found ? path.dirname(found) : null;
}

/**
 * A backend's whole environment, built rather than inherited. `base` is the
 * runner's own environment; only {@link INHERITED} names survive, and never a
 * credential-shaped one.
 */
export function backendEnvironment(
  base: Readonly<Record<string, string | undefined>>,
  node: { readonly home: string; readonly tmp: string; readonly token: string },
  pathDirectories: readonly string[] = [path.dirname(process.execPath), directoryOf("git")].filter(
    (entry): entry is string => entry !== null,
  ),
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED) {
    const value = base[name];
    if (value !== undefined && !CREDENTIAL_VARIABLE.test(name)) env[name] = value;
  }
  const system = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  return {
    ...env,
    PATH: [...new Set([...pathDirectories, ...system])].join(path.delimiter),
    HOME: node.home,
    XDG_CONFIG_HOME: path.join(node.home, ".config"),
    XDG_DATA_HOME: path.join(node.home, ".local", "share"),
    XDG_CACHE_HOME: path.join(node.home, ".cache"),
    TMPDIR: node.tmp,
    GIT_CONFIG_NOSYSTEM: "1",
    ORKESTRATOR_GATEWAY_TOKEN: node.token,
    ORKESTRATOR_HOST_REACHABILITY_CHECK: "off",
  };
}

/** A free loopback port that is none of {@link FORBIDDEN_PORTS}. */
export async function freePort(
  forbidden: ReadonlySet<number> = FORBIDDEN_PORTS,
  probe: () => Promise<number> = () => probeFixturePort(forbidden),
): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = await probe();
    if (port > 0 && !forbidden.has(port)) return port;
  }
  throw new SetupError("No free loopback port outside the forbidden set.");
}

function fixturePortCandidate(): number {
  return randomInt(49152, 65536);
}

function probeFixturePort(forbidden: ReadonlySet<number>): Promise<number> {
  const port = fixturePortCandidate();
  if (forbidden.has(port) || FORBIDDEN_PORTS.has(port)) return Promise.resolve(0);
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolve(0);
      else reject(error);
    });
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(port)));
  });
}

/** Run a setup command; a failure is a {@link SetupError} with its stderr. */
export function runSetup(
  command: string,
  args: readonly string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): string {
  const result = spawnSync(command, [...args], { cwd, env, encoding: "utf8" });
  if (result.status !== 0) {
    throw new SetupError(`${command} ${args.join(" ")}: ${(result.stderr ?? "").trim()}`);
  }
  return result.stdout;
}

/** Git fixtures must ignore the caller's repository, config and hook environment. */
export function fixtureGitEnvironment(root: string): NodeJS.ProcessEnv {
  return {
    PATH: [directoryOf("git"), "/usr/bin", "/bin"].filter(Boolean).join(path.delimiter),
    HOME: root,
    XDG_CONFIG_HOME: path.join(root, ".config"),
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

/** Bind an explicit port so a fixture listener never touches a reserved port. */
export function bindFixtureListener<T>(
  bind: (port: number) => T,
  candidate = fixturePortCandidate,
): T {
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = candidate();
    if (FORBIDDEN_PORTS.has(port)) continue;
    try {
      return bind(port);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    }
  }
  throw new SetupError("No available loopback port outside the forbidden set.");
}

export interface InvokeFailure {
  readonly status: number;
  readonly message: string;
}

export class InvokeError extends Error {
  constructor(
    readonly command: string,
    readonly failure: InvokeFailure,
  ) {
    super(`${command}: HTTP ${failure.status} ${failure.message}`);
  }
}

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as { message?: unknown; error?: unknown };
    if (typeof record.message === "string") return record.message;
    if (record.error !== undefined) return errorText(record.error);
  }
  return JSON.stringify(value ?? null);
}

/** One backend of this checkout in a two-node pair. */
export class PeerNode {
  child: ChildProcess | null = null;
  private process: ReturnType<typeof watchChild> | null = null;
  readonly output: string[] = [];
  /** `get_node_status().nodeId`, once started. */
  id = "";
  /** What `get_app_version` answered. */
  version = "";

  constructor(
    readonly name: string,
    readonly role: Role,
    readonly dir: string,
    readonly port: number,
    readonly token: string,
    private readonly sourceRoot = ROOT,
    private readonly abort?: AbortSignal,
  ) {}

  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get label(): string {
    return this.name;
  }

  async request(
    pathname: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<{ status: number; json: unknown }> {
    const timeout = AbortSignal.timeout(120_000);
    const response = await fetch(`${this.origin}${pathname}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: this.abort ? AbortSignal.any([timeout, this.abort]) : timeout,
    });
    const text = await response.text();
    try {
      return { status: response.status, json: JSON.parse(text) };
    } catch {
      return { status: response.status, json: text };
    }
  }

  async invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    const { status, json } = await this.request("/__orkestrator/invoke", {
      body: { command, args },
    });
    const payload = json as { result?: T; error?: unknown } | null;
    if (status !== 200) {
      throw new InvokeError(command, {
        status,
        message: errorText(payload?.error ?? payload).slice(0, 500),
      });
    }
    return payload?.result as T;
  }

  /** Start the backend and wait for it to answer. */
  async start(): Promise<void> {
    const home = path.join(this.dir, "home");
    const tmp = path.join(this.dir, "tmp");
    for (const directory of [home, tmp, path.join(this.dir, "data")]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
    }
    const args = [
      "--data-dir",
      path.join(this.dir, "data"),
      "--host",
      "127.0.0.1",
      "--allow-non-tailscale-bind",
      "--port",
      String(this.port),
      "--strict-gateway-port",
      "--control-port",
      String(await freePort()),
      "--runtime-flavor",
      "agent-test",
      "--worktree-dir",
      path.join(this.dir, "worktrees"),
      ...(this.role === "command" ? ["--command-node"] : []),
    ];
    this.abort?.throwIfAborted();
    const backend = path.join(this.sourceRoot, "apps", "backend");
    const child = spawn(process.execPath, [path.join(backend, "src", "main.ts"), ...args], {
      cwd: backend,
      env: backendEnvironment(process.env, { home, tmp, token: this.token }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const owned = watchChild(child);
    this.process = owned;
    this.child = child;
    child.stdout!.on("data", (chunk: Buffer) => this.output.push(chunk.toString()));
    child.stderr!.on("data", (chunk: Buffer) => this.output.push(chunk.toString()));
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      this.abort?.throwIfAborted();
      if (
        owned.failure() ||
        owned.closed() ||
        child.exitCode !== null ||
        child.signalCode !== null
      ) {
        throw new SetupError(
          `${this.label} exited early (${child.exitCode ?? child.signalCode}): ${
            this.output.join("").match(/\w*Error: [^\n]*/u)?.[0] ?? "no error line"
          }`,
        );
      }
      try {
        this.version = await this.invoke<string>("get_app_version");
        this.id = (await this.invoke<{ nodeId: string }>("get_node_status")).nodeId;
        return;
      } catch {
        await delay(500, undefined, { signal: this.abort });
      }
    }
    throw new SetupError(`${this.label} did not answer within 120 s.`);
  }

  async stop(): Promise<void> {
    await this.process?.stop(15_000);
    this.process = null;
    this.child = null;
  }
}

/** A new node with its own directory, port and token. */
export async function makeNode(input: {
  name: string;
  role: Role;
  root: string;
  sourceRoot?: string;
  signal?: AbortSignal;
}): Promise<PeerNode> {
  const dir = await mkdtemp(path.join(input.root, `${input.name.toLowerCase()}-`));
  return new PeerNode(
    input.name,
    input.role,
    dir,
    await freePort(),
    randomBytes(24).toString("base64url"),
    input.sourceRoot,
    input.signal,
  );
}

/** Poll `read` until `ok` holds, or throw naming `label`. */
export async function until<T>(
  label: string,
  read: () => Promise<T>,
  ok: (value: T) => boolean,
  ms = 60_000,
  signal?: AbortSignal,
): Promise<T> {
  const deadline = Date.now() + ms;
  let last: T | undefined;
  let lastError = "";
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try {
      last = await read();
      if (ok(last)) return last;
    } catch (error) {
      lastError = String(error).slice(0, 200);
    }
    await delay(500, undefined, { signal });
  }
  throw new Error(
    `Timed out waiting for ${label}: ${JSON.stringify(last)?.slice(0, 300) ?? lastError}`,
  );
}

/** Each node whose output contains another node's (or its own) gateway token. */
export function tokenLeaks(nodes: readonly PeerNode[]): string[] {
  return nodes
    .filter((node) => nodes.some((owner) => node.output.join("").includes(owner.token)))
    .map((node) => node.label);
}

/** The Web platform the invoker uses; a test under Happy DOM passes Bun's own. */
export interface InvokerPlatform {
  readonly fetch: typeof fetch;
  readonly AbortSignal: typeof AbortSignal;
}

/**
 * A Control MCP invoker over `node`'s gateway with the caller's signal: what
 * the Control MCP server's invoker does in process, so production code that
 * takes an invoker (`NodeCoordinatorRemote`) reads a real node.
 */
export function gatewayInvoker(
  node: Pick<PeerNode, "origin" | "token">,
  platform: InvokerPlatform = { fetch: globalThis.fetch, AbortSignal: globalThis.AbortSignal },
): ControlMcpInvoker {
  return async <T>(
    command: string,
    args: Record<string, unknown> = {},
    options?: { signal?: AbortSignal },
  ): Promise<T> => {
    const timeout = platform.AbortSignal.timeout(120_000);
    const signal = options?.signal ? platform.AbortSignal.any([options.signal, timeout]) : timeout;
    const response = await platform.fetch(`${node.origin}/__orkestrator/invoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${node.token}`, "content-type": "application/json" },
      body: JSON.stringify({ command, args }),
      signal,
    });
    const text = await response.text();
    let payload: { result?: T; error?: unknown } | null = null;
    try {
      payload = JSON.parse(text) as { result?: T; error?: unknown };
    } catch {
      payload = null;
    }
    if (response.status !== 200) {
      const error = payload?.error;
      const message =
        typeof error === "string"
          ? error
          : typeof (error as { message?: unknown } | null)?.message === "string"
            ? (error as { message: string }).message
            : text;
      throw new InvokeError(command, { status: response.status, message: message.slice(0, 500) });
    }
    return payload?.result as T;
  };
}
