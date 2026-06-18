import { chmodSync, existsSync, promises as fs, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dialog, shell } from "electron";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import * as pty from "node-pty";
import type { IPty } from "node-pty";
import type { Environment, EnvironmentStatus, EnvironmentType, PortMapping, PrState, SessionStatus, SessionType } from "./models.js";
import {
  APP_SLUG,
  CLAUDE_BRIDGE_PORT,
  CODEX_BRIDGE_PORT,
  DOCKER_IMAGE,
  DOCKER_LABEL_APP,
  DOCKER_LABEL_APP_VALUE,
  DOCKER_LABEL_ENVIRONMENT_ID,
  DOCKER_LABEL_PROJECT_ID,
  OPENCODE_SERVER_PORT,
  ORKESTRATOR_PROJECT_CONFIG,
} from "./constants.js";
import {
  createEnvironment,
  createProject,
  defaultRepositoryConfig,
  parseUpdateObject,
  sanitizeBranchName,
  sanitizeEnvironmentName,
  type JsonRecord,
  type StorageService,
} from "./storage.js";
import {
  commandExists,
  homePath,
  inferLanguage,
  pathExists,
  readFileBase64,
  readTextFile,
  runCommand,
  spawnCommand,
  writeFileBase64,
} from "./shell.js";
import {
  assertBase64PayloadWithinLimit,
  MAX_BINARY_FILE_BYTES,
  validateRelativeFilePath,
  workspaceFilePath,
} from "./path-safety.js";
import { registerTmuxBackendCommands } from "./tmux.js";

export type BackendEmit = (event: string, payload: unknown) => void;

export type CommandContext = {
  storage: StorageService;
  emit: BackendEmit;
  appRoot: string;
  resourceRoot: string;
};

type CommandHandler = (args: JsonRecord, context: CommandContext) => Promise<unknown> | unknown;

const nodeRequire = createRequire(import.meta.url);

type TerminalSessionConfig =
  | { kind: "container"; containerId: string; cols: number; rows: number; user?: string }
  | { kind: "local"; environmentId: string; cols: number; rows: number };

const terminalProcesses = new Map<string, IPty>();
const terminalSessionConfigs = new Map<string, TerminalSessionConfig>();
const localServerProcesses = new Map<string, ChildProcessWithoutNullStreams>();

function asString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`Expected ${name} to be a string`);
  return value;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Expected ${name} to be a number`);
  return value;
}

function asTerminalDimension(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asPortMappings(value: unknown): PortMapping[] | undefined {
  return Array.isArray(value) ? value as PortMapping[] : undefined;
}

function asEnvironmentType(value: unknown): EnvironmentType {
  return value === "local" ? "local" : "containerized";
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function validateGitRefName(value: string, name = "git ref"): string {
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.startsWith("-") ||
    trimmed.endsWith(".") ||
    trimmed.endsWith("/") ||
    trimmed.includes("..") ||
    trimmed.includes("//") ||
    /[\x00-\x20\x7f~^:?*[\\]/.test(trimmed) ||
    trimmed.split("/").some((part) => part.length === 0 || part.startsWith(".") || part.endsWith(".lock"))
  ) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return trimmed;
}

function containerIdMatches(known: string, candidate: string): boolean {
  const left = known.trim();
  const right = candidate.trim();
  return left.length > 0 && right.length > 0 && (left === right || left.startsWith(right) || right.startsWith(left));
}

function findEnvironmentByContainerId(environments: Environment[], containerId: string): Environment | undefined {
  return environments.find((environment) => environment.containerId && containerIdMatches(environment.containerId, containerId));
}

function bytesPayload(data: string | Buffer): number[] {
  return Array.from(Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8"));
}

function terminalEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TERM: process.env.TERM || "xterm-256color",
    COLORTERM: process.env.COLORTERM || "truecolor",
    LANG: process.env.LANG || "en_US.UTF-8",
  };
}

function ensureNodePtySpawnHelperExecutable(): void {
  if (process.platform !== "darwin") return;

  const packageJsonPath = nodeRequire.resolve("node-pty/package.json");
  const helperPath = path.join(path.dirname(packageJsonPath), "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
  if (!existsSync(helperPath)) return;

  const stat = statSync(helperPath);
  if ((stat.mode & 0o111) !== 0) return;

  chmodSync(helperPath, stat.mode | 0o755);
}

function resolveLocalShellPath(): string {
  const configuredShell = process.env.SHELL?.trim();
  if (configuredShell && path.isAbsolute(configuredShell) && existsSync(configuredShell)) {
    return configuredShell;
  }

  for (const candidate of ["/bin/zsh", "/bin/bash", "/bin/sh"]) {
    if (existsSync(candidate)) return candidate;
  }

  return configuredShell || "zsh";
}

function rememberTerminalSession(id: string, config: TerminalSessionConfig): string {
  terminalSessionConfigs.set(id, config);
  return id;
}

function cleanupTerminalSession(id: string): void {
  terminalProcesses.delete(id);
  terminalSessionConfigs.delete(id);
}

function spawnTerminalProcess(
  id: string,
  command: string,
  args: string[],
  options: { cwd?: string; cols: number; rows: number },
  emit: BackendEmit,
): IPty {
  const existing = terminalProcesses.get(id);
  if (existing) return existing;

  ensureNodePtySpawnHelperExecutable();

  const terminalProcess = pty.spawn(command, args, {
    name: "xterm-256color",
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: terminalEnv(),
  });

  terminalProcesses.set(id, terminalProcess);
  terminalProcess.onData((data) => emit(`terminal-output-${id}`, bytesPayload(data)));
  terminalProcess.onExit(() => cleanupTerminalSession(id));
  return terminalProcess;
}

function parsePositiveInteger(value: string, name: string): number {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid ${name}: ${trimmed}`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid ${name}: ${trimmed}`);
  }
  return parsed;
}

function parseDockerStatus(status: string): EnvironmentStatus {
  switch (status.trim().toLowerCase()) {
    case "running":
      return "running";
    case "created":
    case "restarting":
      return "creating";
    case "exited":
    case "dead":
    case "paused":
      return "stopped";
    default:
      return "error";
  }
}

async function getDockerStatus(containerId: string): Promise<EnvironmentStatus> {
  const { stdout } = await runCommand("docker", ["inspect", "-f", "{{.State.Status}}", containerId], { timeoutMs: 10_000 });
  return parseDockerStatus(stdout);
}

async function isContainerRunning(containerId: string): Promise<boolean> {
  try {
    return await getDockerStatus(containerId) === "running";
  } catch {
    return false;
  }
}

async function getHostPort(containerId: string, containerPort: number, protocol = "tcp"): Promise<number | null> {
  try {
    const { stdout } = await runCommand("docker", ["port", containerId, `${containerPort}/${protocol}`], { timeoutMs: 10_000 });
    const line = stdout.split("\n").find(Boolean);
    if (!line) return null;
    const rawPort = line.split(":").at(-1);
    const port = rawPort ? Number.parseInt(rawPort, 10) : Number.NaN;
    return Number.isFinite(port) ? port : null;
  } catch {
    return null;
  }
}

async function syncStoredEnvironmentStatus(environment: Environment, storage: StorageService): Promise<Environment> {
  if (environment.environmentType === "local") {
    return environment;
  }

  if (!environment.containerId) {
    if (environment.status !== "stopped") {
      return storage.updateEnvironment(environment.id, { status: "stopped" });
    }
    return environment;
  }

  try {
    const status = await getDockerStatus(environment.containerId);
    if (status !== environment.status) {
      return storage.updateEnvironment(environment.id, { status });
    }
    return environment;
  } catch {
    return storage.updateEnvironment(environment.id, { status: "stopped", containerId: null });
  }
}

function getWorktreeBaseDir(): string {
  return path.join(os.homedir(), APP_SLUG, "workspaces");
}

async function readSetupLocalCommands(worktreePath: string): Promise<string[]> {
  const configPath = path.join(worktreePath, ORKESTRATOR_PROJECT_CONFIG);
  if (!await pathExists(configPath)) return [];

  const parsed = JSON.parse(await fs.readFile(configPath, "utf8")) as { setupLocal?: unknown };
  if (typeof parsed.setupLocal === "string") return parsed.setupLocal.trim() ? [parsed.setupLocal] : [];
  if (Array.isArray(parsed.setupLocal)) return parsed.setupLocal.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return [];
}

async function createLocalWorktree(
  projectPath: string,
  projectName: string,
  branch: string,
  baseBranch?: string,
): Promise<{ path: string; branch: string }> {
  await fs.mkdir(getWorktreeBaseDir(), { recursive: true });
  let finalBranch = sanitizeBranchName(branch);
  let worktreePath = path.join(getWorktreeBaseDir(), `${sanitizeEnvironmentName(projectName)}-${finalBranch}`);

  let suffix = 1;
  while (await pathExists(worktreePath)) {
    finalBranch = `${sanitizeBranchName(branch)}-${suffix}`;
    worktreePath = path.join(getWorktreeBaseDir(), `${sanitizeEnvironmentName(projectName)}-${finalBranch}`);
    suffix += 1;
  }

  const args = ["-C", projectPath, "worktree", "add", "-b", finalBranch, worktreePath];
  if (baseBranch?.trim()) args.push(baseBranch.trim());
  await runCommand("git", args, { timeoutMs: 120_000 });

  await fs.mkdir(path.join(worktreePath, ".orkestrator"), { recursive: true });
  await fs.appendFile(path.join(worktreePath, ".git", "info", "exclude"), "\n.orkestrator/\n").catch(() => undefined);

  for (const envFile of [".env", ".env.local"]) {
    const source = path.join(projectPath, envFile);
    const destination = path.join(worktreePath, envFile);
    if (await pathExists(source) && !await pathExists(destination)) {
      await fs.copyFile(source, destination);
    }
  }

  return { path: worktreePath, branch: finalBranch };
}

async function removeLocalWorktree(worktreePath: string): Promise<void> {
  await runCommand("git", ["-C", worktreePath, "worktree", "remove", "--force", worktreePath], { timeoutMs: 120_000 }).catch(async () => {
    await fs.rm(worktreePath, { recursive: true, force: true });
  });
}

async function dockerExec(containerId: string, command: string): Promise<string> {
  const { stdout } = await runCommand("docker", ["exec", containerId, "bash", "-lc", command], { timeoutMs: 120_000 });
  return stdout;
}

async function dockerExecDetached(containerId: string, command: string): Promise<void> {
  await runCommand("docker", ["exec", "-d", containerId, "bash", "-lc", command], { timeoutMs: 30_000 });
}

async function checkHttpHealth(port: number, pathName = "/global/health"): Promise<boolean> {
  const http = await import("node:http");
  return new Promise((resolve) => {
    let settled = false;
    const complete = (healthy: boolean) => {
      if (settled) return;
      settled = true;
      resolve(healthy);
    };
    const request = http.get({ host: "127.0.0.1", port, path: pathName, timeout: 2_000 }, (response) => {
      response.resume();
      complete((response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300);
    });
    request.once("timeout", () => {
      request.destroy();
      complete(false);
    });
    request.once("error", () => complete(false));
  });
}

async function waitForHealth(port: number, pathName = "/global/health", attempts = 75): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await checkHttpHealth(port, pathName)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Server on port ${port} did not become healthy`);
}

async function waitForLocalServerStartup(
  child: ChildProcessWithoutNullStreams,
  port: number,
  kind: "opencode" | "claude" | "codex",
): Promise<void> {
  let settled = false;

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const complete = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onError = (error: Error) => complete(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      complete(new Error(`${kind} server exited before becoming healthy (code ${code ?? "null"}, signal ${signal ?? "null"})`));
    };

    child.once("error", onError);
    child.once("exit", onExit);
    waitForHealth(port).then(() => complete(), (error: unknown) => {
      complete(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

function getBridgePath(context: CommandContext, bridgeName: "claude-bridge" | "codex-bridge"): string {
  const devPath = path.join(context.appRoot, "bridges", bridgeName);
  if (process.env.NODE_ENV !== "production" && existsSync(devPath)) return devPath;
  return path.join(context.resourceRoot, bridgeName);
}

async function startLocalServer(
  environmentId: string,
  context: CommandContext,
  kind: "opencode" | "claude" | "codex",
): Promise<{ port: number; pid: number; wasRunning: boolean }> {
  const key = `${kind}:${environmentId}`;
  const existing = localServerProcesses.get(key);
  if (existing && !existing.killed && existing.pid) {
    const env = await context.storage.getEnvironment(environmentId);
    const port = kind === "opencode" ? env?.localOpencodePort : kind === "claude" ? env?.localClaudePort : env?.localCodexPort;
    if (port && await checkHttpHealth(port)) {
      return { port, pid: existing.pid, wasRunning: true };
    }
    existing.kill();
    localServerProcesses.delete(key);
  }

  const environment = await context.storage.getEnvironment(environmentId);
  if (!environment?.worktreePath) throw new Error("Local environment worktree is not available");

  const port = await allocateLocalPort();
  let command = "";
  let cwd = environment.worktreePath;
  const env = { ...process.env, PORT: String(port), HOSTNAME: "127.0.0.1", CWD: environment.worktreePath };

  if (kind === "opencode") {
    command = "opencode";
  } else if (kind === "claude") {
    command = "node";
    cwd = getBridgePath(context, "claude-bridge");
  } else {
    command = "node";
    cwd = getBridgePath(context, "codex-bridge");
  }

  const bridgeEntrypoint = path.join(cwd, "dist", "index.js");
  if (kind !== "opencode") {
    if (!existsSync(cwd)) throw new Error(`${kind} bridge directory not found: ${cwd}`);
    if (!existsSync(bridgeEntrypoint)) throw new Error(`${kind} bridge entrypoint not found: ${bridgeEntrypoint}`);
  }

  const args = kind === "opencode"
    ? ["serve", "--port", String(port), "--hostname", "127.0.0.1"]
    : [bridgeEntrypoint];
  const child = spawnCommand(command, args, { cwd, env });
  localServerProcesses.set(key, child);
  child.stdout.on("data", (data) => console.debug(`[${kind}:${environmentId}] ${data.toString()}`));
  child.stderr.on("data", (data) => console.error(`[${kind}:${environmentId}] ${data.toString()}`));
  child.once("exit", () => localServerProcesses.delete(key));

  const field = kind === "opencode" ? "localOpencodePort" : kind === "claude" ? "localClaudePort" : "localCodexPort";
  const pidField = kind === "opencode" ? "opencodePid" : kind === "claude" ? "claudeBridgePid" : "codexBridgePid";
  try {
    await waitForLocalServerStartup(child, port, kind);
  } catch (error) {
    child.kill();
    localServerProcesses.delete(key);
    await context.storage.updateEnvironment(environmentId, { [field]: null, [pidField]: null }).catch(() => undefined);
    throw error;
  }
  await context.storage.updateEnvironment(environmentId, { [field]: port, [pidField]: child.pid });
  return { port, pid: child.pid ?? 0, wasRunning: false };
}

async function stopLocalServer(environmentId: string, context: CommandContext, kind: "opencode" | "claude" | "codex"): Promise<void> {
  const key = `${kind}:${environmentId}`;
  const child = localServerProcesses.get(key);
  if (child) {
    child.kill();
    localServerProcesses.delete(key);
  }
  const fields = kind === "opencode"
    ? { opencodePid: null, localOpencodePort: null }
    : kind === "claude"
      ? { claudeBridgePid: null, localClaudePort: null }
      : { codexBridgePid: null, localCodexPort: null };
  await context.storage.updateEnvironment(environmentId, fields);
}

async function getLocalServerStatus(environmentId: string, context: CommandContext, kind: "opencode" | "claude" | "codex"): Promise<{ running: boolean; port: number | null; pid: number | null }> {
  const key = `${kind}:${environmentId}`;
  const child = localServerProcesses.get(key);
  const env = await context.storage.getEnvironment(environmentId);
  const port = kind === "opencode" ? env?.localOpencodePort : kind === "claude" ? env?.localClaudePort : env?.localCodexPort;
  const pid = kind === "opencode" ? env?.opencodePid : kind === "claude" ? env?.claudeBridgePid : env?.codexBridgePid;
  return { running: !!child && !child.killed, port: port ?? null, pid: child?.pid ?? pid ?? null };
}

async function allocateLocalPort(): Promise<number> {
  const net = await import("node:net");
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("Failed to allocate port")));
      }
    });
    server.once("error", reject);
  });
}

async function buildFileTree(rootPath: string, relativePath = ""): Promise<Array<{ name: string; path: string; isDirectory: boolean; children?: unknown[]; extension?: string }>> {
  const fullPath = path.join(rootPath, relativePath);
  const entries = await fs.readdir(fullPath, { withFileTypes: true });
  const nodes = [];
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const childRelativePath = path.join(relativePath, entry.name);
    if (entry.isDirectory()) {
      nodes.push({
        name: entry.name,
        path: childRelativePath,
        isDirectory: true,
        children: await buildFileTree(rootPath, childRelativePath),
      });
    } else {
      nodes.push({
        name: entry.name,
        path: childRelativePath,
        isDirectory: false,
        extension: path.extname(entry.name),
      });
    }
  }
  return nodes.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
}

async function getLocalGitStatus(worktreePath: string, targetBranch: string): Promise<unknown[]> {
  const base = await resolveLocalGitBase(worktreePath, targetBranch);
  const [nameStatus, numstat, porcelain] = await Promise.all([
    runCommand("git", ["-C", worktreePath, "diff", "--name-status", base], { timeoutMs: 60_000 }),
    runCommand("git", ["-C", worktreePath, "diff", "--numstat", base], { timeoutMs: 60_000 }),
    runCommand("git", ["-C", worktreePath, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { timeoutMs: 60_000 }),
  ]);

  const stats = new Map<string, { additions: number; deletions: number }>();
  for (const line of numstat.stdout.split("\n").filter(Boolean)) {
    const [additions = "0", deletions = "0", ...paths] = line.split("\t");
    const normalizedPath = paths.at(-1) ?? "";
    stats.set(normalizedPath, {
      additions: additions === "-" ? 0 : Number.parseInt(additions, 10) || 0,
      deletions: deletions === "-" ? 0 : Number.parseInt(deletions, 10) || 0,
    });
  }

  const changes = nameStatus.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      const status = parts[0] ?? "";
      const filePath = parts.at(-1) ?? "";
      const fileStats = stats.get(filePath) ?? { additions: 0, deletions: 0 };
      return {
        path: filePath,
        filename: path.basename(filePath),
        directory: path.dirname(filePath) === "." ? "" : path.dirname(filePath),
        additions: fileStats.additions,
        deletions: fileStats.deletions,
        status,
      };
    });

  const existingPaths = new Set(changes.map((change) => change.path));
  for (const line of porcelain.stdout.split("\0").filter(Boolean)) {
    if (!line.startsWith("?? ")) continue;
    const filePath = line.slice(3);
    if (existingPaths.has(filePath)) continue;
    const additions = await countLocalFileLines(worktreePath, filePath).catch(() => 0);
    changes.push({
      path: filePath,
      filename: path.basename(filePath),
      directory: path.dirname(filePath) === "." ? "" : path.dirname(filePath),
      additions,
      deletions: 0,
      status: "?",
    });
  }

  return changes;
}

async function countLocalFileLines(rootPath: string, relativePath: string): Promise<number> {
  const target = validateRelativeFilePath(relativePath, "git status path");
  const fullPath = path.join(rootPath, target);
  const stat = await fs.stat(fullPath);
  if (stat.size === 0 || stat.size > MAX_BINARY_FILE_BYTES) return 0;
  const buffer = await fs.readFile(fullPath);
  if (buffer.includes(0)) return 0;
  const text = buffer.toString("utf8");
  if (!text) return 0;
  const trailingNewline = text.endsWith("\n") || text.endsWith("\r");
  return text.split(/\r\n|\r|\n/).length - (trailingNewline ? 1 : 0);
}

async function gitRefExists(worktreePath: string, refName: string): Promise<boolean> {
  return runCommand("git", ["-C", worktreePath, "rev-parse", "--verify", "--quiet", `${refName}^{commit}`], { timeoutMs: 10_000 })
    .then(() => true, () => false);
}

async function resolveLocalGitBase(worktreePath: string, targetBranch: string): Promise<string> {
  const branch = validateGitRefName(targetBranch, "target branch");
  await runCommand("git", ["-C", worktreePath, "fetch", "origin", branch], { timeoutMs: 60_000 }).catch(() => undefined);

  const remoteRef = `origin/${branch}`;
  if (await gitRefExists(worktreePath, remoteRef)) return remoteRef;
  if (await gitRefExists(worktreePath, branch)) return branch;
  return remoteRef;
}

function isGitShowMissingPathError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("exists on disk, but not in") ||
    message.includes("does not exist in") ||
    message.includes("Path ") && message.includes(" does not exist")
  );
}

async function readLocalFileAtBranch(worktreePath: string, filePath: string, branch: string): Promise<{ path: string; content: string; language: string } | null> {
  const target = validateRelativeFilePath(filePath, "filePath");
  const base = await resolveLocalGitBase(worktreePath, branch);
  try {
    const { stdout } = await runCommand("git", ["-C", worktreePath, "show", `${base}:${target}`], { timeoutMs: 30_000 });
    return { path: target, content: stdout, language: inferLanguage(target) };
  } catch (error) {
    if (isGitShowMissingPathError(error)) return null;
    throw error;
  }
}

function clearGitHubTokenGitConfigCommand(): string {
  return "git config --global --list 2>/dev/null | grep '^url\\.https://x-access-token:' | sed 's/\\.insteadof=.*//' | sort -u | while read -r section; do git config --global --remove-section \"$section\" 2>/dev/null || true; done";
}

function setGitHubTokenGitConfigCommand(token: string): string {
  const tokenUrl = `https://x-access-token:${token}@github.com/`;
  const rewrites = ["https://github.com/", "https://github.com", "git@github.com:"];
  return [
    clearGitHubTokenGitConfigCommand(),
    ...rewrites.map((rewrite) => `git config --global --add ${quoteShell(`url.${tokenUrl}.insteadOf`)} ${quoteShell(rewrite)}`),
  ].join("\n");
}

function githubTokenPropagationCommand(newToken: string | undefined): string {
  const token = newToken?.trim();
  return token ? setGitHubTokenGitConfigCommand(token) : clearGitHubTokenGitConfigCommand();
}

async function createDockerContainer(environment: Environment, context: CommandContext): Promise<string> {
  const project = await context.storage.getProject(environment.projectId);
  if (!project) throw new Error(`Project not found: ${environment.projectId}`);
  const config = await context.storage.loadConfig();
  const repoConfig = config.repositories[project.id] ?? defaultRepositoryConfig();
  const args = [
    "create",
    "--name",
    environment.name,
    "--label",
    `${DOCKER_LABEL_APP}=${DOCKER_LABEL_APP_VALUE}`,
    "--label",
    `${DOCKER_LABEL_ENVIRONMENT_ID}=${environment.id}`,
    "--label",
    `${DOCKER_LABEL_PROJECT_ID}=${project.id}`,
    "--workdir",
    "/workspace",
    "--cap-add",
    "NET_ADMIN",
    "-e",
    `GIT_URL=${project.gitUrl}`,
    "-e",
    `GIT_BRANCH=${environment.branch}`,
    "-e",
    `GIT_BASE_BRANCH=${repoConfig.defaultBranch || "main"}`,
    "-e",
    "TERM=xterm-256color",
  ];

  if (config.global.githubToken) {
    args.push("-e", `GITHUB_TOKEN=${config.global.githubToken}`, "-e", `GH_TOKEN=${config.global.githubToken}`);
  }
  if (config.global.anthropicApiKey) args.push("-e", `ANTHROPIC_API_KEY=${config.global.anthropicApiKey}`);
  if (config.global.opencodeModel) args.push("-e", `OPENCODE_MODEL=${config.global.opencodeModel}`);
  if (environment.networkAccessMode === "full") {
    args.push("-e", "NETWORK_MODE=full");
  } else {
    const domains = environment.allowedDomains ?? config.global.allowedDomains;
    args.push("-e", "NETWORK_MODE=restricted", "-e", `ALLOWED_DOMAINS=${domains.join(",")}`);
  }

  const home = os.homedir();
  const bindIfExists = async (source: string, target: string, readonly = true) => {
    if (await pathExists(source)) args.push("-v", `${source}:${target}${readonly ? ":ro" : ""}`);
  };
  await bindIfExists(path.join(home, ".claude"), "/claude-config");
  await bindIfExists(path.join(home, ".claude.json"), "/claude-config.json");
  await bindIfExists(path.join(home, ".codex"), "/codex-home");
  await bindIfExists(path.join(home, ".config", "opencode"), "/opencode-config");
  await bindIfExists(path.join(home, ".local", "share", "opencode"), "/opencode-data");
  await bindIfExists(path.join(home, ".local", "state", "opencode"), "/opencode-state");
  await bindIfExists(path.join(home, ".gitconfig"), "/tmp/gitconfig");

  if (project.localPath) {
    await bindIfExists(path.join(project.localPath, ".env"), "/project-env/.env");
    await bindIfExists(path.join(project.localPath, ".env.local"), "/project-env/.env.local");
    await bindIfExists(path.join(project.localPath, "opencode.json"), "/opencode-project-json");
  }

  for (const mapping of environment.portMappings ?? []) {
    args.push("-p", `127.0.0.1:${mapping.hostPort}:${mapping.containerPort}/${mapping.protocol ?? "tcp"}`);
  }
  args.push("-p", `127.0.0.1::${OPENCODE_SERVER_PORT}/tcp`);
  args.push("-p", `127.0.0.1::${CLAUDE_BRIDGE_PORT}/tcp`);
  args.push("-p", `127.0.0.1::${CODEX_BRIDGE_PORT}/tcp`);
  if (repoConfig.entryPort) args.push("-p", `127.0.0.1::${repoConfig.entryPort}/tcp`);
  args.push(DOCKER_IMAGE);

  const { stdout } = await runCommand("docker", args, { timeoutMs: 120_000 });
  return stdout.trim();
}

async function startContainerServer(containerId: string, port: number, processName: "opencode" | "claude" | "codex", command: string): Promise<{ hostPort: number; wasRunning: boolean }> {
  if (!await isContainerRunning(containerId)) throw new Error("Container is not running");
  const hostPort = await getHostPort(containerId, port);
  if (!hostPort) throw new Error(`Container port ${port} is not mapped`);
  if (await checkHttpHealth(hostPort)) return { hostPort, wasRunning: true };
  await dockerExecDetached(containerId, command);
  await waitForHealth(hostPort).catch(async (error) => {
    const logFile = processName === "opencode" ? "/tmp/opencode-serve.log" : processName === "claude" ? "/tmp/claude-bridge.log" : "/tmp/codex-bridge.log";
    const log = await dockerExec(containerId, `cat ${logFile} 2>/dev/null || true`).catch(() => "");
    throw new Error(`${error instanceof Error ? error.message : String(error)}${log.trim() ? `\n${log.trim()}` : ""}`);
  });
  return { hostPort, wasRunning: false };
}

export function createCommandRegistry(): Map<string, CommandHandler> {
  const commands = new Map<string, CommandHandler>();
  const register = (name: string, handler: CommandHandler) => commands.set(name, handler);

  register("greet", ({ name }) => `Hello, ${asString(name, "name")}! You've been greeted from Electron backend!`);
  register("browse_for_directory", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (result.canceled) return null;
    return result.filePaths[0] ?? null;
  });

  register("get_projects", (_args, { storage }) => storage.loadProjects());
  register("add_project", ({ gitUrl, localPath }, { storage }) => storage.addProject(createProject(asString(gitUrl, "gitUrl"), asOptionalString(localPath))));
  register("remove_project", ({ projectId }, { storage }) => storage.removeProject(asString(projectId, "projectId")));
  register("get_project", ({ projectId }, { storage }) => storage.getProject(asString(projectId, "projectId")));
  register("update_project", ({ projectId, updates }, { storage }) => storage.updateProject(asString(projectId, "projectId"), parseUpdateObject(updates)));
  register("reorder_projects", ({ projectIds }, { storage }) => storage.reorderProjects(asStringArray(projectIds)));
  register("validate_git_url", ({ url }) => /^(https?:\/\/|git@|ssh:\/\/).+/.test(asString(url, "url").trim()));
  register("get_git_remote_url", async ({ path: repoPath }) => {
    const { stdout } = await runCommand("git", ["-C", asString(repoPath, "path"), "remote", "get-url", "origin"], { timeoutMs: 10_000 });
    return stdout.trim() || null;
  });

  register("get_config", (_args, { storage }) => storage.loadConfig());
  register("save_config", ({ config }, { storage }) => storage.saveConfig(config as never));
  register("get_global_config", async (_args, { storage }) => (await storage.loadConfig()).global);
  register("update_global_config", ({ global }, { storage }) => storage.updateGlobalConfig(global as never));
  register("get_repository_config", ({ projectId }, { storage }) => storage.getRepositoryConfig(asString(projectId, "projectId")));
  register("update_repository_config", ({ projectId, repoConfig }, { storage }) => storage.updateRepositoryConfig(asString(projectId, "projectId"), repoConfig as never));
  register("get_log_directory", (_args, { storage }) => storage.getLogDirectory());

  register("get_environments", async ({ projectId }, { storage }) => {
    const environments = await storage.getEnvironmentsByProject(asString(projectId, "projectId"));
    return Promise.all(environments.map((environment) => syncStoredEnvironmentStatus(environment, storage)));
  });
  register("get_environment", ({ environmentId }, { storage }) => storage.getEnvironment(asString(environmentId, "environmentId")));
  register("reorder_environments", ({ projectId, environmentIds }, { storage }) => storage.reorderEnvironments(asString(projectId, "projectId"), asStringArray(environmentIds)));
  register("create_environment", async ({ projectId, name, networkAccessMode, initialPrompt, portMappings, environmentType }, { storage }) => {
    const project = await storage.getProject(asString(projectId, "projectId"));
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const repoConfig = await storage.getRepositoryConfig(project.id);
    const env = createEnvironment(project.id, {
      name: asOptionalString(name),
      networkAccessMode: networkAccessMode === "full" ? "full" : networkAccessMode === "restricted" ? "restricted" : undefined,
      initialPrompt: asOptionalString(initialPrompt),
      portMappings: asPortMappings(portMappings),
      environmentType: asEnvironmentType(environmentType),
      entryPort: repoConfig.entryPort,
    });
    const config = await storage.loadConfig();
    config.repositories[project.id] = { ...repoConfig, lastEnvironmentType: env.environmentType };
    await storage.saveConfig(config);
    return storage.addEnvironment(env);
  });
  register("delete_environment", async ({ environmentId }, { storage }) => {
    const environment = await storage.getEnvironment(asString(environmentId, "environmentId"));
    if (environment?.containerId) await runCommand("docker", ["rm", "-f", environment.containerId], { timeoutMs: 60_000 }).catch(() => undefined);
    if (environment?.worktreePath) await removeLocalWorktree(environment.worktreePath).catch(() => undefined);
    await storage.removeSessionsByEnvironment(asString(environmentId, "environmentId")).catch(() => undefined);
    await storage.removeEnvironment(asString(environmentId, "environmentId"));
  });
  register("rename_environment", ({ environmentId, name }, { storage }) => {
    const newName = sanitizeEnvironmentName(asString(name, "name"));
    return storage.updateEnvironment(asString(environmentId, "environmentId"), { name: newName, branch: sanitizeBranchName(newName) });
  });
  register("rename_environment_from_prompt", async ({ environmentId, prompt }, { storage, emit }) => {
    const words = asString(prompt, "prompt").toLowerCase().replace(/[^a-z0-9\s-]/g, "").split(/\s+/).filter(Boolean).slice(0, 5);
    if (words.length === 0) return;
    const newName = sanitizeEnvironmentName(words.join("-"));
    const updated = await storage.updateEnvironment(asString(environmentId, "environmentId"), { name: newName, branch: sanitizeBranchName(newName) });
    emit("environment-renamed", { environment_id: updated.id, new_name: updated.name, new_branch: updated.branch });
  });
  register("get_environment_status", async ({ environmentId }, { storage }) => {
    const environment = await storage.getEnvironment(asString(environmentId, "environmentId"));
    if (!environment) throw new Error(`Environment not found: ${environmentId}`);
    return (await syncStoredEnvironmentStatus(environment, storage)).status;
  });
  register("sync_environment_status", async ({ environmentId }, { storage }) => {
    const environment = await storage.getEnvironment(asString(environmentId, "environmentId"));
    if (!environment) throw new Error(`Environment not found: ${environmentId}`);
    return syncStoredEnvironmentStatus(environment, storage);
  });
  register("sync_all_environments_with_docker", async (_args, { storage }) => {
    const cleared: string[] = [];
    for (const environment of await storage.loadEnvironments()) {
      if (!environment.containerId) continue;
      try {
        await getDockerStatus(environment.containerId);
      } catch {
        await storage.updateEnvironment(environment.id, { status: "stopped", containerId: null });
        cleared.push(environment.id);
      }
    }
    return cleared;
  });
  register("start_environment", async ({ environmentId }, { storage }) => {
    const environment = await storage.getEnvironment(asString(environmentId, "environmentId"));
    if (!environment) throw new Error(`Environment not found: ${environmentId}`);
    await storage.updateEnvironment(environment.id, { status: "creating" });

    if (environment.environmentType === "local") {
      if (environment.worktreePath && await pathExists(environment.worktreePath)) {
        await storage.updateEnvironment(environment.id, { status: "running" });
        return { setupCommands: environment.setupScriptsComplete ? undefined : await readSetupLocalCommands(environment.worktreePath) };
      }
      const project = await storage.getProject(environment.projectId);
      if (!project?.localPath) throw new Error("Project has no local path - cannot create a local worktree");
      const repoConfig = await storage.getRepositoryConfig(project.id);
      const worktree = await createLocalWorktree(project.localPath, project.name, environment.branch, repoConfig.defaultBranch);
      await storage.updateEnvironment(environment.id, { worktreePath: worktree.path, branch: worktree.branch, status: "running" });
      return { setupCommands: await readSetupLocalCommands(worktree.path) };
    }

    let containerId = environment.containerId;
    if (!containerId) {
      containerId = await createDockerContainer(environment, { storage, emit: () => undefined, appRoot: "", resourceRoot: "" });
      await storage.updateEnvironment(environment.id, { containerId });
    }
    await runCommand("docker", ["start", containerId], { timeoutMs: 60_000 });
    const hostEntryPort = environment.entryPort ? await getHostPort(containerId, environment.entryPort) : null;
    await storage.updateEnvironment(environment.id, {
      status: "running",
      entryPort: environment.entryPort ?? null,
      hostEntryPort,
    });
    return {};
  });
  register("stop_environment", async ({ environmentId }, { storage }) => {
    const environment = await storage.getEnvironment(asString(environmentId, "environmentId"));
    if (!environment) throw new Error(`Environment not found: ${environmentId}`);
    if (environment.containerId) await runCommand("docker", ["stop", environment.containerId], { timeoutMs: 60_000 });
    await storage.updateEnvironment(environment.id, { status: "stopped" });
  });
  register("recreate_environment", async ({ environmentId }, context) => {
    const environment = await context.storage.getEnvironment(asString(environmentId, "environmentId"));
    if (!environment?.containerId) return;
    await runCommand("docker", ["rm", "-f", environment.containerId], { timeoutMs: 60_000 }).catch(() => undefined);
    await context.storage.updateEnvironment(environment.id, { containerId: null, status: "stopped" });
    return commands.get("start_environment")?.({ environmentId }, context);
  });
  register("set_environment_pr", ({ environmentId, prUrl, prState, hasMergeConflicts }, { storage }) =>
    storage.updateEnvironment(asString(environmentId, "environmentId"), { prUrl: asString(prUrl, "prUrl"), prState, hasMergeConflicts }),
  );
  register("clear_environment_pr", ({ environmentId }, { storage }) =>
    storage.updateEnvironment(asString(environmentId, "environmentId"), { prUrl: null, prState: null, hasMergeConflicts: null }).then(() => undefined),
  );
  register("get_environment_pr_url", async ({ environmentId }, { storage }) => (await storage.getEnvironment(asString(environmentId, "environmentId")))?.prUrl ?? null);
  register("set_environment_setup_complete", ({ environmentId, complete }, { storage }) =>
    storage.updateEnvironment(asString(environmentId, "environmentId"), { setupScriptsComplete: asBoolean(complete) }),
  );
  register("get_setup_commands", async ({ environmentId }, { storage }) => {
    const environment = await storage.getEnvironment(asString(environmentId, "environmentId"));
    if (!environment?.worktreePath) return null;
    const setupCommands = await readSetupLocalCommands(environment.worktreePath);
    return setupCommands.length > 0 ? setupCommands : null;
  });
  register("update_port_mappings", ({ environmentId, portMappings }, { storage }) =>
    storage.updateEnvironment(asString(environmentId, "environmentId"), { portMappings: asPortMappings(portMappings) ?? [] }),
  );
  register("update_environment_agent_settings", ({ environmentId, defaultAgent, claudeMode, claudeNativeBackend, opencodeMode, codexMode }, { storage }) =>
    storage.updateEnvironment(asString(environmentId, "environmentId"), { defaultAgent, claudeMode, claudeNativeBackend, opencodeMode, codexMode }),
  );
  register("update_environment_allowed_domains", ({ environmentId, domains }, { storage }) =>
    storage.updateEnvironment(asString(environmentId, "environmentId"), { allowedDomains: asStringArray(domains) }),
  );
  register("add_environment_domains", async ({ environmentId, domains }, { storage }) => {
    const environment = await storage.getEnvironment(asString(environmentId, "environmentId"));
    if (!environment) throw new Error(`Environment not found: ${environmentId}`);
    const updated = Array.from(new Set([...(environment.allowedDomains ?? []), ...asStringArray(domains)]));
    await storage.updateEnvironment(environment.id, { allowedDomains: updated });
    return updated.join(",");
  });
  register("remove_environment_domains", async ({ environmentId, domains }, { storage }) => {
    const environment = await storage.getEnvironment(asString(environmentId, "environmentId"));
    if (!environment) throw new Error(`Environment not found: ${environmentId}`);
    const remove = new Set(asStringArray(domains));
    const updated = (environment.allowedDomains ?? []).filter((domain) => !remove.has(domain));
    await storage.updateEnvironment(environment.id, { allowedDomains: updated });
    return updated.join(",");
  });

  register("check_docker", () => commandExists("docker").then(async (exists) => exists && runCommand("docker", ["info"], { timeoutMs: 10_000 }).then(() => true, () => false)));
  register("docker_version", async () => (await runCommand("docker", ["version", "--format", "{{.Server.Version}}"], { timeoutMs: 10_000 })).stdout.trim());
  register("check_base_image", () => runCommand("docker", ["image", "inspect", DOCKER_IMAGE], { timeoutMs: 10_000 }).then(() => true, () => false));
  register("provision_environment", async ({ environmentId }, context) => {
    const environment = await context.storage.getEnvironment(asString(environmentId, "environmentId"));
    if (!environment) throw new Error(`Environment not found: ${environmentId}`);
    const containerId = await createDockerContainer(environment, context);
    await context.storage.updateEnvironment(environment.id, { containerId });
    return containerId;
  });
  register("docker_start_container", ({ containerId }) => runCommand("docker", ["start", asString(containerId, "containerId")], { timeoutMs: 60_000 }).then(() => undefined));
  register("docker_stop_container", ({ containerId }) => runCommand("docker", ["stop", asString(containerId, "containerId")], { timeoutMs: 60_000 }).then(() => undefined));
  register("docker_remove_container", ({ containerId }) => runCommand("docker", ["rm", "-f", asString(containerId, "containerId")], { timeoutMs: 60_000 }).then(() => undefined));
  register("docker_container_status", ({ containerId }) => getDockerStatus(asString(containerId, "containerId")));
  register("list_docker_containers", async () => {
    const { stdout } = await runCommand("docker", ["ps", "-a", "--no-trunc", "--filter", `label=${DOCKER_LABEL_APP}=${DOCKER_LABEL_APP_VALUE}`, "--format", "{{.ID}}\t{{.Names}}"], { timeoutMs: 10_000 });
    return stdout.split("\n").filter(Boolean).map((line) => line.split("\t"));
  });
  register("get_container_host_port", ({ containerId, containerPort }) => getHostPort(asString(containerId, "containerId"), asNumber(containerPort, "containerPort")));
  register("get_container_logs", async ({ containerId, tail }) => (await runCommand("docker", ["logs", "--tail", asOptionalString(tail) ?? "200", asString(containerId, "containerId")], { timeoutMs: 30_000 })).stdout);
  register("stream_container_logs", ({ containerId }, { emit }) => {
    const id = asString(containerId, "containerId");
    const child = spawnCommand("docker", ["logs", "-f", id]);
    child.stdout.on("data", (data) => emit("container-log", { containerId: id, line: data.toString() }));
    child.stderr.on("data", (data) => emit("container-log", { containerId: id, line: data.toString() }));
  });
  register("docker_system_prune", async ({ pruneVolumes }) => {
    const args = ["system", "prune", "-f"];
    if (asBoolean(pruneVolumes)) args.push("--volumes");
    const { stdout } = await runCommand("docker", args, { timeoutMs: 120_000 });
    const reclaimed = /Total reclaimed space:\s*([^\n]+)/.exec(stdout)?.[1] ?? "0B";
    return { containersDeleted: 0, imagesDeleted: 0, networksDeleted: 0, volumesDeleted: 0, spaceReclaimed: reclaimed };
  });
  register("get_docker_system_stats", async () => {
    const containers = await runCommand("docker", ["ps", "-a", "-q"], { timeoutMs: 10_000 }).then((r) => r.stdout.split("\n").filter(Boolean).length, () => 0);
    const running = await runCommand("docker", ["ps", "-q"], { timeoutMs: 10_000 }).then((r) => r.stdout.split("\n").filter(Boolean).length, () => 0);
    const images = await runCommand("docker", ["images", "-q"], { timeoutMs: 10_000 }).then((r) => new Set(r.stdout.split("\n").filter(Boolean)).size, () => 0);
    return { memoryUsed: 0, memoryTotal: os.totalmem(), cpus: os.cpus().length, cpuUsagePercent: 0, diskUsed: 0, diskTotal: 0, containersRunning: running, containersTotal: containers, imagesTotal: images };
  });
  register("get_orkestrator_containers", async ({}, { storage }) => {
    const environments = await storage.loadEnvironments();
    const { stdout } = await runCommand("docker", ["ps", "-a", "--no-trunc", "--filter", `label=${DOCKER_LABEL_APP}=${DOCKER_LABEL_APP_VALUE}`, "--format", "{{json .}}"], { timeoutMs: 20_000 });
    return stdout.split("\n").filter(Boolean).map((line) => {
      const row = JSON.parse(line) as Record<string, string>;
      const id = row.ID ?? "";
      const env = findEnvironmentByContainerId(environments, id);
      return { id, name: row.Names ?? "", status: row.Status ?? "", state: row.State ?? "", image: row.Image ?? "", created: 0, environmentId: env?.id ?? null, projectId: env?.projectId ?? null, isAssigned: !!env, cpuPercent: null };
    });
  });
  register("cleanup_orphaned_containers", async (_args, { storage }) => {
    const environments = await storage.loadEnvironments();
    const containers = await commands.get("list_docker_containers")?.({}, { storage, emit: () => undefined, appRoot: "", resourceRoot: "" }) as string[][];
    let removed = 0;
    for (const [containerId] of containers) {
      if (containerId && !findEnvironmentByContainerId(environments, containerId)) {
        await runCommand("docker", ["rm", "-f", containerId], { timeoutMs: 60_000 }).catch(() => undefined);
        removed += 1;
      }
    }
    return removed;
  });
  register("reattach_container", async ({ projectId, containerId, name }, { storage }) => {
    const env = createEnvironment(asString(projectId, "projectId"), { name: asOptionalString(name) ?? `reattached-${String(containerId).slice(0, 8)}` });
    env.containerId = asString(containerId, "containerId");
    env.status = await getDockerStatus(env.containerId).catch(() => "stopped");
    return storage.addEnvironment(env);
  });
  register("propagate_github_token_to_containers", async ({ newToken }, { storage }) => {
    const environments = await storage.loadEnvironments();
    const updated: string[] = [];
    const failed: [string, string][] = [];
    for (const env of environments) {
      if (!env.containerId || await getDockerStatus(env.containerId).catch(() => "stopped") !== "running") continue;
      try {
        await dockerExec(env.containerId, githubTokenPropagationCommand(asOptionalString(newToken)));
        updated.push(env.id);
      } catch (error) {
        failed.push([env.id, error instanceof Error ? error.message : String(error)]);
      }
    }
    return { updated, failed };
  });

  register("start_opencode_server", ({ containerId }) =>
    startContainerServer(asString(containerId, "containerId"), OPENCODE_SERVER_PORT, "opencode", `
      cd /workspace
      rm -f /tmp/opencode-serve.log
      source /usr/local/bin/orkestrator-runtime-env.sh 2>/dev/null || true
      orkestrator_source_runtime_env 2>/dev/null || true
      setsid opencode serve --port ${OPENCODE_SERVER_PORT} --hostname 0.0.0.0 > /tmp/opencode-serve.log 2>&1 &
    `),
  );
  register("stop_opencode_server", ({ containerId }) => dockerExec(asString(containerId, "containerId"), "pkill -f 'opencode serve' || true").then(() => undefined));
  register("get_opencode_server_status", async ({ containerId }) => {
    const id = asString(containerId, "containerId");
    const hostPort = await getHostPort(id, OPENCODE_SERVER_PORT);
    return { running: hostPort ? await checkHttpHealth(hostPort) : false, hostPort };
  });
  register("get_opencode_server_log", ({ containerId }) => dockerExec(asString(containerId, "containerId"), "cat /tmp/opencode-serve.log 2>/dev/null || true"));
  register("get_opencode_model_preferences", async () => {
    const modelPath = homePath(".local", "state", "opencode", "model.json");
    if (!await pathExists(modelPath)) return { recent: [], favorite: [], variant: {} };
    return JSON.parse(await fs.readFile(modelPath, "utf8"));
  });
  register("start_claude_server", ({ containerId }) =>
    startContainerServer(asString(containerId, "containerId"), CLAUDE_BRIDGE_PORT, "claude", `
      cd /workspace
      rm -f /tmp/claude-bridge.log
      source /usr/local/bin/orkestrator-runtime-env.sh 2>/dev/null || true
      orkestrator_source_runtime_env 2>/dev/null || true
      export PORT=${CLAUDE_BRIDGE_PORT}
      export HOSTNAME=0.0.0.0
      setsid node /opt/claude-bridge/dist/index.js > /tmp/claude-bridge.log 2>&1 &
    `),
  );
  register("stop_claude_server", ({ containerId }) => dockerExec(asString(containerId, "containerId"), "pkill -f 'claude-bridge' || true").then(() => undefined));
  register("get_claude_server_status", async ({ containerId }) => {
    const id = asString(containerId, "containerId");
    const hostPort = await getHostPort(id, CLAUDE_BRIDGE_PORT);
    return { running: hostPort ? await checkHttpHealth(hostPort) : false, hostPort };
  });
  register("get_claude_server_log", ({ containerId }) => dockerExec(asString(containerId, "containerId"), "cat /tmp/claude-bridge.log 2>/dev/null || true"));
  register("start_codex_server", ({ containerId }) =>
    startContainerServer(asString(containerId, "containerId"), CODEX_BRIDGE_PORT, "codex", `
      cd /workspace
      rm -f /tmp/codex-bridge.log
      mkdir -p /tmp/${APP_SLUG}
      source /usr/local/bin/orkestrator-runtime-env.sh 2>/dev/null || true
      orkestrator_source_runtime_env 2>/dev/null || true
      export PORT=${CODEX_BRIDGE_PORT}
      export HOSTNAME=0.0.0.0
      export CWD=/workspace
      export CODEX_PATH="$(command -v codex 2>/dev/null || echo codex)"
      setsid node /opt/codex-bridge/dist/index.js > /tmp/codex-bridge.log 2>&1 &
    `),
  );
  register("stop_codex_server", ({ containerId }) => dockerExec(asString(containerId, "containerId"), "pkill -f 'codex-bridge' || true").then(() => undefined));
  register("get_codex_server_status", async ({ containerId }) => {
    const id = asString(containerId, "containerId");
    const hostPort = await getHostPort(id, CODEX_BRIDGE_PORT);
    return { running: hostPort ? await checkHttpHealth(hostPort) : false, hostPort };
  });
  register("get_codex_server_log", ({ containerId }) => dockerExec(asString(containerId, "containerId"), "cat /tmp/codex-bridge.log 2>/dev/null || true"));

  register("has_claude_credentials", () => pathExists(homePath(".claude", ".credentials.json")).then(async (exists) => exists || pathExists(homePath(".claude.json"))));
  register("get_credential_status", async () => ({ available: await commands.get("has_claude_credentials")?.({}, { storage: null as never, emit: () => undefined, appRoot: "", resourceRoot: "" }), expiresAt: null }));
  register("check_claude_cli", () => commandExists("claude"));
  register("check_claude_config", () => pathExists(homePath(".claude.json")));
  register("check_opencode_cli", () => commandExists("opencode"));
  register("check_codex_cli", () => commandExists("codex"));
  register("check_github_cli", () => commandExists("gh"));
  register("check_any_ai_cli", async () => await commandExists("claude") || await commandExists("opencode") || await commandExists("codex"));
  register("get_available_ai_cli", async () => await commandExists("claude") ? "claude" : await commandExists("opencode") ? "opencode" : await commandExists("codex") ? "codex" : null);

  register("open_in_browser", ({ url }) => shell.openExternal(asString(url, "url")).then(() => undefined));
  register("reveal_in_file_manager", ({ path: filePath }) => shell.showItemInFolder(asString(filePath, "path")));
  register("open_in_editor", ({ containerId, editor }) => runCommand(asString(editor, "editor") === "cursor" ? "cursor" : "code", [`vscode-remote://attached-container+${Buffer.from(asString(containerId, "containerId")).toString("hex")}/workspace`]).then(() => undefined));
  register("open_local_in_editor", ({ path: filePath, editor }) => runCommand(asString(editor, "editor") === "cursor" ? "cursor" : "code", [asString(filePath, "path")]).then(() => undefined));

  register("test_domain_resolution", ({ domains }) => Promise.all(asStringArray(domains).map(async (domain) => {
    try {
      const dns = await import("node:dns/promises");
      const ips = await dns.resolve(domain);
      return { domain, valid: true, resolvable: true, ips, error: null };
    } catch (error) {
      return { domain, valid: true, resolvable: false, ips: [], error: error instanceof Error ? error.message : String(error) };
    }
  })));
  register("validate_domains", ({ domains }, context) => commands.get("test_domain_resolution")?.({ domains }, context));

  register("create_session", ({ environmentId, containerId, tabId, sessionType }, { storage }) =>
    storage.createSession(asString(environmentId, "environmentId"), asString(containerId, "containerId"), asString(tabId, "tabId"), asString(sessionType, "sessionType") as SessionType),
  );
  register("get_session", ({ sessionId }, { storage }) => storage.getSession(asString(sessionId, "sessionId")));
  register("get_sessions_by_environment", ({ environmentId }, { storage }) => storage.getSessionsByEnvironment(asString(environmentId, "environmentId")));
  register("update_session_status", ({ sessionId, status }, { storage }) => storage.updateSession(asString(sessionId, "sessionId"), { status: asString(status, "status") as SessionStatus }));
  register("update_session_activity", ({ sessionId }, { storage }) => storage.updateSession(asString(sessionId, "sessionId"), { lastActivityAt: new Date().toISOString() }));
  register("delete_session", ({ sessionId }, { storage }) => storage.removeSession(asString(sessionId, "sessionId")));
  register("delete_sessions_by_environment", ({ environmentId }, { storage }) => storage.removeSessionsByEnvironment(asString(environmentId, "environmentId")));
  register("rename_session", ({ sessionId, name }, { storage }) => storage.updateSession(asString(sessionId, "sessionId"), { name: typeof name === "string" ? name : undefined }));
  register("set_session_has_launched_command", ({ sessionId, hasLaunched }, { storage }) => storage.updateSession(asString(sessionId, "sessionId"), { hasLaunchedCommand: asBoolean(hasLaunched) }));
  register("disconnect_environment_sessions", ({ environmentId }, { storage }) => storage.disconnectEnvironmentSessions(asString(environmentId, "environmentId")));
  register("save_session_buffer", ({ sessionId, buffer }, { storage }) => storage.saveSessionBuffer(asString(sessionId, "sessionId"), asString(buffer, "buffer")));
  register("load_session_buffer", ({ sessionId }, { storage }) => storage.loadSessionBuffer(asString(sessionId, "sessionId")));
  register("sync_sessions_with_container", async ({ environmentId, containerRunning }, { storage }) => {
    const sessions = await storage.getSessionsByEnvironment(asString(environmentId, "environmentId"));
    if (!asBoolean(containerRunning)) {
      return storage.disconnectEnvironmentSessions(asString(environmentId, "environmentId"));
    }
    return sessions;
  });
  register("reorder_sessions", ({ environmentId, sessionIds }, { storage }) => storage.reorderSessions(asString(environmentId, "environmentId"), asStringArray(sessionIds)));
  register("cleanup_orphaned_buffers", (_args, { storage }) => storage.cleanupOrphanedBuffers());

  register("create_terminal_session", ({ containerId, cols, rows, user }) => {
    const id = `${asString(containerId, "containerId")}:${randomUUID()}`;
    return rememberTerminalSession(id, {
      kind: "container",
      containerId: asString(containerId, "containerId"),
      cols: asTerminalDimension(cols, 80),
      rows: asTerminalDimension(rows, 24),
      user: asOptionalString(user),
    });
  });
  register("attach_terminal", ({ containerId, cols, rows, user }, { emit }) => {
    const id = `${asString(containerId, "containerId")}:${randomUUID()}`;
    const config = {
      kind: "container" as const,
      containerId: asString(containerId, "containerId"),
      cols: asTerminalDimension(cols, 80),
      rows: asTerminalDimension(rows, 24),
      user: asOptionalString(user),
    };
    rememberTerminalSession(id, config);
    const dockerArgs = ["exec", "-it"];
    if (config.user) dockerArgs.push("--user", config.user);
    dockerArgs.push(config.containerId, "zsh", "-l");
    spawnTerminalProcess(id, "docker", dockerArgs, config, emit);
    return id;
  });
  register("start_terminal_session", ({ sessionId }, { emit }) => {
    const id = asString(sessionId, "sessionId");
    const storedConfig = terminalSessionConfigs.get(id);
    const config = storedConfig?.kind === "container" ? storedConfig : {
      kind: "container" as const,
      containerId: id.split(":")[0] ?? id,
      cols: 80,
      rows: 24,
    };
    const dockerArgs = ["exec", "-it"];
    if (config.user) dockerArgs.push("--user", config.user);
    dockerArgs.push(config.containerId, "zsh", "-l");
    spawnTerminalProcess(id, "docker", dockerArgs, config, emit);
  });
  register("terminal_write", ({ sessionId, data }) => terminalProcesses.get(asString(sessionId, "sessionId"))?.write(asString(data, "data")));
  register("terminal_resize", ({ sessionId, cols, rows }) => terminalProcesses.get(asString(sessionId, "sessionId"))?.resize(
    asTerminalDimension(cols, 80),
    asTerminalDimension(rows, 24),
  ));
  register("detach_terminal", ({ sessionId }) => {
    terminalProcesses.get(asString(sessionId, "sessionId"))?.kill();
    cleanupTerminalSession(asString(sessionId, "sessionId"));
  });
  register("list_terminal_sessions", () => Array.from(terminalProcesses.keys()));
  register("get_terminal_session", ({ sessionId }) => ({ id: asString(sessionId, "sessionId"), running: terminalProcesses.has(asString(sessionId, "sessionId")) }));

  register("create_local_terminal_session", ({ environmentId, cols, rows }) => {
    const id = `${asString(environmentId, "environmentId")}:${randomUUID()}`;
    return rememberTerminalSession(id, {
      kind: "local",
      environmentId: asString(environmentId, "environmentId"),
      cols: asTerminalDimension(cols, 80),
      rows: asTerminalDimension(rows, 24),
    });
  });
  register("start_local_terminal_session", async ({ sessionId }, { storage, emit }) => {
    const id = asString(sessionId, "sessionId");
    const storedConfig = terminalSessionConfigs.get(id);
    const config = storedConfig?.kind === "local" ? storedConfig : {
      kind: "local" as const,
      environmentId: id.split(":")[0] ?? id,
      cols: 80,
      rows: 24,
    };
    const environmentId = config.environmentId;
    const env = await storage.getEnvironment(environmentId);
    if (!env?.worktreePath) throw new Error("Local environment worktree is not available");
    if (!await pathExists(env.worktreePath)) throw new Error(`Local environment worktree does not exist: ${env.worktreePath}`);
    spawnTerminalProcess(id, resolveLocalShellPath(), ["-l"], { cwd: env.worktreePath, cols: config.cols, rows: config.rows }, emit);
  });
  register("local_terminal_write", ({ sessionId, data }) => terminalProcesses.get(asString(sessionId, "sessionId"))?.write(asString(data, "data")));
  register("local_terminal_resize", ({ sessionId, cols, rows }) => terminalProcesses.get(asString(sessionId, "sessionId"))?.resize(
    asTerminalDimension(cols, 80),
    asTerminalDimension(rows, 24),
  ));
  register("close_local_terminal_session", ({ sessionId }) => {
    terminalProcesses.get(asString(sessionId, "sessionId"))?.kill();
    cleanupTerminalSession(asString(sessionId, "sessionId"));
  });

  register("get_local_git_status", ({ worktreePath, targetBranch }) => getLocalGitStatus(asString(worktreePath, "worktreePath"), asString(targetBranch, "targetBranch")));
  register("get_local_file_tree", ({ worktreePath }) => buildFileTree(asString(worktreePath, "worktreePath")));
  register("read_local_file", ({ worktreePath, filePath }) => readTextFile(asString(worktreePath, "worktreePath"), asString(filePath, "filePath")));
  register("read_local_file_at_branch", ({ worktreePath, filePath, branch }) =>
    readLocalFileAtBranch(asString(worktreePath, "worktreePath"), asString(filePath, "filePath"), asString(branch, "branch")),
  );
  register("read_file_base64", ({ filePath }) => readFileBase64(asString(filePath, "filePath")));
  register("write_local_file", ({ worktreePath, filePath, base64Data }) => writeFileBase64(asString(worktreePath, "worktreePath"), asString(filePath, "filePath"), asString(base64Data, "base64Data")));

  register("get_git_status", async ({ containerId, targetBranch }) => {
    const output = await dockerExec(asString(containerId, "containerId"), `git fetch origin ${quoteShell(asString(targetBranch, "targetBranch"))} >/dev/null 2>&1 || true; git diff --name-status origin/${quoteShell(asString(targetBranch, "targetBranch"))} 2>/dev/null || git diff --name-status ${quoteShell(asString(targetBranch, "targetBranch"))}`);
    return output.split("\n").filter(Boolean).map((line) => {
      const [status, filePath = ""] = line.split("\t");
      return { path: filePath, filename: path.basename(filePath), directory: path.dirname(filePath) === "." ? "" : path.dirname(filePath), additions: 0, deletions: 0, status };
    });
  });
  register("get_file_tree", async ({ containerId }) => {
    const output = await dockerExec(asString(containerId, "containerId"), "find /workspace -path /workspace/.git -prune -o -path /workspace/node_modules -prune -o -type f -printf '%P\\n' | head -5000");
    return output.split("\n").filter(Boolean).map((filePath) => ({ name: path.basename(filePath), path: filePath, isDirectory: false, extension: path.extname(filePath) }));
  });
  register("read_container_file", async ({ containerId, filePath }) => {
    const target = validateRelativeFilePath(asString(filePath, "filePath"));
    const content = await dockerExec(asString(containerId, "containerId"), `cat ${quoteShell(workspaceFilePath(target))}`);
    return { path: target, content, language: path.extname(target).slice(1) };
  });
  register("read_file_at_branch", async ({ containerId, filePath, branch }) => {
    const target = validateRelativeFilePath(asString(filePath, "filePath"));
    const content = await dockerExec(asString(containerId, "containerId"), `git show ${quoteShell(asString(branch, "branch"))}:${quoteShell(target)} 2>/dev/null || true`);
    return content ? { path: target, content, language: path.extname(target).slice(1) } : null;
  });
  register("read_container_file_base64", async ({ containerId, filePath }) => {
    const fullPath = workspaceFilePath(asString(filePath, "filePath"));
    const size = parsePositiveInteger(await dockerExec(asString(containerId, "containerId"), `stat -c %s ${quoteShell(fullPath)}`), "file size");
    if (size > MAX_BINARY_FILE_BYTES) {
      throw new Error(`File exceeds ${MAX_BINARY_FILE_BYTES} bytes: ${fullPath}`);
    }
    return (await dockerExec(asString(containerId, "containerId"), `base64 -w 0 ${quoteShell(fullPath)}`)).trim();
  });
  register("write_container_file", async ({ containerId, filePath, base64Data }) => {
    const id = asString(containerId, "containerId");
    const target = validateRelativeFilePath(asString(filePath, "filePath"));
    const fullPath = workspaceFilePath(target);
    const directory = path.posix.dirname(fullPath);
    const data = asString(base64Data, "base64Data");
    assertBase64PayloadWithinLimit(data);
    await dockerExec(id, `mkdir -p ${quoteShell(directory)}`);
    const child = spawnCommand("docker", ["exec", "-i", id, "bash", "-lc", `base64 -d > ${quoteShell(fullPath)}`]);
    child.stdin.write(data);
    child.stdin.end();
    await new Promise<void>((resolve, reject) => {
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`docker exec exited with ${code}`)));
      child.once("error", reject);
    });
    return fullPath;
  });

  register("detect_pr_local", async ({ environmentId, branch }, { storage }) => {
    const env = await storage.getEnvironment(asString(environmentId, "environmentId"));
    if (!env?.worktreePath) return null;
    const { stdout } = await runCommand("gh", ["pr", "view", "--head", asString(branch, "branch"), "--json", "url,state,mergeStateStatus"], { cwd: env.worktreePath, timeoutMs: 30_000 }).catch(() => ({ stdout: "" }));
    if (!stdout.trim()) return null;
    const pr = JSON.parse(stdout) as { url: string; state: string; mergeStateStatus?: string };
    return { url: pr.url, state: pr.state.toLowerCase(), hasMergeConflicts: pr.mergeStateStatus === "DIRTY" };
  });
  register("detect_pr", async ({ containerId, branch }) => {
    const output = await dockerExec(asString(containerId, "containerId"), `gh pr view --head ${quoteShell(asString(branch, "branch"))} --json url,state,mergeStateStatus 2>/dev/null || true`);
    if (!output.trim()) return null;
    const pr = JSON.parse(output) as { url: string; state: string; mergeStateStatus?: string };
    return { url: pr.url, state: pr.state.toLowerCase(), hasMergeConflicts: pr.mergeStateStatus === "DIRTY" };
  });
  register("merge_pr_local", async ({ environmentId, method, deleteBranch }, { storage }) => {
    const env = await storage.getEnvironment(asString(environmentId, "environmentId"));
    if (!env?.worktreePath) throw new Error("Local environment worktree is not available");
    const args = ["pr", "merge", asOptionalString(method) ? `--${asOptionalString(method)}` : "--squash"];
    if (asBoolean(deleteBranch, true)) args.push("--delete-branch");
    await runCommand("gh", args, { cwd: env.worktreePath, timeoutMs: 120_000 });
  });
  register("merge_pr", ({ containerId, method, deleteBranch }) =>
    dockerExec(asString(containerId, "containerId"), `gh pr merge --${asOptionalString(method) ?? "squash"} ${asBoolean(deleteBranch, true) ? "--delete-branch" : ""}`).then(() => undefined),
  );

  register("start_local_opencode_server_cmd", ({ environmentId }, context) => startLocalServer(asString(environmentId, "environmentId"), context, "opencode"));
  register("stop_local_opencode_server_cmd", ({ environmentId }, context) => stopLocalServer(asString(environmentId, "environmentId"), context, "opencode"));
  register("get_local_opencode_server_status", ({ environmentId }, context) => getLocalServerStatus(asString(environmentId, "environmentId"), context, "opencode"));
  register("start_local_claude_server_cmd", ({ environmentId }, context) => startLocalServer(asString(environmentId, "environmentId"), context, "claude"));
  register("stop_local_claude_server_cmd", ({ environmentId }, context) => stopLocalServer(asString(environmentId, "environmentId"), context, "claude"));
  register("get_local_claude_server_status", ({ environmentId }, context) => getLocalServerStatus(asString(environmentId, "environmentId"), context, "claude"));
  register("start_local_codex_server_cmd", ({ environmentId }, context) => startLocalServer(asString(environmentId, "environmentId"), context, "codex"));
  register("stop_local_codex_server_cmd", ({ environmentId }, context) => stopLocalServer(asString(environmentId, "environmentId"), context, "codex"));
  register("get_local_codex_server_status", ({ environmentId }, context) => getLocalServerStatus(asString(environmentId, "environmentId"), context, "codex"));
  register("cleanup_stale_local_servers_cmd", () => undefined);

  register("get_kanban_tasks", ({ projectId }, { storage }) => storage.getKanbanTasks(asString(projectId, "projectId")));
  register("add_kanban_task", ({ projectId, title, description }, { storage }) => storage.addKanbanTask(asString(projectId, "projectId"), asString(title, "title"), asString(description, "description")));
  register("update_kanban_task", ({ taskId, title, description, acceptanceCriteria, status, environmentId, buildPipelineId, prUrl, prState, prMergeCommented }, { storage }) =>
    storage.updateKanbanTask(asString(taskId, "taskId"), {
      ...(typeof title === "string" ? { title } : {}),
      ...(typeof description === "string" ? { description } : {}),
      ...(typeof acceptanceCriteria === "string" ? { acceptanceCriteria } : {}),
      ...(typeof status === "string" ? { status: status as never } : {}),
      ...(typeof environmentId === "string" ? { environmentId: environmentId || undefined } : {}),
      ...(typeof buildPipelineId === "string" ? { buildPipelineId: buildPipelineId || undefined } : {}),
      ...(typeof prUrl === "string" ? { prUrl: prUrl || undefined } : {}),
      ...(typeof prState === "string" ? { prState: prState as PrState } : {}),
      ...(typeof prMergeCommented === "boolean" ? { prMergeCommented } : {}),
    }),
  );
  register("delete_kanban_task", ({ taskId }, { storage }) => storage.deleteKanbanTask(asString(taskId, "taskId")));
  register("add_kanban_comment", ({ taskId, text }, { storage }) => storage.addKanbanComment(asString(taskId, "taskId"), asString(text, "text")));
  register("delete_kanban_comment", ({ taskId, commentId }, { storage }) => storage.deleteKanbanComment(asString(taskId, "taskId"), asString(commentId, "commentId")));
  register("add_kanban_image", ({ taskId, filename, data }, { storage }) => storage.addKanbanImage(asString(taskId, "taskId"), asString(filename, "filename"), asString(data, "data")));
  register("delete_kanban_image", ({ taskId, imageId }, { storage }) => storage.deleteKanbanImage(asString(taskId, "taskId"), asString(imageId, "imageId")));
  register("get_kanban_image_data", ({ imageId }, { storage }) => storage.getKanbanImageData(asString(imageId, "imageId")));
  register("get_project_notes", ({ projectId }, { storage }) => storage.getProjectNotes(asString(projectId, "projectId")));
  register("save_project_notes", ({ projectId, content }, { storage }) => storage.saveProjectNotes(asString(projectId, "projectId"), asString(content, "content")));

  registerTmuxBackendCommands(register);

  return commands;
}
