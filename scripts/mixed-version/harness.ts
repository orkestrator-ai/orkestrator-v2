/**
 * Processes and transport for the mixed-version qualification runner
 * (`scripts/qualify-contract-mixed-versions.ts`, plan item 1012).
 *
 * A {@link PeerNode} is one backend: this checkout's (`apps/backend/src/main.ts`)
 * or a published `orkestrator` npm release installed with `--ignore-scripts`
 * into the run's private directory ({@link installRelease}). Every backend:
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
 * spawn time. A node can also be {@link attachedNode} (an already running
 * backend, e.g. a `dev:test` profile), which is never started or stopped.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dir, "..", "..");

/** The production gateway, its Control MCP, and the host session's MCP port. */
export const FORBIDDEN_PORTS: ReadonlySet<number> = new Set([34121, 34122, 45507]);

export class SetupError extends Error {}

/** Which code a node runs. */
export type Build =
  | { readonly kind: "current" }
  | { readonly kind: "old"; readonly version: string; readonly packageRoot: string };

export type Role = "command" | "leaf";

/** What `/__orkestrator/hello` reports, as far as the scenarios read it. */
export interface HelloView {
  readonly appVersion?: string;
  readonly nodeMode?: string;
  /** The commit the backend was built from; absent on a build that reports none. */
  readonly buildCommit?: string;
  readonly capabilities?: Readonly<Record<string, number>>;
  readonly domains?: Readonly<Record<string, { readonly min: number; readonly max: number }>>;
}

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
  pathDirectories: readonly string[] = [directoryOf("bun"), directoryOf("git")].filter(
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
  probe: () => Promise<number> = ephemeralPort,
): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = await probe();
    if (port > 0 && !forbidden.has(port)) return port;
  }
  throw new SetupError("No free loopback port outside the forbidden set.");
}

function ephemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

/** Run a setup command; a failure is a {@link SetupError} with its stderr. */
export function runSetup(command: string, args: readonly string[], cwd: string): string {
  const result = spawnSync(command, [...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new SetupError(`${command} ${args.join(" ")}: ${(result.stderr ?? "").trim()}`);
  }
  return result.stdout;
}

/**
 * Install `orkestrator@<version>` from npm into `directory` (its own
 * `package.json`, so nothing outside it changes), without lifecycle scripts.
 * Returns the package root.
 */
export async function installRelease(version: string, directory: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(directory, "package.json"),
    '{"name":"mixed-version-qualification","private":true}\n',
  );
  runSetup("bun", ["add", "--ignore-scripts", "--exact", `orkestrator@${version}`], directory);
  const packageRoot = path.join(directory, "node_modules", "orkestrator");
  const installed = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")) as {
    version?: string;
  };
  if (installed.version !== version) {
    throw new SetupError(`npm installed orkestrator ${installed.version}, expected ${version}.`);
  }
  return packageRoot;
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

/** One backend in a qualification pair. */
export class PeerNode {
  child: ChildProcess | null = null;
  readonly output: string[] = [];
  /** `get_node_status().nodeId`, once started. */
  id = "";
  /** What `get_app_version` answered. */
  version = "";
  hello: HelloView = {};

  constructor(
    readonly name: string,
    readonly role: Role,
    readonly build: Build,
    readonly dir: string,
    readonly port: number,
    readonly token: string,
    /** The commands this build registers (manifest or release snapshot). */
    readonly commands: ReadonlySet<string>,
    readonly managed = true,
    readonly originOverride?: string,
  ) {}

  get origin(): string {
    return this.originOverride ?? `http://127.0.0.1:${this.port}`;
  }

  get label(): string {
    return `${this.name} (${this.build.kind === "current" ? "current" : this.build.version})`;
  }

  /** Whether this build registers `command`. */
  has(command: string): boolean {
    return this.commands.has(command);
  }

  /** Commands of `required` this build does not register. */
  missing(required: readonly string[]): string[] {
    return required.filter((command) => !this.has(command));
  }

  async request(
    pathname: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<{ status: number; json: unknown }> {
    const response = await fetch(`${this.origin}${pathname}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(120_000),
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

  /** The error a command answers with, or `""` when it succeeded. */
  async refusal(command: string, args: Record<string, unknown> = {}): Promise<string> {
    try {
      await this.invoke(command, args);
      return "";
    } catch (error) {
      return error instanceof InvokeError ? error.failure.message : String(error);
    }
  }

  /** Start the backend and wait for it to answer. */
  async start(): Promise<void> {
    if (!this.managed) return;
    const home = path.join(this.dir, "home");
    const tmp = path.join(this.dir, "tmp");
    for (const directory of [home, tmp, path.join(this.dir, "data")]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
    }
    const service = [
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
      ...(this.role === "command" && this.supportsCommandNodeFlag() ? ["--command-node"] : []),
    ];
    const [entry, args, cwd] =
      this.build.kind === "current"
        ? [
            path.join(ROOT, "apps", "backend", "src", "main.ts"),
            service,
            path.join(ROOT, "apps", "backend"),
          ]
        : [path.join(this.build.packageRoot, "bin", "orkestrator.js"), ["serve", ...service], tmp];
    const child = spawn("bun", [entry, ...args], {
      cwd,
      env: backendEnvironment(process.env, { home, tmp, token: this.token }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout!.on("data", (chunk: Buffer) => this.output.push(chunk.toString()));
    child.stderr!.on("data", (chunk: Buffer) => this.output.push(chunk.toString()));
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new SetupError(
          `${this.label} exited early (${child.exitCode ?? child.signalCode}): ${
            this.output.join("").match(/\w*Error: [^\n]*/u)?.[0] ?? "no error line"
          }`,
        );
      }
      try {
        this.version = await this.invoke<string>("get_app_version");
        await this.identify();
        return;
      } catch {
        await Bun.sleep(500);
      }
    }
    throw new SetupError(`${this.label} did not answer within 120 s.`);
  }

  /** Read the node's id, version and hello (also for an attached node). */
  async identify(): Promise<void> {
    if (!this.version) this.version = await this.invoke<string>("get_app_version");
    if (this.has("get_node_status")) {
      this.id = (await this.invoke<{ nodeId: string }>("get_node_status")).nodeId;
    }
    const hello = await this.request("/__orkestrator/hello").catch(() => null);
    if (hello?.status === 200 && hello.json && typeof hello.json === "object") {
      this.hello = hello.json as HelloView;
    }
  }

  private supportsCommandNodeFlag(): boolean {
    if (this.build.kind === "current") return true;
    const main = path.join(this.build.packageRoot, "dist", "main.js");
    return existsSync(main) && readFileSync(main, "utf8").includes('"--command-node"');
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    await exited;
    clearTimeout(timer);
  }
}

/** A new managed node with its own directory, port and token. */
export async function makeNode(input: {
  name: string;
  role: Role;
  build: Build;
  root: string;
  commands: ReadonlySet<string>;
}): Promise<PeerNode> {
  const dir = await mkdtemp(path.join(input.root, `${input.name.toLowerCase()}-`));
  return new PeerNode(
    input.name,
    input.role,
    input.build,
    dir,
    await freePort(),
    randomBytes(24).toString("base64url"),
    input.commands,
  );
}

/**
 * A backend that is already running (a `dev:test` profile): its origin and
 * gateway token, read by the caller from the profile's owner-only auth file.
 * It is never started or stopped here.
 */
export function attachedNode(input: {
  name: string;
  role: Role;
  origin: string;
  token: string;
  dir: string;
  commands: ReadonlySet<string>;
}): PeerNode {
  return new PeerNode(
    input.name,
    input.role,
    { kind: "current" },
    input.dir,
    Number(new URL(input.origin).port),
    input.token,
    input.commands,
    false,
    input.origin,
  );
}

/** Poll `read` until `ok` holds, or throw naming `label`. */
export async function until<T>(
  label: string,
  read: () => Promise<T>,
  ok: (value: T) => boolean,
  ms = 60_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  let last: T | undefined;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      last = await read();
      if (ok(last)) return last;
    } catch (error) {
      lastError = String(error).slice(0, 200);
    }
    await Bun.sleep(500);
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
