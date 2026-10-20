/**
 * `orkestrator --fix AGENT`: instead of starting a backend, open a coding
 * agent's interactive session with a prompt that walks the user through
 * describing an Orkestrator problem, collects the diagnostics a maintainer
 * needs, and files a GitHub issue.
 *
 * Part of the client bundle: it reads a few files to describe this machine but
 * never imports the backend, contacts a backend, or writes to the data
 * directory. The agent runs in a fresh scratch directory that holds the issue
 * draft.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdtemp, readdir, rmdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isHostVersion } from "@orkestrator/protocol/host-maintenance";
import { readApplicationLogSettings } from "@orkestrator/protocol/node/application-logging";
import {
  CLAUDE_PINNED_RUNTIME_ENV,
  OPENCODE_PINNED_RUNTIME_ENV,
} from "@orkestrator/protocol/terminal-agent-launch";
import { defaultToolchainBinDir, toolchainRootDir } from "@orkestrator/toolchain/layout";
import { CliConfigStore, defaultCliConfigDir } from "./config.js";
import { defaultDataDir } from "../../../../apps/backend/src/data-dir.js";

export const FIX_ISSUE_REPOSITORY = "orkestrator-ai/orkestrator-v2";

export type FixAgentName = "claude" | "codex" | "opencode";

interface FixAgent {
  name: FixAgentName;
  displayName: string;
  /** Arguments that open an interactive session seeded with `prompt`. */
  args(prompt: string, options: { logsDir: string | null }): string[];
  /** Environment for managed copies, including those found on PATH. */
  managedEnv?: Readonly<Record<string, string>>;
  /** Environment every copy needs. */
  env?: Readonly<Record<string, string>>;
}

export const FIX_AGENTS: readonly FixAgent[] = [
  {
    name: "claude",
    displayName: "Claude Code",
    // Only logs are pre-authorized; the data directory also holds credentials.
    // `--add-dir` is variadic, so the prompt must precede it.
    args: (prompt, { logsDir }) => [prompt, ...(logsDir ? ["--add-dir", logsDir] : [])],
    managedEnv: CLAUDE_PINNED_RUNTIME_ENV,
  },
  { name: "codex", displayName: "Codex", args: (prompt) => [prompt] },
  {
    name: "opencode",
    displayName: "OpenCode",
    args: (prompt) => ["--prompt", prompt],
    env: OPENCODE_PINNED_RUNTIME_ENV,
  },
];

const AGENT_LIST = FIX_AGENTS.map((agent) => agent.name).join(", ");

export const FIX_HELP = [
  "Usage: orkestrator --fix AGENT [--data-dir DIR]",
  "",
  "Report a problem with Orkestrator. Instead of starting Orkestrator, opens AGENT",
  `(${AGENT_LIST}) with instructions to ask you what went wrong, collect`,
  "logs and version details from this machine, and draft a GitHub issue for",
  `${FIX_ISSUE_REPOSITORY}. Nothing is filed until you approve the draft, and the`,
  "agent is told to leave Orkestrator's files and settings unchanged.",
  "",
  "The agent on PATH is used; otherwise the copy Orkestrator installed. The agent",
  "works in a new temporary directory, where it saves the draft as issue.md.",
  "",
  "Options:",
  "  --data-dir DIR    Orkestrator data directory to inspect (default: ORKESTRATOR_DATA_DIR,",
  "                    then the platform default)",
  "",
  "Examples:",
  "  orkestrator --fix claude",
  "  bunx orkestrator --fix codex",
].join("\n");

export type FixArguments =
  | { kind: "run"; agent: FixAgentName; dataDir?: string }
  | { kind: "help" }
  | { kind: "error"; message: string };

const SAFE_WORD = /^[a-z][a-z0-9-]{0,39}$/;

function describeToken(token: string): string {
  return SAFE_WORD.test(token) ? `'${token}'` : "argument";
}

/** True when the launcher should hand `argv` to `runFixProcess`. */
export function isFixInvocation(argv: readonly string[]): boolean {
  const end = argv.indexOf("--");
  return (end < 0 ? argv : argv.slice(0, end)).some(
    (token) => token === "--fix" || token.startsWith("--fix="),
  );
}

/** Parse `--fix AGENT [--data-dir DIR] [--help]`; never echoes argument values. */
export function parseFixArguments(argv: readonly string[]): FixArguments {
  const values: { fix?: string; "data-dir"?: string } = {};
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    const equals = token.indexOf("=");
    const name = token.startsWith("--") ? token.slice(2, equals > 0 ? equals : undefined) : null;
    if (name !== "fix" && name !== "data-dir") {
      return {
        kind: "error",
        message:
          name === null
            ? `Unexpected ${describeToken(token)} for --fix; usage: orkestrator --fix AGENT`
            : `Unknown option for --fix: ${describeToken(name)}`,
      };
    }
    if (values[name] !== undefined) {
      return { kind: "error", message: `--${name} may be given only once` };
    }
    let value = "";
    if (equals > 0) {
      value = token.slice(equals + 1);
    } else if (argv[index + 1] !== undefined && !argv[index + 1]!.startsWith("-")) {
      value = argv[index + 1]!;
      index += 1;
    }
    values[name] = value;
  }
  if (help) return { kind: "help" };
  if (values["data-dir"] === "") return { kind: "error", message: "Missing value for --data-dir" };
  if (!values.fix) return { kind: "error", message: `--fix needs an agent: ${AGENT_LIST}` };
  const normalized = values.fix.toLowerCase();
  const known = FIX_AGENTS.find((candidate) => candidate.name === normalized);
  if (!known) {
    return {
      kind: "error",
      message: `Unknown agent ${describeToken(normalized)} for --fix; choose ${AGENT_LIST}`,
    };
  }
  const dataDir = values["data-dir"];
  return { kind: "run", agent: known.name, ...(dataDir !== undefined ? { dataDir } : {}) };
}

export interface ResolvedFixAgent {
  agent: FixAgent;
  executable: string;
  source: "path" | "managed";
}

/** The agent on PATH (the user's own, signed-in install) first, then Orkestrator's copy. */
export function resolveFixAgent(
  name: FixAgentName,
  options: { env: NodeJS.ProcessEnv; dataDir: string },
): ResolvedFixAgent | null {
  const agent = FIX_AGENTS.find((candidate) => candidate.name === name)!;
  const onPath = Bun.which(agent.name, { PATH: options.env.PATH ?? "" });
  const managed = path.join(defaultToolchainBinDir(options.dataDir), agent.name);
  if (onPath) {
    // PATH precedence chooses the executable, not whether it needs pin protection.
    let isManaged = false;
    try {
      const root = realpathSync(toolchainRootDir(options.dataDir));
      const target = realpathSync(onPath);
      const relative = path.relative(root, target);
      isManaged =
        (!relative.startsWith(`..${path.sep}`) &&
          relative !== ".." &&
          !path.isAbsolute(relative)) ||
        (existsSync(managed) && target === realpathSync(managed));
    } catch {
      // No managed installation to compare against.
    }
    return { agent, executable: onPath, source: isManaged ? "managed" : "path" };
  }
  if (existsSync(managed)) return { agent, executable: managed, source: "managed" };
  return null;
}

export interface FixFacts {
  agent: { name: FixAgentName; displayName: string; executable: string; source: string };
  cliVersion: string;
  /** How the agent should run Orkestrator client commands. */
  cliCommand: string;
  platform: string;
  osRelease: string;
  arch: string;
  bunVersion: string;
  now: string;
  workDir: string;
  dataDir: string;
  dataDirExists: boolean;
  logsDir: string;
  debugLogging: boolean;
  recentLogs: { name: string; bytes: number; modified: string }[];
  backend: { appVersion?: string; startedAt?: string; pid?: number; running: boolean } | null;
  toolchainBinDir: string | null;
  managedGh: string | null;
  diagnosticConnection: string | null;
  desktopApp: string | null;
}

const MAX_LISTED_LOGS = 8;

async function recentLogFiles(logsDir: string): Promise<FixFacts["recentLogs"]> {
  const names = await readdir(logsDir).catch(() => [] as string[]);
  const files = await Promise.all(
    names
      .filter((name) => name.endsWith(".log"))
      .map(async (name) => {
        const info = await stat(path.join(logsDir, name)).catch(() => null);
        return info?.isFile() ? { name, bytes: info.size, modifiedMs: info.mtimeMs } : null;
      }),
  );
  return files
    .filter((file) => file !== null)
    .sort((left, right) => right.modifiedMs - left.modifiedMs)
    .slice(0, MAX_LISTED_LOGS)
    .map((file) => ({
      name: file.name,
      bytes: file.bytes,
      modified: new Date(file.modifiedMs).toISOString(),
    }));
}

function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The non-secret fields of the running backend's instance descriptor. */
function backendInstance(dataDir: string): FixFacts["backend"] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path.join(dataDir, "backend-instance.json"), "utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const pid = typeof record.pid === "number" ? record.pid : undefined;
  return {
    ...(typeof record.appVersion === "string" ? { appVersion: record.appVersion } : {}),
    ...(typeof record.startedAt === "string" ? { startedAt: record.startedAt } : {}),
    ...(pid !== undefined ? { pid } : {}),
    running: pid !== undefined && processRunning(pid),
  };
}

async function managedGhBinary(dataDir: string): Promise<string | null> {
  const activated = path.join(defaultToolchainBinDir(dataDir), "gh");
  if (existsSync(activated)) return activated;
  const latestRoot = path.join(toolchainRootDir(dataDir), "gh-latest");
  const latestVersions = await readdir(latestRoot).catch(() => [] as string[]);
  for (const version of latestVersions
    .filter(isHostVersion)
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))) {
    const candidate = path.join(latestRoot, version, "gh");
    if (existsSync(candidate)) return candidate;
  }
  const root = path.join(toolchainRootDir(dataDir), "gh");
  const versions = await readdir(root).catch(() => [] as string[]);
  for (const version of versions.sort((left, right) =>
    right.localeCompare(left, undefined, { numeric: true }),
  )) {
    const platforms = await readdir(path.join(root, version)).catch(() => [] as string[]);
    for (const platform of platforms) {
      const candidate = path.join(root, version, platform, "gh");
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Only a descriptor for this data directory establishes a local connection match. */
async function diagnosticConnection(
  dataDir: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  try {
    const descriptor = realpathSync(path.join(dataDir, "backend-instance.json"));
    const config = await new CliConfigStore(defaultCliConfigDir(env)).read();
    for (const [name, connection] of Object.entries(config.connections)) {
      if (connection.kind !== "descriptor") continue;
      try {
        if (realpathSync(connection.descriptorPath) === descriptor) return name;
      } catch {
        // A stale saved connection does not identify this installation.
      }
    }
  } catch {
    // Missing descriptors or configuration leave local evidence as the only source.
  }
  return null;
}

function desktopAppPath(home: string): string | null {
  if (process.platform !== "darwin") return null;
  for (const candidate of [
    "/Applications/OrkestratorV2.app",
    path.join(home, "Applications", "OrkestratorV2.app"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export async function collectFixFacts(options: {
  resolved: ResolvedFixAgent;
  version: string;
  dataDir: string;
  workDir: string;
  env: NodeJS.ProcessEnv;
  now?: Date;
}): Promise<FixFacts> {
  const { resolved, dataDir, env } = options;
  const logsDir = path.join(dataDir, "logs");
  const binDir = defaultToolchainBinDir(dataDir);
  return {
    agent: {
      name: resolved.agent.name,
      displayName: resolved.agent.displayName,
      executable: resolved.executable,
      source: resolved.source === "path" ? "PATH" : "Orkestrator's managed toolchain",
    },
    cliVersion: options.version,
    cliCommand: Bun.which("orkestrator", { PATH: env.PATH ?? "" })
      ? "orkestrator"
      : `bunx orkestrator@${options.version}`,
    platform: process.platform,
    osRelease: `${os.type()} ${os.release()}`,
    arch: process.arch,
    bunVersion: Bun.version,
    now: (options.now ?? new Date()).toISOString(),
    workDir: options.workDir,
    dataDir,
    dataDirExists: existsSync(dataDir),
    logsDir,
    debugLogging: readApplicationLogSettings(dataDir).enabled,
    recentLogs: await recentLogFiles(logsDir),
    backend: backendInstance(dataDir),
    toolchainBinDir: existsSync(binDir) ? binDir : null,
    managedGh: await managedGhBinary(dataDir),
    diagnosticConnection: await diagnosticConnection(dataDir, env),
    desktopApp: desktopAppPath(os.homedir()),
  };
}

function describeBackend(facts: FixFacts): string {
  const backend = facts.backend;
  if (!backend)
    return "no `backend-instance.json` (no backend has run with this data directory, or it was removed)";
  const parts = [
    backend.appVersion ? `version ${backend.appVersion}` : "version not recorded",
    backend.startedAt ? `started ${backend.startedAt}` : null,
    backend.pid !== undefined
      ? `pid ${backend.pid} ${backend.running ? "(running)" : "(not running)"}`
      : null,
  ];
  return parts.filter(Boolean).join(", ");
}

function describeLogs(facts: FixFacts): string[] {
  const state = facts.debugLogging
    ? "on"
    : "off (Settings → Debug → Save Logs for Debugging); new events are not being written";
  const lines = [`- Logs directory: ${facts.logsDir} — debug logging is ${state}`];
  if (facts.recentLogs.length === 0) {
    lines.push("- Log files: none");
  } else {
    lines.push("- Most recent log files:");
    for (const log of facts.recentLogs) {
      lines.push(`  - ${log.name} (${log.bytes} bytes, modified ${log.modified})`);
    }
  }
  return lines;
}

/** The first message the agent receives. Contains paths and versions, never file contents. */
export function buildFixPrompt(facts: FixFacts): string {
  const issue = path.join(facts.workDir, "issue.md");
  const gh = facts.managedGh
    ? `\`gh\` on PATH, or Orkestrator's copy at ${facts.managedGh}`
    : "`gh`";
  return [
    `I started you with \`orkestrator --fix ${facts.agent.name}\` because something in Orkestrator is not working for me. Help me report it to the Orkestrator maintainers. Your job is to (1) understand the problem by talking with me, (2) collect the evidence a maintainer needs from this machine, and (3) file a GitHub issue on https://github.com/${FIX_ISSUE_REPOSITORY} detailed enough that the maintainer can understand, reproduce and fix the problem without coming back to me with questions.`,
    "",
    "## About Orkestrator",
    "Orkestrator runs coding agents (Claude Code, Codex, OpenCode, Cursor, Grok Build, Pi) in isolated environments: local git worktrees or Docker containers. It is an Electron desktop app with a Bun backend. The backend can also run on its own through the `orkestrator` CLI (`orkestrator serve`, or as a launchd/systemd service) and be used from a browser or the iOS app, including from another computer over Tailscale. In that case the logs that matter are on the backend's computer.",
    "",
    "## This machine",
    `- Collected: ${facts.now}`,
    `- OS: ${facts.platform} (${facts.osRelease}), ${facts.arch}; Bun ${facts.bunVersion}`,
    `- Orkestrator CLI: ${facts.cliVersion} (run client commands as \`${facts.cliCommand} …\`)`,
    `- Desktop app: ${facts.desktopApp ?? "not found in /Applications (on Linux, or not installed)"}`,
    `- Data directory: ${facts.dataDir}${facts.dataDirExists ? "" : " (does not exist)"}`,
    `- Backend: ${describeBackend(facts)}`,
    ...describeLogs(facts),
    `- Managed agent binaries: ${facts.toolchainBinDir ?? "none installed"}`,
    `- You: ${facts.agent.displayName} from ${facts.agent.source} (${facts.agent.executable})`,
    `- Your working directory (scratch space for notes and the draft): ${facts.workDir}`,
    "",
    "## 1. Understand the problem",
    "Start with a one- or two-sentence introduction, then ask me to describe the problem in my own words. Follow up a few questions at a time, not as one long questionnaire, until you know:",
    "- what I was trying to do, what I expected, and what happened instead, with the exact error text (I can give you a screenshot path);",
    "- the steps that reproduce it, and whether it happens every time;",
    "- when it started, and whether it began after an Orkestrator update;",
    "- where it happens: desktop app, web client, iOS app or CLI; a local-worktree, Docker or remote-host environment; and which agent and model.",
    "",
    "## 2. Collect diagnostics",
    "Gather evidence yourself instead of asking me to copy it. Before each command, say in one sentence what it checks. Stay read-only: do not edit, delete, move, restart, reinstall or update anything, and do not change Orkestrator's data directory or settings. If something needs changing, explain it and let me do it.",
    "Useful sources:",
    "- Log files: `orkestrator-ai-YYYY-MM-DD.log` is the desktop app (it includes its backend's output), `orkestrator-backend-YYYY-MM-DD.log` a standalone backend; a busy day continues in `.1.log`, `.2.log`, and so on. Search around the time of the problem (errors, warnings, stack traces, the environment or session name) rather than reading whole files.",
    "- If debug logging is off or the logs predate the problem, ask me to turn on Settings → Debug → Save Logs for Debugging, reproduce the problem, and tell you when I have.",
    facts.diagnosticConnection
      ? `- Run \`${facts.cliCommand} host status --connection ${facts.diagnosticConnection}\` and \`${facts.cliCommand} connection check --connection ${facts.diagnosticConnection}\` for this installation; add \`--json\` for detail. They never start or change anything.`
      : "- No saved CLI connection was verified for this data directory. Use the local evidence above; do not run backend status commands against the saved default or change CLI configuration.",
    "- Docker environments: `docker version`, `docker ps -a`, and `docker logs --tail 200 <container>` for the affected container.",
    "- Versions: `<agent> --version` for the agents involved, `git --version`, `gh --version`; on macOS, `defaults read /Applications/OrkestratorV2.app/Contents/Info.plist CFBundleShortVersionString` for the desktop app.",
    "- `config.json` in the data directory holds settings. Read only the keys that bear on the problem.",
    "Never open credentials: `gateway-auth.json`, anything under `agent-accounts/`, the file an `authFile` field points to, `.env` files, keychains, or any other token or auth file.",
    "",
    "Then work out what is going on: tell me what you think the cause is, how confident you are, and what you ruled out. If it is clearly a problem with my setup (for example Docker is not running or an agent is not signed in), tell me how to fix it and ask whether I still want to file an issue. Name the part of Orkestrator that seems to be at fault if the evidence shows it, but do not guess source file names you have not seen.",
    "",
    "## 3. Draft the issue",
    "GitHub issues on this repository are public. In everything you put in the issue:",
    "- remove API keys, tokens, passwords, cookies, auth headers, URLs that carry credentials, and anything read from a credential file;",
    "- replace my home directory with `~`, and my username, e-mail address, hostnames, Tailscale names, IP addresses, and private repository or project names with placeholders, unless I say they can stay;",
    "- leave out my prompts, agent conversations and project source code unless I explicitly agree to include them;",
    "- keep log excerpts to the lines that matter, with their timestamps: a few dozen lines in total.",
    "",
    `Write the issue body to ${issue}, using this structure:`,
    "",
    "```markdown",
    "## Summary",
    "## Steps to reproduce",
    "## Expected behavior",
    "## Actual behavior",
    "## Environment",
    "(Orkestrator desktop, backend and CLI versions; OS and architecture; desktop, web, iOS or CLI; local, Docker or remote host; agents, models and their versions; how often it happens; first seen; whether an update caused it)",
    "## Diagnostics",
    "(log excerpts and command output in fenced code blocks, each inside <details><summary>what it is</summary> … </details>)",
    "## Analysis",
    "(likely cause, confidence, what was ruled out)",
    "## Additional context",
    "",
    `_Reported with \`orkestrator --fix ${facts.agent.name}\`._`,
    "```",
    "",
    "Choose a specific title under 80 characters that says what fails and where. Show me the title and the complete body, and ask me to approve it or ask for changes. Do not file anything until I explicitly approve.",
    "",
    "## 4. File it",
    `- If ${gh} is signed in (\`gh auth status\`), run \`gh issue create --repo ${FIX_ISSUE_REPOSITORY} --title "<title>" --body-file "${issue}"\` and give me the URL it prints. Do not add labels, assignees or milestones.`,
    `- If \`gh\` is missing, not signed in, or the command fails, give me https://github.com/${FIX_ISSUE_REPOSITORY}/issues/new and tell me to paste in the title and the contents of ${issue}.`,
    "- Screenshots and recordings cannot be attached from the command line. If I have any, tell me to drag them into the issue on GitHub once it exists.",
    "",
    "Finish by giving me the issue URL (or where the draft is saved) and telling me the maintainer may follow up on the issue.",
  ].join("\n");
}

export interface FixIo {
  env: NodeJS.ProcessEnv;
  stdout(text: string): void;
  stderr(text: string): void;
}

export type FixSpawn = (
  command: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => { exited: Promise<number>; kill(signal: NodeJS.Signals): void };

const defaultSpawn: FixSpawn = (command, options) => {
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["inherit", "inherit", "inherit"],
  });
  return {
    exited: child.exited,
    kill: (signal) => child.kill(signal),
  };
};

function failure(io: FixIo, code: string, message: string, exitCode: number): number {
  io.stderr(`error [${code}]: ${message}\n`);
  return exitCode;
}

/**
 * Run `orkestrator --fix …`. Returns the agent's exit code, or 2 for invalid
 * input and 3 when the agent is not installed.
 */
export async function runFix(
  argv: readonly string[],
  options: { version: string; io: FixIo; spawn?: FixSpawn; tmpDir?: string },
): Promise<number> {
  const { io } = options;
  const parsed = parseFixArguments(argv);
  if (parsed.kind === "help") {
    io.stdout(`${FIX_HELP}\n`);
    return 0;
  }
  if (parsed.kind === "error") {
    io.stderr(`${FIX_HELP}\n\n`);
    return failure(io, "invalid-input", parsed.message, 2);
  }

  const dataDir = path.resolve(
    parsed.dataDir ?? io.env.ORKESTRATOR_DATA_DIR ?? defaultDataDir(process.platform, io.env),
  );
  const resolved = resolveFixAgent(parsed.agent, { env: io.env, dataDir });
  if (!resolved) {
    const displayName = FIX_AGENTS.find((agent) => agent.name === parsed.agent)!.displayName;
    return failure(
      io,
      "not-found",
      `${displayName} (\`${parsed.agent}\`) is not on PATH and Orkestrator has not installed it. Install it, or pick another agent: ${AGENT_LIST}`,
      3,
    );
  }

  let workDir: string | undefined;
  try {
    workDir = await mkdtemp(path.join(options.tmpDir ?? os.tmpdir(), "orkestrator-fix-"));

    const facts = await collectFixFacts({
      resolved,
      version: options.version,
      dataDir,
      workDir,
      env: io.env,
    });
    const agent = resolved.agent;
    const env: NodeJS.ProcessEnv = {
      ...io.env,
      ...agent.env,
      ...(resolved.source === "managed" ? agent.managedEnv : {}),
    };
    io.stderr(
      `Starting ${agent.displayName} to help you report a problem with Orkestrator.\n` +
        `It works in ${workDir} and will ask before filing anything.\n\n`,
    );

    const child = (options.spawn ?? defaultSpawn)(
      [
        resolved.executable,
        ...agent.args(buildFixPrompt(facts), {
          logsDir: existsSync(facts.logsDir) ? facts.logsDir : null,
        }),
      ],
      { cwd: workDir, env },
    );
    // The agent owns the terminal: Ctrl+C is the agent's to interpret, and this
    // process must outlive it rather than orphan a TUI on the user's terminal.
    const ignore = () => {};
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    process.on("SIGINT", ignore);
    process.on("SIGTERM", forward);
    process.on("SIGHUP", forward);
    let exitCode: number;
    try {
      exitCode = await child.exited;
    } finally {
      process.off("SIGINT", ignore);
      process.off("SIGTERM", forward);
      process.off("SIGHUP", forward);
    }

    return exitCode;
  } catch {
    // Spawn errors can contain command arguments (including the whole prompt).
    return failure(io, "agent-failed", "Unable to start or complete the reporting agent", 1);
  } finally {
    if (workDir) {
      // Retain drafts on both success and failure, but remove empty scratch space.
      const remaining = await readdir(workDir).catch(() => [] as string[]);
      if (remaining.length === 0) {
        await rmdir(workDir).catch(() => {});
      } else {
        io.stderr(`\nNotes and the issue draft are in ${workDir}\n`);
      }
    }
  }
}

/** Bind the real process environment and streams. */
export function runFixProcess(argv: readonly string[], version: string): Promise<number> {
  return runFix(argv, {
    version,
    io: {
      env: process.env,
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    },
  });
}
