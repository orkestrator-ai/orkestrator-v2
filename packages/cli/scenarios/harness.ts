import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  parseBackendInstanceDescriptor,
  type BackendInstanceDescriptor,
} from "@orkestrator/protocol/backend-instance";
import { isPublicActionResponse, type PublicEnvelope } from "@orkestrator/protocol/public-api";

/**
 * Targeted CLI scenarios against a real, isolated backend.
 *
 * The harness owns everything it creates: a disposable data directory,
 * worktree root and fixture repositories, the backend process it started, and
 * a private run manifest. Scenarios drive the *packaged* executable
 * (`bin/orkestrator.js` over `dist/`) with argv only — never through a shell —
 * and assert on the JSON envelope and on authoritative state (files, Git,
 * processes), not on prose. Cleanup always runs and records its own errors
 * separately from the scenario's.
 */

export const PACKAGE_ROOT = path.resolve(import.meta.dir, "..");
const BIN = path.join(PACKAGE_ROOT, "bin", "orkestrator.js");
const READY_TIMEOUT_MS = 60_000;
const COMMAND_TIMEOUT_MS = 10 * 60_000;
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

export interface CliResult {
  argv: string[];
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** Parsed single JSON envelope when the command ran in JSON mode. */
  envelope?: PublicEnvelope;
}

export interface ManifestEntry {
  at: string;
  scenario: string;
  stage: string;
  argv: string[];
  code: number | null;
  durationMs: number;
  errorCode?: string;
  operationId?: string;
  ids?: Record<string, string>;
}

/** Private, bounded record of what a run did (IDs and codes only). */
export class RunManifest {
  readonly entries: ManifestEntry[] = [];
  readonly cleanupErrors: string[] = [];
  constructor(readonly file: string | null) {}

  async record(entry: ManifestEntry): Promise<void> {
    this.entries.push(entry);
    if (this.entries.length > 2_000) this.entries.shift();
    await this.flush();
  }

  async flush(extra: Record<string, unknown> = {}): Promise<void> {
    if (!this.file) return;
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await writeFile(
      this.file,
      `${JSON.stringify({ version: 1, entries: this.entries, cleanupErrors: this.cleanupErrors, ...extra }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
}

export interface IsolatedBackend {
  root: string;
  dataDir: string;
  worktreeDir: string;
  descriptor: BackendInstanceDescriptor;
  process: Bun.Subprocess;
  stop(): Promise<number | null>;
}

/** Start an isolated backend through the packaged launcher (`serve`). */
export async function startIsolatedBackend(options: {
  root: string;
  env?: Record<string, string>;
  extraArgs?: string[];
}): Promise<IsolatedBackend> {
  const dataDir = path.join(options.root, "data");
  const worktreeDir = path.join(options.root, "worktrees");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const logFile = path.join(options.root, "backend.log");
  const child = Bun.spawn(
    [
      process.execPath,
      BIN,
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--allow-non-tailscale-bind",
      "--data-dir",
      dataDir,
      "--worktree-dir",
      worktreeDir,
      "--runtime-flavor",
      "agent-test",
      ...(options.extraArgs ?? []),
    ],
    {
      cwd: options.root,
      stdout: "pipe",
      stderr: Bun.file(logFile),
      env: {
        ...process.env,
        // The control MCP listens on a fixed default port shared with any
        // desktop on this machine; an isolated backend never needs it.
        ORKESTRATOR_CONTROL_MCP_DISABLED: "1",
        ...options.env,
      },
    },
  );
  const expiry = setTimeout(() => child.kill("SIGTERM"), READY_TIMEOUT_MS);
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let ready = false;
  try {
    while (!ready) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      ready = lines.some((line) => line.includes('"orkestrator-backend-ready"'));
    }
  } finally {
    clearTimeout(expiry);
    reader.releaseLock();
  }
  // Keep draining stdout so the backend never blocks on a full pipe.
  const drain = child.stdout.getReader();
  void (async () => {
    try {
      for (;;) if ((await drain.read()).done) break;
    } catch {
      // The process exited.
    }
  })();
  if (!ready) {
    child.kill("SIGKILL");
    const log = await readFile(logFile, "utf8").catch(() => "");
    throw new Error(`Isolated backend did not become ready:\n${log.slice(-4_000)}`);
  }
  let descriptor: BackendInstanceDescriptor;
  try {
    descriptor = parseBackendInstanceDescriptor(
      JSON.parse(await readFile(path.join(dataDir, "backend-instance.json"), "utf8")),
    );
  } catch (error) {
    // Never leak the process this harness started.
    child.kill("SIGKILL");
    await child.exited;
    throw error;
  }
  return {
    root: options.root,
    dataDir,
    worktreeDir,
    descriptor,
    process: child,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
      child.kill("SIGTERM");
      const escalation = setTimeout(() => child.kill("SIGKILL"), 20_000);
      try {
        return await child.exited;
      } finally {
        clearTimeout(escalation);
      }
    },
  };
}

/**
 * A Git repository with a local bare origin; no network, no GitHub. The
 * origin sits at `<root>/fixtures/origin.git`, beside the backend's `data`
 * directory: the agent-test runtime mounts exactly that verified remote into
 * containers, so container environments can clone it too. One fixture per
 * scenario root.
 */
export async function createFixtureRepository(
  root: string,
  name: string,
  files: Record<string, string> = { "README.md": `# ${name}\n` },
): Promise<{ projectPath: string; originPath: string; head: string }> {
  const projectPath = path.join(root, "fixtures", name);
  const originPath = path.join(root, "fixtures", "origin.git");
  await mkdir(projectPath, { recursive: true });
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Orkestrator Scenario",
    GIT_AUTHOR_EMAIL: "scenario@example.invalid",
    GIT_COMMITTER_NAME: "Orkestrator Scenario",
    GIT_COMMITTER_EMAIL: "scenario@example.invalid",
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  };
  const git = (args: string[], cwd?: string) => {
    const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  git(["init", "--bare", "-b", "main", originPath]);
  git(["init", "-b", "main"], projectPath);
  for (const [file, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(projectPath, file)), { recursive: true });
    await writeFile(path.join(projectPath, file), contents);
  }
  git(["add", "."], projectPath);
  git(["commit", "-m", "Initial scenario fixture"], projectPath);
  git(["remote", "add", "origin", originPath], projectPath);
  git(["push", "-u", "origin", "main"], projectPath);
  return { projectPath, originPath, head: git(["rev-parse", "HEAD"], projectPath) };
}

export class ScenarioFailure extends Error {}

export function expectThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ScenarioFailure(message);
}

/**
 * Drives the packaged CLI. Every invocation gets the scenario's private
 * config directory, a deadline, and bounded capture; nothing is interpolated
 * into a shell.
 */
export class CliDriver {
  constructor(
    readonly scenario: string,
    readonly env: Record<string, string>,
    readonly manifest: RunManifest,
  ) {}

  async run(
    argv: string[],
    options: {
      stage: string;
      expectCode?: number;
      stdin?: string;
      timeoutMs?: number;
      signalAfterMs?: { signal: "SIGINT" | "SIGTERM"; afterMs: number };
    },
  ): Promise<CliResult> {
    const started = Date.now();
    const child = Bun.spawn([process.execPath, BIN, ...argv], {
      cwd: this.env.ORKESTRATOR_SCENARIO_CWD ?? PACKAGE_ROOT,
      env: { ...process.env, ...this.env },
      stdin: options.stdin !== undefined ? new TextEncoder().encode(options.stdin) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const deadline = setTimeout(
      () => child.kill("SIGKILL"),
      options.timeoutMs ?? COMMAND_TIMEOUT_MS,
    );
    const signalTimer = options.signalAfterMs
      ? setTimeout(() => child.kill(options.signalAfterMs!.signal), options.signalAfterMs.afterMs)
      : undefined;
    const bounded = async (stream: ReadableStream<Uint8Array>) => {
      const text = await new Response(stream).text();
      return text.length > MAX_CAPTURE_BYTES ? text.slice(-MAX_CAPTURE_BYTES) : text;
    };
    const [stdout, stderr, code] = await Promise.all([
      bounded(child.stdout),
      bounded(child.stderr),
      child.exited,
    ]);
    clearTimeout(deadline);
    if (signalTimer) clearTimeout(signalTimer);
    const result: CliResult = {
      argv,
      code,
      signal: child.signalCode,
      stdout,
      stderr,
      durationMs: Date.now() - started,
    };
    if (argv.includes("--json")) {
      const lines = stdout.trim().split("\n").filter(Boolean);
      expectThat(
        lines.length === 1,
        `[${options.stage}] JSON mode printed ${lines.length} lines on stdout`,
      );
      const parsed = JSON.parse(lines[0]!) as unknown;
      expectThat(
        isPublicActionResponse(parsed),
        `[${options.stage}] stdout is not a public envelope`,
      );
      result.envelope = parsed as PublicEnvelope;
    }
    await this.manifest.record({
      at: new Date().toISOString(),
      scenario: this.scenario,
      stage: options.stage,
      argv: argv.map((arg) => (arg.length > 200 ? `${arg.slice(0, 200)}…` : arg)),
      code,
      durationMs: result.durationMs,
      ...(result.envelope && !result.envelope.ok ? { errorCode: result.envelope.error.code } : {}),
      ...(result.envelope?.receipt ? { operationId: result.envelope.receipt.operationId } : {}),
    });
    if (options.expectCode !== undefined && code !== options.expectCode) {
      throw new ScenarioFailure(
        `[${options.stage}] expected exit ${options.expectCode}, got ${code}${
          result.envelope && !result.envelope.ok
            ? ` (${result.envelope.error.code}: ${result.envelope.error.message})`
            : ""
        }\n${stderr.slice(-2_000)}`,
      );
    }
    return result;
  }

  /** Run in JSON mode, require success, and return the result payload. */
  async ok<T = Record<string, unknown>>(
    argv: string[],
    stage: string,
    options: { stdin?: string; timeoutMs?: number } = {},
  ): Promise<{ result: T; envelope: PublicEnvelope }> {
    const run = await this.run(["--json", ...argv], { stage, expectCode: 0, ...options });
    const envelope = run.envelope!;
    expectThat(envelope.ok, `[${stage}] envelope not ok`);
    return { result: (envelope as { result: T }).result, envelope };
  }
}

export interface ScenarioContext {
  name: string;
  root: string;
  backend: IsolatedBackend;
  cli: CliDriver;
  manifest: RunManifest;
  /** Resources to clean even if the scenario fails. */
  cleanup: Array<{ label: string; run: () => Promise<void> }>;
  provider?: string;
  environmentType: "local" | "container";
}

export async function newScenarioRoot(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), `ork-cli-${prefix}-`));
}

export async function configureConnection(
  context: Pick<ScenarioContext, "cli" | "backend">,
): Promise<void> {
  await context.cli.ok(
    ["connection", "add", "scenario", "--data-dir", context.backend.dataDir, "--default"],
    "connection add",
  );
}

export async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

export async function writePrivate(file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
  await chmod(file, 0o600);
}

export async function removeTree(target: string): Promise<void> {
  await rm(target, { recursive: true, force: true });
}

export function runId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}
