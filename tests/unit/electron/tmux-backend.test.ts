import { afterEach, describe, expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  agentMcpConfigJson,
  agentToolConnectionTarget,
  buildTmuxPaneUpdate,
  CAPTURE_PANE_CACHE_MS,
  CLAUDE_STATE_POLL_INTERVAL_MS,
  CLAUDE_STATE_READ_TIMEOUT_MS,
  ClaudeStatePollManager,
  claudeStateReadCommand,
  cleanupEnvironmentTmux,
  containerExecArgs,
  InteractiveTmuxTerminalManager,
  INTERACTIVE_SNAPSHOT_MAX_MS,
  INTERACTIVE_SNAPSHOT_MIN_MS,
  isDirectJsonlChild,
  isMissingTmuxSessionError,
  jsonlByMtimeFindCommand,
  listLocalJsonlByMtime,
  LIVENESS_CHECK_EVERY_TICKS,
  parseTmuxSessionNames,
  selectReapableTmuxSessions,
  tmuxSessionNamePrefix,
  newestJsonlFindCommand,
  newestJsonlInDir,
  paneHash,
  parseFreshJsonlFindOutput,
  parsePollSnapshotExecOutput,
  parsePollSnapshotOutput,
  parseTranscriptHeadOutput,
  pollSnapshotScript,
  probeThinkingDisplaySupport,
  PREVIOUS_SESSION_STAT_CONCURRENCY,
  registerTmuxBackendCommands,
  RUNTIME_ROOT_PREFIX,
  shutdownClaudeStatePolling,
  tailFromOffsetCommand,
  thinkingDisplayProbeArgs,
  thinkingDisplayProbeIndicatesSupport,
  TranscriptTail,
  transcriptContainsSessionId,
  transcriptHeadCommand,
  tmuxSessionName,
  type ExecOutput,
} from "../../../apps/backend/src/core/tmux";
import type { Environment } from "../../../apps/backend/src/core/models";
import type { CommandContext } from "../../../apps/backend/src/core/commands";

const tempDirs: string[] = [];
/** mkdtemp prefix for the fake tmux runtime; also the guard for its cleanup path. */
const RUNTIME_TEMP_PREFIX = "ork-tmux-runtime-";

test("Claude tmux agent MCP config uses Claude's mcpServers document shape", () => {
  expect(JSON.parse(agentMcpConfigJson({
    url: "http://127.0.0.1:4567/mcp",
    token: "project-token",
  }))).toEqual({
    mcpServers: {
      orkestrator: {
        type: "http",
        url: "http://127.0.0.1:4567/mcp",
        headers: {
          Authorization: "Bearer project-token",
        },
      },
    },
  });
});

test("Claude's installed parser accepts the generated agent MCP config", async () => {
  const isolatedHome = await createTempDir("ork-claude-mcp-parser-");
  const parse = (config: string) => {
    const result = spawnSync(
      "claude",
      [
        "--mcp-config",
        config,
        "--strict-mcp-config",
        "--print",
        "",
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          HOME: isolatedHome,
          CLAUDE_CONFIG_DIR: path.join(isolatedHome, ".claude"),
          ANTHROPIC_API_KEY: "",
          CLAUDE_CODE_OAUTH_TOKEN: "",
        },
      },
    );
    if (result.error) throw result.error;
    return `${result.stdout}\n${result.stderr}`;
  };

  const rejected = parse(JSON.stringify({
    orkestrator: {
      type: "http",
      url: "http://127.0.0.1:4567/mcp",
    },
  }));
  expect(rejected).toContain("Invalid MCP configuration");
  expect(rejected).toContain("mcpServers");

  const accepted = parse(agentMcpConfigJson({
    url: "http://127.0.0.1:4567/mcp",
    token: "project-token",
  }));
  expect(accepted).not.toContain("Invalid MCP configuration");
  expect(accepted).toContain("Input must be provided");
});

test("Claude tmux selects the agent tool endpoint for its execution backend", () => {
  expect(agentToolConnectionTarget("local")).toBe("host");
  expect(agentToolConnectionTarget("container")).toBe("container");
});

describe("tmux session cleanup helpers", () => {
  test("recognizes tmux's ordinary missing-session diagnostics", () => {
    for (const diagnostic of [
      "can't find session: missing",
      "no server running on /tmp/tmux-501/default",
      "failed to connect to server",
      "no sessions",
    ]) {
      expect(isMissingTmuxSessionError(diagnostic)).toBe(true);
    }
    expect(isMissingTmuxSessionError("permission denied")).toBe(false);
    expect(isMissingTmuxSessionError(new Error("unrelated failure"))).toBe(false);
  });

  test("derives stable sanitized prefixes and parses list-sessions output", () => {
    expect(tmuxSessionNamePrefix("environment/with spaces and a long suffix"))
      .toBe("orkestrator-environmentwiths-");
    expect(tmuxSessionNamePrefix("///")).toBe("orkestrator-id-");
    expect(parseTmuxSessionNames(" first \n\nsecond\r\n  third  \n"))
      .toEqual(["first", "second", "third"]);
  });

  test("selects only an environment's sessions and fails closed on a contested prefix", () => {
    const environmentId = "0123456789abcdef-target";
    const own = tmuxSessionName(environmentId, "tab-own");
    const other = tmuxSessionName("other", "tab-other");
    expect(selectReapableTmuxSessions({
      names: [other, own],
      environmentId,
      survivingEnvironmentIds: [environmentId, "other"],
    })).toEqual([own]);

    expect(selectReapableTmuxSessions({
      names: [own],
      environmentId,
      survivingEnvironmentIds: ["0123456789abcdef-survivor"],
    })).toEqual([]);
  });
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createEnvironment(worktreePath: string, environmentId: string): Environment {
  return {
    id: environmentId,
    projectId: "project-1",
    name: "tmux",
    branch: "main",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "full",
    order: 0,
    environmentType: "local",
    worktreePath,
  };
}

function encodeCwd(cwd: string): string {
  return cwd.replace(/\/+$/, "").replaceAll("/", "-");
}

async function withFakeTmuxRuntime(run: (runtime: {
  worktree: string;
  home: string;
  log: string;
  alive: string;
  environment: Environment;
  /** `${RUNTIME_ROOT_PREFIX}/<environment id>` — where the backend keeps hook state. */
  runtimeRoot: string;
}) => Promise<void>): Promise<void> {
  const root = await createTempDir(RUNTIME_TEMP_PREFIX);
  const binDir = path.join(root, "bin");
  const worktree = path.join(root, "worktree");
  const home = path.join(root, "home");
  const log = path.join(root, "tmux.log");
  const alive = path.join(root, "tmux-alive");
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(worktree, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(path.join(binDir, "tmux"), `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_TMUX_LOG"
command="$1"
all_args="$*"
session_name=''
buffer_name=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -t|-s)
      shift
      session_name="$1"
      ;;
    -b)
      shift
      buffer_name="$1"
      ;;
  esac
  shift
done
case "$command" in
  has-session)
    [ -n "$session_name" ] && [ -f "$FAKE_TMUX_ALIVE/$session_name" ] && exit 0
    exit 1
    ;;
  new-session)
    if [ "\${FAKE_TMUX_FAIL_NEW:-}" = "1" ]; then
      printf '%s\n' 'new session failed' >&2
      exit 2
    fi
    if [ -n "\${FAKE_TMUX_NEW_SESSION_BARRIER:-}" ]; then
      : > "$FAKE_TMUX_NEW_SESSION_BARRIER.started"
      while [ ! -f "$FAKE_TMUX_NEW_SESSION_BARRIER.release" ]; do
        sleep 0.01
      done
    fi
    mkdir -p "$FAKE_TMUX_ALIVE"
    if [ -n "$session_name" ]; then
      touch "$FAKE_TMUX_ALIVE/$session_name"
      printf 'bypassPermissions' > "$FAKE_TMUX_ALIVE/$session_name.mode"
    fi
    exit 0
    ;;
  kill-session)
    if [ "\${FAKE_TMUX_FAIL_KILL:-}" = "1" ]; then
      printf '%s\n' 'kill failed' >&2
      exit 2
    fi
    if [ -n "\${FAKE_TMUX_MISSING_ON_KILL:-}" ] && [ "$session_name" = "$FAKE_TMUX_MISSING_ON_KILL" ]; then
      rm -f "$FAKE_TMUX_ALIVE/$session_name" "$FAKE_TMUX_ALIVE/$session_name.mode"
      printf '%s\n' "can't find session: $session_name" >&2
      exit 1
    fi
    [ -n "$session_name" ] && rm -f "$FAKE_TMUX_ALIVE/$session_name" "$FAKE_TMUX_ALIVE/$session_name.mode"
    exit 0
    ;;
  list-sessions)
    found=0
    for candidate in "$FAKE_TMUX_ALIVE"/orkestrator-*; do
      [ -f "$candidate" ] || continue
      name="$(basename "$candidate")"
      case "$name" in
        *.mode|*.input|*.fail-capture|*.fail-send) continue ;;
      esac
      printf '%s\n' "$name"
      found=1
    done
    [ "$found" = "1" ] && exit 0
    printf '%s\n' 'no server running' >&2
    exit 1
    ;;
  capture-pane)
    if [ -n "$session_name" ] && [ -f "$FAKE_TMUX_ALIVE/$session_name.fail-capture" ]; then
      printf '%s\n' 'capture failed' >&2
      exit 1
    fi
    if [ -n "$session_name" ] && [ -f "$FAKE_TMUX_ALIVE/$session_name.mode" ]; then
      mode="$(cat "$FAKE_TMUX_ALIVE/$session_name.mode")"
      case "$mode" in
        plan) printf 'plan mode on' ;;
        bypassPermissions) printf 'bypass permissions on' ;;
        acceptEdits) printf 'edit automatically on' ;;
        auto) printf 'auto mode on' ;;
        default) printf 'ask before edits on' ;;
        dontAsk) printf "don't ask on" ;;
        selection)
          printf '%s\n' '1. Yes' '2. No' 'Enter to confirm · Esc to cancel'
          ;;
        exited) printf '[claude exited]' ;;
        *) printf 'fake snapshot' ;;
      esac
    else
      printf 'fake snapshot'
    fi
    exit 0
    ;;
  load-buffer)
    cat > "$FAKE_TMUX_ALIVE/buffer-$buffer_name"
    exit 0
    ;;
  paste-buffer)
    if [ -n "$session_name" ]; then
      cat "$FAKE_TMUX_ALIVE/buffer-$buffer_name" > "$FAKE_TMUX_ALIVE/$session_name.input"
    fi
    exit 0
    ;;
  send-keys)
    if [ -n "$session_name" ] && [ -f "$FAKE_TMUX_ALIVE/$session_name.fail-send" ]; then
      printf '%s\n' 'send failed' >&2
      exit 1
    fi
    case "$all_args" in
      *BTab*)
        mode_file="$FAKE_TMUX_ALIVE/$session_name.mode"
        if [ "$(cat "$mode_file" 2>/dev/null)" = 'plan' ]; then
          printf 'bypassPermissions' > "$mode_file"
        elif [ -f "$FAKE_TMUX_ALIVE/$session_name.auto-prompt-on-btab" ]; then
          printf 'selection' > "$mode_file"
        else
          printf 'plan' > "$mode_file"
        fi
        ;;
      *Enter*)
        input_file="$FAKE_TMUX_ALIVE/$session_name.input"
        if [ "$(cat "$input_file" 2>/dev/null)" = '/plan' ]; then
          if [ -f "$FAKE_TMUX_ALIVE/$session_name.delay-plan" ]; then
            sleep 0.25
          fi
          if [ ! -f "$FAKE_TMUX_ALIVE/$session_name.ignore-plan" ]; then
            printf 'plan' > "$FAKE_TMUX_ALIVE/$session_name.mode"
          fi
        fi
        rm -f "$input_file"
        ;;
    esac
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);
  // Mirrors the real CLI closely enough for the launch-time capability probes:
  // `--effort` is advertised by `--help`, while the thinking flags are hidden
  // and only discoverable by having an argument rejected. Options are validated
  // in argv order, the way commander does, so a probe carrying a valid
  // `--thinking` and an invalid `--thinking-display` fails on the latter.
  await fs.writeFile(path.join(binDir, "claude"), `#!/bin/sh
if [ "$1" = "--help" ]; then
  if [ "\${FAKE_CLAUDE_NO_MCP_CONFIG:-}" = "1" ]; then
    printf '%s\\n' '--session-id --resume --effort'
  else
    printf '%s\\n' '--session-id --resume --effort --mcp-config'
  fi
  exit 0
fi
while [ "$#" -gt 0 ]; do
  case "$1" in
    --thinking)
      case "$2" in
        adaptive|off) shift 2 ;;
        *)
          printf '%s\\n' "error: option '--thinking <mode>' argument '$2' is invalid. Allowed choices are adaptive, off." >&2
          exit 1
          ;;
      esac
      ;;
    --thinking-display)
      case "$2" in
        summarized|omitted) shift 2 ;;
        *)
          printf '%s\\n' "error: option '--thinking-display <display>' argument '$2' is invalid. Allowed choices are summarized, omitted." >&2
          exit 1
          ;;
      esac
      ;;
    *) shift ;;
  esac
done
printf '%s\\n' 'Claude Code test'
exit 0
`);
  await fs.chmod(path.join(binDir, "tmux"), 0o755);
  await fs.chmod(path.join(binDir, "claude"), 0o755);

  const originalPath = process.env.PATH;
  const originalHome = process.env.HOME;
  const originalTmuxLog = process.env.FAKE_TMUX_LOG;
  const originalTmuxAlive = process.env.FAKE_TMUX_ALIVE;
  const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const originalFailNew = process.env.FAKE_TMUX_FAIL_NEW;
  const originalMissingOnKill = process.env.FAKE_TMUX_MISSING_ON_KILL;
  const originalNewSessionBarrier = process.env.FAKE_TMUX_NEW_SESSION_BARRIER;
  const originalNoMcpConfig = process.env.FAKE_CLAUDE_NO_MCP_CONFIG;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  process.env.HOME = home;
  process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
  process.env.FAKE_TMUX_LOG = log;
  process.env.FAKE_TMUX_ALIVE = alive;
  // Each invocation gets its own environment id, derived from the unique mkdtemp
  // suffix. Stopping a session calls uninstallWorkspaceHooks, which removes the
  // *entire* `${RUNTIME_ROOT_PREFIX}/<id>` root rather than just its own session
  // directory — so with a fixed id one Bun worker finishing would delete a
  // concurrent worker's live session state. That root lives outside the temp dirs
  // the fake runtime owns, hence the explicit cleanup below.
  const environmentId = `env-${path.basename(root)}`;
  // Checked before anything runs, not in the finally: an unexpected id would make
  // the recursive cleanup below collapse onto the shared root, which holds real
  // user environments. Failing here also avoids masking a test's own error and
  // skipping the env-var restoration.
  if (!environmentId.startsWith(`env-${RUNTIME_TEMP_PREFIX}`)) {
    throw new Error(`unexpected tmux runtime environment id: ${environmentId}`);
  }
  const environment = createEnvironment(worktree, environmentId);
  const runtimeRoot = path.join(RUNTIME_ROOT_PREFIX, environmentId);

  try {
    await run({ worktree, home, log, alive, environment, runtimeRoot });
  } finally {
    // The happy path already removes this via claude_tmux_stop; this is the guard
    // for a test that throws before reaching it.
    await fs.rm(runtimeRoot, { recursive: true, force: true });
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalTmuxLog === undefined) delete process.env.FAKE_TMUX_LOG;
    else process.env.FAKE_TMUX_LOG = originalTmuxLog;
    if (originalTmuxAlive === undefined) delete process.env.FAKE_TMUX_ALIVE;
    else process.env.FAKE_TMUX_ALIVE = originalTmuxAlive;
    if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    if (originalFailNew === undefined) delete process.env.FAKE_TMUX_FAIL_NEW;
    else process.env.FAKE_TMUX_FAIL_NEW = originalFailNew;
    if (originalMissingOnKill === undefined) delete process.env.FAKE_TMUX_MISSING_ON_KILL;
    else process.env.FAKE_TMUX_MISSING_ON_KILL = originalMissingOnKill;
    if (originalNewSessionBarrier === undefined) {
      delete process.env.FAKE_TMUX_NEW_SESSION_BARRIER;
    } else {
      process.env.FAKE_TMUX_NEW_SESSION_BARRIER = originalNewSessionBarrier;
    }
    if (originalNoMcpConfig === undefined) delete process.env.FAKE_CLAUDE_NO_MCP_CONFIG;
    else process.env.FAKE_CLAUDE_NO_MCP_CONFIG = originalNoMcpConfig;
  }
}

async function withFakeContainerTmuxRuntime(run: (runtime: {
  worktree: string;
  log: string;
  alive: string;
  environment: Environment;
  runtimeRoot: string;
}) => Promise<void>): Promise<void> {
  const root = await createTempDir(`${RUNTIME_TEMP_PREFIX}container-`);
  const binDir = path.join(root, "bin");
  const worktree = path.join(root, "workspace");
  const log = path.join(root, "docker.log");
  const alive = path.join(root, "tmux-alive");
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(worktree, { recursive: true });
  await fs.writeFile(path.join(binDir, "docker"), `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, \`\${args.join(" ")}\\n\`);

const worktree = process.env.FAKE_CONTAINER_WORKTREE;
const aliveDir = process.env.FAKE_TMUX_ALIVE;

function mapPath(value) {
  if (value === "/workspace") return worktree;
  if (value.startsWith("/workspace/")) {
    return path.join(worktree, value.slice("/workspace/".length));
  }
  return value;
}

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

async function main() {
  if (args[0] !== "exec") return;
  let index = 1;
  let withStdin = false;
  while (index < args.length && args[index].startsWith("-")) {
    if (args[index] === "-i") {
      withStdin = true;
      index += 1;
      continue;
    }
    if (args[index] === "-u" || args[index] === "-w") {
      index += 2;
      continue;
    }
    index += 1;
  }
  index += 1; // container id
  const command = args[index++];
  const commandArgs = args.slice(index);
  const stdin = withStdin ? await readStdin() : "";
  const executable = command ? path.basename(command) : "";

  switch (executable || command) {
    case "mkdir": {
      for (const value of commandArgs.filter((entry) => !entry.startsWith("-"))) {
        fs.mkdirSync(mapPath(value), { recursive: true });
      }
      return;
    }
    case "rm": {
      for (const value of commandArgs.filter((entry) => !entry.startsWith("-"))) {
        fs.rmSync(mapPath(value), { recursive: true, force: true });
      }
      return;
    }
    case "chmod": {
      const mode = commandArgs[0];
      const target = mapPath(commandArgs[1]);
      if (mode === "+x") {
        const current = fs.statSync(target).mode & 0o777;
        fs.chmodSync(target, current | 0o111);
      } else {
        fs.chmodSync(target, Number.parseInt(mode, 8));
      }
      return;
    }
    case "test": {
      const mode = commandArgs[0];
      const target = mapPath(commandArgs[1]);
      try {
        const stats = fs.statSync(target);
        if (mode === "-f" && stats.isFile()) return;
        if (mode === "-x" && (stats.mode & 0o111) !== 0) return;
      } catch {}
      process.exitCode = 1;
      return;
    }
    case "cat": {
      process.stdout.write(fs.readFileSync(mapPath(commandArgs[0]), "utf8"));
      return;
    }
    case "which": {
      process.stdout.write(\`/usr/bin/\${commandArgs[0]}\\n\`);
      return;
    }
    case "bash": {
      return;
    }
    case "claude": {
      if (commandArgs[0] === "--help") {
        process.stdout.write(
          process.env.FAKE_CLAUDE_NO_MCP_CONFIG === "1"
            ? "--session-id --resume --effort\\n"
            : "--session-id --resume --effort --mcp-config\\n",
        );
        return;
      }
      if (commandArgs[0] === "--version") {
        process.stdout.write("Claude Code test\\n");
        return;
      }
      for (let i = 0; i < commandArgs.length; i += 1) {
        if (commandArgs[i] === "--thinking") {
          const value = commandArgs[i + 1];
          if (value !== "adaptive" && value !== "off") {
            process.stderr.write(
              \`error: option '--thinking <mode>' argument '\${value}' is invalid. Allowed choices are adaptive, off.\\n\`,
            );
            process.exitCode = 1;
            return;
          }
          i += 1;
          continue;
        }
        if (commandArgs[i] === "--thinking-display") {
          const value = commandArgs[i + 1];
          if (value !== "summarized" && value !== "omitted") {
            process.stderr.write(
              \`error: option '--thinking-display <display>' argument '\${value}' is invalid. Allowed choices are summarized, omitted.\\n\`,
            );
            process.exitCode = 1;
            return;
          }
          i += 1;
        }
      }
      process.stdout.write("Claude Code test\\n");
      return;
    }
    case "tmux": {
      const tmuxCommand = commandArgs[0];
      let sessionName = "";
      for (let i = 0; i < commandArgs.length; i += 1) {
        if (commandArgs[i] === "-t" || commandArgs[i] === "-s") {
          sessionName = commandArgs[i + 1] ?? "";
          i += 1;
        }
      }
      const sessionPath = path.join(aliveDir, sessionName);
      if (tmuxCommand === "has-session") {
        if (sessionName && fs.existsSync(sessionPath)) return;
        process.exitCode = 1;
        return;
      }
      if (tmuxCommand === "new-session") {
        fs.mkdirSync(aliveDir, { recursive: true });
        if (sessionName) fs.writeFileSync(sessionPath, "");
        return;
      }
      if (tmuxCommand === "kill-session") {
        fs.rmSync(sessionPath, { force: true });
        return;
      }
      return;
    }
    case "sh": {
      const script = commandArgs[1] ?? "";
      if (script.startsWith("cat > ")) {
        const destination = script.slice("cat > ".length).trim().replace(/^'/, "").replace(/'$/, "");
        const mappedDestination = mapPath(destination);
        ensureParent(mappedDestination);
        fs.writeFileSync(mappedDestination, stdin);
        return;
      }
      if (script.includes('stat -c %a "$tmp"') && script.includes('mv -f "$tmp"')) {
        const tmpPath = script.match(/tmp='([^']+)'/)?.[1];
        const finalPath = script.match(/mv -f "\\$tmp" '([^']+)'/)?.[1];
        if (!tmpPath || !finalPath) {
          process.stderr.write("could not parse secure write script\\n");
          process.exitCode = 1;
          return;
        }
        const mappedTmp = mapPath(tmpPath);
        const mappedFinal = mapPath(finalPath);
        ensureParent(mappedTmp);
        ensureParent(mappedFinal);
        fs.writeFileSync(mappedTmp, stdin, { mode: 0o600 });
        fs.chmodSync(mappedTmp, 0o600);
        fs.renameSync(mappedTmp, mappedFinal);
        fs.chmodSync(mappedFinal, 0o600);
        return;
      }
      return;
    }
    default:
      return;
  }
}

main().catch((error) => {
  process.stderr.write(String(error.stack || error));
  process.exitCode = 1;
});
`);
  await fs.chmod(path.join(binDir, "docker"), 0o755);

  const originalPath = process.env.PATH;
  const originalDockerLog = process.env.FAKE_DOCKER_LOG;
  const originalTmuxAlive = process.env.FAKE_TMUX_ALIVE;
  const originalContainerWorktree = process.env.FAKE_CONTAINER_WORKTREE;
  const originalNoMcpConfig = process.env.FAKE_CLAUDE_NO_MCP_CONFIG;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  process.env.FAKE_DOCKER_LOG = log;
  process.env.FAKE_TMUX_ALIVE = alive;
  process.env.FAKE_CONTAINER_WORKTREE = worktree;
  const environmentId = `env-${path.basename(root)}`;
  if (!environmentId.startsWith(`env-${RUNTIME_TEMP_PREFIX}`)) {
    throw new Error(`unexpected tmux runtime environment id: ${environmentId}`);
  }
  const environment: Environment = {
    id: environmentId,
    projectId: "project-1",
    name: "tmux-container",
    branch: "main",
    containerId: "container-testing",
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "containerized",
    worktreePath: null,
  };
  const runtimeRoot = path.join(RUNTIME_ROOT_PREFIX, environmentId);

  try {
    await run({ worktree, log, alive, environment, runtimeRoot });
  } finally {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalDockerLog === undefined) delete process.env.FAKE_DOCKER_LOG;
    else process.env.FAKE_DOCKER_LOG = originalDockerLog;
    if (originalTmuxAlive === undefined) delete process.env.FAKE_TMUX_ALIVE;
    else process.env.FAKE_TMUX_ALIVE = originalTmuxAlive;
    if (originalContainerWorktree === undefined) delete process.env.FAKE_CONTAINER_WORKTREE;
    else process.env.FAKE_CONTAINER_WORKTREE = originalContainerWorktree;
    if (originalNoMcpConfig === undefined) delete process.env.FAKE_CLAUDE_NO_MCP_CONFIG;
    else process.env.FAKE_CLAUDE_NO_MCP_CONFIG = originalNoMcpConfig;
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function createHandlers() {
  const handlers = new Map<string, (args: Record<string, unknown>, context: unknown) => unknown>();
  registerTmuxBackendCommands((name, handler) => {
    handlers.set(name, handler as (args: Record<string, unknown>, context: unknown) => unknown);
  });
  return handlers;
}

async function invoke(
  handlers: Map<string, (args: Record<string, unknown>, context: unknown) => unknown>,
  name: string,
  args: Record<string, unknown>,
  contextOverrides: Record<string, unknown> = {},
): Promise<unknown> {
  const handler = handlers.get(name);
  if (!handler) throw new Error(`missing handler: ${name}`);
  return await handler(args, {
    storage: {},
    emit: () => undefined,
    appRoot: "",
    resourceRoot: "",
    ...contextOverrides,
  });
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error("timed out waiting for condition");
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("Electron tmux backend command registration", () => {
  test("registers the tmux command surface", () => {
    const handlers = createHandlers();

    for (const name of [
      "claude_tmux_start",
      "claude_tmux_stop",
      "claude_tmux_interrupt",
      "claude_tmux_status",
      "claude_tmux_transcript",
      "claude_tmux_tasks",
      "claude_tmux_pending_hooks",
      "claude_tmux_create_interactive_terminal",
      "claude_tmux_start_interactive_terminal",
      "claude_tmux_write_interactive_terminal",
      "claude_tmux_resize_interactive_terminal",
      "claude_tmux_detach_interactive_terminal",
      "claude_tmux_send_text",
      "claude_tmux_send_keys",
      "claude_tmux_submit",
      "claude_tmux_switch_model",
      "claude_tmux_switch_effort",
      "claude_tmux_switch_plan_mode",
      "claude_tmux_capture_pane",
      "claude_tmux_resize",
      "claude_tmux_answer_pre_tool_use",
      "claude_tmux_reply_hook",
      "claude_tmux_list_previous_sessions",
      "start_claude_state_polling",
      "stop_claude_state_polling",
    ]) {
      expect(handlers.has(name)).toBe(true);
    }
  });

  test("writes an owner-only agent MCP config and includes it in a local Claude launch", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, runtimeRoot, log }) => {
      const connectionCalls: Array<{
        environmentId: string;
        projectId: string;
        target: "host" | "container";
      }> = [];
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
        agentTools: {
          connection: (
            environmentId: string,
            projectId: string,
            target: "host" | "container",
          ) => {
            connectionCalls.push({ environmentId, projectId, target });
            return {
              url: "http://127.0.0.1:4567/mcp",
              token: "scoped-project-token",
            };
          },
          revokeEnvironment: () => undefined,
        },
      };

      await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-agent-mcp", environmentId: environment.id },
        context,
      );

      expect(connectionCalls).toEqual([{
        environmentId: environment.id,
        projectId: environment.projectId,
        target: "host",
      }]);
      const configPath = path.join(runtimeRoot, "agent-mcp.json");
      expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual({
        mcpServers: {
          orkestrator: {
            type: "http",
            url: "http://127.0.0.1:4567/mcp",
            headers: { Authorization: "Bearer scoped-project-token" },
          },
        },
      });
      expect(await fs.readFile(log, "utf8")).toContain(
        `--mcp-config '${configPath}'`,
      );

      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: "tab-agent-mcp", environmentId: environment.id },
        context,
      );
      await expect(fs.stat(configPath)).rejects.toThrow();
    });
  });

  test("does not create an agent MCP config when Claude lacks the launch flag", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, runtimeRoot, log }) => {
      process.env.FAKE_CLAUDE_NO_MCP_CONFIG = "1";
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
        agentTools: {
          connection: () => {
            throw new Error("connection must not be requested");
          },
          revokeEnvironment: () => undefined,
        },
      };

      await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-no-mcp-flag", environmentId: environment.id },
        context,
      );

      await expect(fs.stat(path.join(runtimeRoot, "agent-mcp.json"))).rejects.toThrow();
      expect(await fs.readFile(log, "utf8")).not.toContain("--mcp-config");
      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: "tab-no-mcp-flag", environmentId: environment.id },
        context,
      );
    });
  });

  test("skips agent MCP injection if the environment disappears during launch", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, runtimeRoot, log }) => {
      let environmentReads = 0;
      const context = {
        storage: {
          getEnvironment: async () => {
            environmentReads += 1;
            return environmentReads < 3 ? environment : undefined;
          },
        },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
        agentTools: {
          connection: () => {
            throw new Error("connection must not be requested");
          },
          revokeEnvironment: () => undefined,
        },
      };

      await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-vanished-agent-env", environmentId: environment.id },
        context,
      );

      await expect(fs.stat(path.join(runtimeRoot, "agent-mcp.json"))).rejects.toThrow();
      expect(await fs.readFile(log, "utf8")).not.toContain("--mcp-config");
      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: "tab-vanished-agent-env", environmentId: environment.id },
        context,
      );
    });
  });

  test("cleans the private temporary file and fails closed when config replacement fails", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, runtimeRoot, log }) => {
      const configPath = path.join(runtimeRoot, "agent-mcp.json");
      await fs.mkdir(configPath, { recursive: true });
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
        agentTools: {
          connection: () => ({
            url: "http://127.0.0.1:4567/mcp",
            token: "scoped-project-token",
          }),
          revokeEnvironment: () => undefined,
        },
      };

      await expect(invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-agent-config-write-failure", environmentId: environment.id },
        context,
      )).rejects.toThrow();

      expect((await fs.stat(configPath)).isDirectory()).toBe(true);
      expect(
        (await fs.readdir(runtimeRoot)).filter((name) =>
          name.startsWith("agent-mcp.json.") && name.endsWith(".tmp")
        ),
      ).toEqual([]);
      expect(await fs.readFile(log, "utf8")).not.toContain("new-session ");
      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: "tab-agent-config-write-failure", environmentId: environment.id },
        context,
      );
    });
  });

  test("removes the bearer config when tmux rejects the Claude launch", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, runtimeRoot }) => {
      process.env.FAKE_TMUX_FAIL_NEW = "1";
      const configPath = path.join(runtimeRoot, "agent-mcp.json");
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
        agentTools: {
          connection: () => ({
            url: "http://127.0.0.1:4567/mcp",
            token: "scoped-project-token",
          }),
          revokeEnvironment: () => undefined,
        },
      };

      await expect(invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-agent-launch-failure", environmentId: environment.id },
        context,
      )).rejects.toThrow("tmux new-session failed");

      await expect(fs.stat(configPath)).rejects.toThrow();
      expect(
        (await fs.readdir(runtimeRoot)).filter((name) =>
          name.startsWith("agent-mcp.json.") && name.endsWith(".tmp")
        ),
      ).toEqual([]);
      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: "tab-agent-launch-failure", environmentId: environment.id },
        context,
      );
    });
  });

  test("writes the agent MCP config securely for container-backed Claude sessions", async () => {
    const handlers = createHandlers();

    await withFakeContainerTmuxRuntime(async ({ environment, runtimeRoot, log, worktree }) => {
      const connectionCalls: Array<{
        environmentId: string;
        projectId: string;
        target: "host" | "container";
      }> = [];
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
        agentTools: {
          connection: (
            environmentId: string,
            projectId: string,
            target: "host" | "container",
          ) => {
            connectionCalls.push({ environmentId, projectId, target });
            return {
              url: "http://host.docker.internal:4567/mcp",
              token: "container-project-token",
            };
          },
          revokeEnvironment: () => undefined,
        },
      };

      await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-container-agent-mcp", environmentId: environment.id },
        context,
      );

      expect(connectionCalls).toEqual([{
        environmentId: environment.id,
        projectId: environment.projectId,
        target: "container",
      }]);
      const configPath = path.join(runtimeRoot, "agent-mcp.json");
      expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual({
        mcpServers: {
          orkestrator: {
            type: "http",
            url: "http://host.docker.internal:4567/mcp",
            headers: { Authorization: "Bearer container-project-token" },
          },
        },
      });
      expect(
        JSON.parse(
          await fs.readFile(
            path.join(worktree, ".claude", "settings.local.json"),
            "utf8",
          ),
        ),
      ).toHaveProperty("hooks");

      const dockerLog = await fs.readFile(log, "utf8");
      expect(dockerLog).toContain('stat -c %a "$tmp"');
      expect(dockerLog).toContain(`--mcp-config '${configPath}'`);

      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: "tab-container-agent-mcp", environmentId: environment.id },
        context,
      );
      await expect(fs.stat(configPath)).rejects.toThrow();
    });
  });

  test("keeps missing-session behavior compatible with the backend tmux commands", async () => {
    const handlers = createHandlers();
    const args = { tabId: "tab-missing", environmentId: "env-missing" };

    await expect(invoke(handlers, "claude_tmux_status", args)).resolves.toBeNull();
    await expect(invoke(handlers, "claude_tmux_stop", args)).resolves.toBeUndefined();
    await expect(invoke(handlers, "claude_tmux_interrupt", args)).rejects.toThrow("tmux session not running");
    await expect(invoke(handlers, "claude_tmux_pending_hooks", args)).rejects.toThrow("tmux session not running");
    await expect(invoke(handlers, "claude_tmux_tasks", args)).rejects.toThrow("tmux session not running");
    await expect(invoke(handlers, "claude_tmux_detach_interactive_terminal", { terminalSessionId: "missing" })).resolves.toBeUndefined();
  });

  test("names generated tab ids without tmux session collisions", () => {
    const first = tmuxSessionName("env-local", "tab-1782973296000-1");
    const second = tmuxSessionName("env-local", "tab-1782973296000-2");

    expect(first).not.toBe(second);
    expect(first.startsWith("orkestrator-env-local-tab-178297329600-")).toBe(true);
    expect(second.startsWith("orkestrator-env-local-tab-178297329600-")).toBe(true);
  });

  test("starts separate tmux sessions for generated tab ids with the same old prefix", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, log }) => {
      const context = {
        storage: {
          getEnvironment: async () => environment,
        },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };

      const first = await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-1782973296000-1", environmentId: environment.id },
        context,
      ) as { tmux_session: string; running: boolean };
      const second = await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-1782973296000-2", environmentId: environment.id },
        context,
      ) as { tmux_session: string; running: boolean };

      expect(first.running).toBe(true);
      expect(second.running).toBe(true);
      expect(first.tmux_session).not.toBe(second.tmux_session);

      const tmuxLog = await fs.readFile(log, "utf8");
      const newSessionLines = tmuxLog
        .split("\n")
        .filter((line) => line.startsWith("new-session "));
      expect(newSessionLines).toHaveLength(2);
      expect(newSessionLines[0]).toContain(first.tmux_session);
      expect(newSessionLines[1]).toContain(second.tmux_session);

      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: "tab-1782973296000-1", environmentId: environment.id },
        context,
      );
      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: "tab-1782973296000-2", environmentId: environment.id },
        context,
      );
    });
  });

  test("attaches duplicate client starts to one tmux session unless replacement is explicit", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, log }) => {
      const events: Array<Record<string, unknown>> = [];
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: (_event: string, payload: unknown) => {
          if (payload && typeof payload === "object") {
            events.push(payload as Record<string, unknown>);
          }
        },
        appRoot: "",
        resourceRoot: "",
      };
      const args = {
        tabId: "startup-agent",
        environmentId: environment.id,
        initialPrompt: "Inspect the workspace",
      };

      const first = await invoke(
        handlers,
        "claude_tmux_start",
        args,
        context,
      ) as { session_id: string };
      const attached = await invoke(
        handlers,
        "claude_tmux_start",
        args,
        context,
      ) as { session_id: string };

      expect(attached.session_id).toBe(first.session_id);
      await waitFor(() =>
        events.some((event) =>
          event.kind === "initial-prompt-sent"
          && event.session_id === first.session_id
        ),
      );
      let tmuxLog = await fs.readFile(log, "utf8");
      expect(
        tmuxLog.split("\n").filter((line) => line.startsWith("new-session ")),
      ).toHaveLength(1);
      expect(
        tmuxLog.split("\n").filter((line) => line.startsWith("paste-buffer ")),
      ).toHaveLength(1);
      expect(tmuxLog).not.toContain("kill-session");

      const replaced = await invoke(
        handlers,
        "claude_tmux_start",
        { ...args, initialPrompt: undefined, replaceExisting: true },
        context,
      ) as { session_id: string };
      expect(replaced.session_id).not.toBe(first.session_id);
      tmuxLog = await fs.readFile(log, "utf8");
      expect(
        tmuxLog.split("\n").filter((line) => line.startsWith("new-session ")),
      ).toHaveLength(2);
      expect(tmuxLog).toContain("kill-session");

      await invoke(handlers, "claude_tmux_stop", args, context);
    });
  });

  test("serializes stop behind an in-flight start so no tmux session is orphaned", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, log, alive }) => {
      const barrier = `${log}.new-session`;
      process.env.FAKE_TMUX_NEW_SESSION_BARRIER = barrier;
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };
      const args = {
        tabId: "concurrent-start-stop",
        environmentId: environment.id,
      };

      const start = invoke(handlers, "claude_tmux_start", args, context) as Promise<{
        tmux_session: string;
      }>;
      await waitFor(() => existsSync(`${barrier}.started`));

      let stopSettled = false;
      const stop = invoke(handlers, "claude_tmux_stop", args, context)
        .finally(() => {
          stopSettled = true;
        });
      await delay(75);
      const settledBeforeStartReleased = stopSettled;
      await fs.writeFile(`${barrier}.release`, "");

      const started = await start;
      await stop;

      expect(settledBeforeStartReleased).toBe(false);
      expect(existsSync(path.join(alive, started.tmux_session))).toBe(false);
      await expect(
        invoke(handlers, "claude_tmux_status", args, context),
      ).resolves.toBeNull();
    });
  });

  // Pins the runtime root against production. The cleanup in withFakeTmuxRuntime
  // uses `force: true`, so it silently succeeds against a wrong path — without
  // this test a change to RUNTIME_ROOT_PREFIX would leave every run leaking hook
  // state into /tmp with nothing failing.
  test("keeps per-environment hook state under the shared runtime root and removes it on stop", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, runtimeRoot }) => {
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };

      expect(runtimeRoot).toBe(path.join(RUNTIME_ROOT_PREFIX, environment.id));
      await expect(fs.stat(runtimeRoot)).rejects.toThrow();

      const status = await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-runtime-root", environmentId: environment.id },
        context,
      ) as { session_id: string };

      expect((await fs.stat(runtimeRoot)).isDirectory()).toBe(true);
      expect(
        (await fs.stat(path.join(runtimeRoot, "sessions", status.session_id))).isDirectory(),
      ).toBe(true);

      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: "tab-runtime-root", environmentId: environment.id },
        context,
      );

      // Stopping the last session tears the whole root down. That is exactly why
      // two concurrent runs must not share an environment id.
      await expect(fs.stat(runtimeRoot)).rejects.toThrow();
    });
  });

  test("environment teardown kills live sessions, restores settings and removes the runtime root", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, worktree, alive, log, runtimeRoot }) => {
      const settingsPath = path.join(worktree, ".claude", "settings.local.json");
      const original = JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }, null, 2);
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(settingsPath, original);

      const context = {
        storage: {
          getEnvironment: async () => environment,
          loadEnvironments: async () => [environment],
        },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };

      const started = await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-teardown", environmentId: environment.id },
        context,
      ) as { tmux_session: string; running: boolean };

      expect(started.running).toBe(true);
      // tmux mode has taken the settings file over by now.
      expect(await fs.readFile(settingsPath, "utf8")).not.toBe(original);

      // Deleting the environment goes through this, not `claude_tmux_stop`.
      await cleanupEnvironmentTmux(environment.id, context as unknown as CommandContext);

      expect(await fs.readFile(settingsPath, "utf8")).toBe(original);
      await expect(fs.stat(runtimeRoot)).rejects.toThrow();
      // The fake tmux drops the alive marker on kill-session.
      expect(existsSync(path.join(alive, started.tmux_session))).toBe(false);
      expect(await fs.readFile(log, "utf8")).toContain(
        `kill-session -t ${started.tmux_session}`,
      );

      // The session is forgotten too, so a later command cannot drive a dead tab.
      await expect(
        invoke(handlers, "claude_tmux_capture_pane", {
          tabId: "tab-teardown",
          environmentId: environment.id,
        }, context),
      ).rejects.toThrow("tmux session not running");
    });
  });

  test("environment teardown survives a backend it cannot reach", async () => {
    await withFakeTmuxRuntime(async ({ environment }) => {
      // A container environment whose container id is already gone: there is
      // nothing to exec into, and deletion must not be blocked by that.
      const unreachable = { ...environment, environmentType: "container" as const, containerId: null };
      const context = {
        storage: {
          getEnvironment: async () => unreachable,
          loadEnvironments: async () => [unreachable],
        },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };

      await expect(
        cleanupEnvironmentTmux(unreachable.id, context as unknown as CommandContext),
      ).resolves.toBeUndefined();
    });
  });

  test("environment teardown fails closed when a surviving environment contests the tmux prefix", async () => {
    await withFakeTmuxRuntime(async ({ environment, alive, log }) => {
      const orphanName = tmuxSessionName(environment.id, "orphan-contested");
      await fs.mkdir(alive, { recursive: true });
      await fs.writeFile(path.join(alive, orphanName), "");
      const collidingEnvironment = {
        ...environment,
        id: `${environment.id.slice(0, 16)}-survivor`,
      };
      const context = {
        storage: {
          getEnvironment: async () => environment,
          loadEnvironments: async () => [environment, collidingEnvironment],
        },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };

      await cleanupEnvironmentTmux(
        environment.id,
        context as unknown as CommandContext,
      );

      expect(existsSync(path.join(alive, orphanName))).toBe(true);
      expect(await fs.readFile(log, "utf8")).not.toContain(
        `kill-session -t ${orphanName}`,
      );
      await fs.rm(path.join(alive, orphanName), { force: true });
    });
  });

  test("environment teardown accepts a session disappearing after list-sessions", async () => {
    await withFakeTmuxRuntime(async ({ environment, alive, runtimeRoot }) => {
      const orphanName = tmuxSessionName(environment.id, "orphan-race");
      await fs.mkdir(alive, { recursive: true });
      await fs.mkdir(runtimeRoot, { recursive: true });
      await fs.writeFile(path.join(alive, orphanName), "");
      process.env.FAKE_TMUX_MISSING_ON_KILL = orphanName;
      const context = {
        storage: {
          getEnvironment: async () => environment,
          loadEnvironments: async () => [environment],
        },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };

      await expect(cleanupEnvironmentTmux(
        environment.id,
        context as unknown as CommandContext,
      )).resolves.toBeUndefined();
      expect(existsSync(path.join(alive, orphanName))).toBe(false);
      await expect(fs.stat(runtimeRoot)).rejects.toThrow();
    });
  });

  test("a start queued behind environment teardown rejects the deletion tombstone", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, log }) => {
      let storedEnvironment: Environment = environment;
      const loadGate = deferred<Environment[]>();
      let loadStarted = false;
      const context = {
        storage: {
          getEnvironment: async () => storedEnvironment,
          loadEnvironments: async () => {
            loadStarted = true;
            return loadGate.promise;
          },
        },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };

      await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-delete-race", environmentId: environment.id },
        context,
      );

      const cleanup = cleanupEnvironmentTmux(
        environment.id,
        context as unknown as CommandContext,
      );
      await waitFor(() => loadStarted);

      storedEnvironment = {
        ...environment,
        deletionRequestedAt: new Date().toISOString(),
      };
      const queuedStart = invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-after-delete", environmentId: environment.id },
        context,
      );
      const queuedStartOutcome = queuedStart.then(
        () => ({ error: null as Error | null }),
        (error: unknown) => ({
          error: error instanceof Error ? error : new Error(String(error)),
        }),
      );
      loadGate.resolve([storedEnvironment]);

      await expect(cleanup).resolves.toBeUndefined();
      expect((await queuedStartOutcome).error?.message).toContain(
        "is being deleted",
      );
      expect(await fs.readFile(log, "utf8")).not.toContain(
        tmuxSessionName(environment.id, "tab-after-delete"),
      );
    });
  });

  test("environment teardown detaches active interactive terminal polling", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment }) => {
      const context = {
        storage: {
          getEnvironment: async () => environment,
          loadEnvironments: async () => [environment],
        },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };
      await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-interactive-cleanup", environmentId: environment.id },
        context,
      );
      const terminalSessionId = await invoke(
        handlers,
        "claude_tmux_create_interactive_terminal",
        {
          tabId: "tab-interactive-cleanup",
          environmentId: environment.id,
          cols: 120,
          rows: 40,
        },
        context,
      ) as string;
      await invoke(
        handlers,
        "claude_tmux_start_interactive_terminal",
        { terminalSessionId },
        context,
      );

      await cleanupEnvironmentTmux(
        environment.id,
        context as unknown as CommandContext,
      );

      await expect(
        invoke(
          handlers,
          "claude_tmux_write_interactive_terminal",
          { terminalSessionId, data: "after-delete" },
          context,
        ),
      ).rejects.toThrow("interactive terminal session not found");
    });
  });

  test("environment teardown preserves its runtime root when tmux killing fails", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, runtimeRoot }) => {
      const context = {
        storage: {
          getEnvironment: async () => environment,
          loadEnvironments: async () => [environment],
        },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };
      await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-kill-retry", environmentId: environment.id },
        context,
      );

      const originalFailKill = process.env.FAKE_TMUX_FAIL_KILL;
      process.env.FAKE_TMUX_FAIL_KILL = "1";
      try {
        await expect(
          cleanupEnvironmentTmux(
            environment.id,
            context as unknown as CommandContext,
          ),
        ).rejects.toThrow("cleanup incomplete");
        expect((await fs.stat(runtimeRoot)).isDirectory()).toBe(true);
      } finally {
        if (originalFailKill === undefined) delete process.env.FAKE_TMUX_FAIL_KILL;
        else process.env.FAKE_TMUX_FAIL_KILL = originalFailKill;
      }
    });
  });

  test("environment teardown preserves retry state when environment loading fails", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, runtimeRoot }) => {
      const context = {
        storage: {
          getEnvironment: async () => environment,
          loadEnvironments: async () => {
            throw new Error("environment store unavailable");
          },
        },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };
      await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-load-failure", environmentId: environment.id },
        context,
      );

      await expect(
        cleanupEnvironmentTmux(
          environment.id,
          context as unknown as CommandContext,
        ),
      ).rejects.toThrow("cleanup incomplete");
      expect((await fs.stat(runtimeRoot)).isDirectory()).toBe(true);
    });
  });

  test("environment teardown retains the backup when restoring Claude settings fails", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, runtimeRoot, worktree }) => {
      const settingsPath = path.join(worktree, ".claude", "settings.local.json");
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(settingsPath, JSON.stringify({ original: true }));
      const context = {
        storage: {
          getEnvironment: async () => environment,
          loadEnvironments: async () => [environment],
        },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };
      await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-settings-failure", environmentId: environment.id },
        context,
      );

      await fs.rm(settingsPath);
      await fs.mkdir(settingsPath);

      await expect(
        cleanupEnvironmentTmux(
          environment.id,
          context as unknown as CommandContext,
        ),
      ).rejects.toThrow("cleanup incomplete");
      expect(
        await fs.readFile(
          path.join(runtimeRoot, "settings.local.json.orkestrator-v2-backup"),
          "utf8",
        ),
      ).toContain("original");
    });
  });

  test("starts local Claude sessions with the managed toolchain binary", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, log }) => {
      const toolchainBinDir = await createTempDir("ork-tmux-toolchain-");
      const managedClaude = path.join(toolchainBinDir, "claude");
      await fs.writeFile(managedClaude, `#!/bin/sh
case "$1" in
  --version) printf '2.1.2\n' ;;
  --help) printf '%s\n' '--session-id <uuid>' ;;
esac
exit 0
`);
      await fs.chmod(managedClaude, 0o500);
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
        toolchainBinDir,
      };

      await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-managed", environmentId: environment.id },
        context,
      );

      expect(await fs.readFile(log, "utf8")).toContain(managedClaude);
      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: "tab-managed", environmentId: environment.id },
        context,
      );
    });
  });

  test("omits the thinking and effort flags when an older CLI ignores what it does not know", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, log }) => {
      const toolchainBinDir = await createTempDir("ork-tmux-old-cli-");
      const oldClaude = path.join(toolchainBinDir, "claude");
      // An older CLI ignores the unknown option on the `--version` path and
      // exits 0, which is exactly what the probe treats as "unsupported". Its
      // `--help` also omits `--effort`, so that flag must be dropped too.
      await fs.writeFile(oldClaude, `#!/bin/sh
case "$1" in
  --help) printf '%s\\n' '--session-id <uuid>' ;;
  *) printf '2.1.2\\n' ;;
esac
exit 0
`);
      await fs.chmod(oldClaude, 0o500);
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
        toolchainBinDir,
      };

      await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-old-cli", environmentId: environment.id, model: "sonnet", effort: "high" },
        context,
      );

      const launchLog = await fs.readFile(log, "utf8");
      expect(launchLog).toContain(" --dangerously-skip-permissions");
      expect(launchLog).toContain(" --model 'sonnet'");
      expect(launchLog).not.toContain("--effort");
      expect(launchLog).not.toContain("--thinking-display");
      expect(launchLog).not.toContain("--thinking adaptive");

      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: "tab-old-cli", environmentId: environment.id },
        context,
      );
    });
  });

  test("omits the thinking flags when the CLI knows --thinking-display but not --thinking", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, log }) => {
      const toolchainBinDir = await createTempDir("ork-tmux-split-cli-");
      const splitClaude = path.join(toolchainBinDir, "claude");
      // The flags must be probed as a pair. A CLI that accepts one and rejects
      // the other would otherwise be launched with an option it cannot parse,
      // and Claude would exit before the tmux session ever showed a prompt.
      await fs.writeFile(splitClaude, `#!/bin/sh
case "$1" in
  --help) printf '%s\\n' '--session-id <uuid>' ;;
  --thinking)
    printf '%s\\n' "error: unknown option '--thinking'" >&2
    exit 1
    ;;
  --thinking-display)
    case "$2" in
      summarized|omitted) ;;
      *)
        printf '%s\\n' "error: option '--thinking-display <display>' argument '$2' is invalid. Allowed choices are summarized, omitted." >&2
        exit 1
        ;;
    esac
    printf '2.1.2\\n'
    ;;
  *) printf '2.1.2\\n' ;;
esac
exit 0
`);
      await fs.chmod(splitClaude, 0o500);
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
        toolchainBinDir,
      };

      await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-split-cli", environmentId: environment.id },
        context,
      );

      const launchLog = await fs.readFile(log, "utf8");
      expect(launchLog).toContain(" --dangerously-skip-permissions");
      expect(launchLog).not.toContain("--thinking");

      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: "tab-split-cli", environmentId: environment.id },
        context,
      );
    });
  });

  test("resumes an existing session id and still requests the thinking flags", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, log }) => {
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };
      const resumeSessionId = "11111111-2222-3333-4444-555555555555";

      const status = await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-resume", environmentId: environment.id, model: "opus", effort: "medium", resumeSessionId },
        context,
      ) as { session_id: string; resumed: boolean };

      expect(status.session_id).toBe(resumeSessionId);
      expect(status.resumed).toBe(true);

      const launchLog = await fs.readFile(log, "utf8");
      expect(launchLog).toContain(` --resume ${resumeSessionId}`);
      expect(launchLog).not.toContain("--session-id");
      expect(launchLog).toContain(" --model 'opus'");
      expect(launchLog).toContain(" --effort 'medium'");
      // The probe runs on the resume path too — a resumed session is still a
      // fresh CLI process and needs the same thinking display.
      expect(launchLog).toContain(" --thinking adaptive --thinking-display summarized");

      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: "tab-resume", environmentId: environment.id },
        context,
      );
    });
  });

  test("sends text and keys, captures, resizes, rejects blank switches, and answers PreToolUse", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, log, alive, runtimeRoot }) => {
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };
      const tabId = "tab-commands";
      const status = await invoke(
        handlers,
        "claude_tmux_start",
        { tabId, environmentId: environment.id },
        context,
      ) as { session_id: string };
      const session = tmuxSessionName(environment.id, tabId);
      const inputBuffer = path.join(alive, `buffer-claude-tmux-input-${session}`);

      // sendText pastes through a tmux buffer rather than send-keys, so the
      // pasted payload has to survive verbatim.
      await invoke(handlers, "claude_tmux_send_text", { tabId, environmentId: environment.id, text: "hello 👋" });
      await expect(fs.readFile(inputBuffer, "utf8")).resolves.toBe("hello 👋");
      await expect(fs.readFile(path.join(alive, `${session}.input`), "utf8")).resolves.toBe("hello 👋");

      await invoke(handlers, "claude_tmux_send_keys", { tabId, environmentId: environment.id, keys: ["Escape", "Enter"] });
      expect(await fs.readFile(log, "utf8")).toContain("-- Escape Enter");

      // tmux sessions launch in bypass mode, which is what the fake pane shows.
      await expect(invoke(
        handlers,
        "claude_tmux_capture_pane",
        { tabId, environmentId: environment.id },
      )).resolves.toContain("bypass permissions on");
      expect(await fs.readFile(log, "utf8")).toContain(`capture-pane -t ${session} -p -J`);

      await invoke(handlers, "claude_tmux_resize", { tabId, environmentId: environment.id, cols: 120, rows: 40 });
      expect(await fs.readFile(log, "utf8")).toContain(`resize-window -t ${session} -x 120 -y 40`);
      await expect(invoke(
        handlers,
        "claude_tmux_resize",
        { tabId, environmentId: environment.id, cols: 0, rows: 40 },
      )).rejects.toThrow("cols");

      // A blank model or effort must be rejected before anything reaches tmux.
      const beforeRejected = await fs.readFile(log, "utf8");
      await expect(invoke(
        handlers,
        "claude_tmux_switch_model",
        { tabId, environmentId: environment.id, model: "   " },
      )).rejects.toThrow("model id cannot be empty");
      await expect(invoke(
        handlers,
        "claude_tmux_switch_effort",
        { tabId, environmentId: environment.id, effort: "" },
      )).rejects.toThrow("effort level cannot be empty");
      expect(await fs.readFile(log, "utf8")).toBe(beforeRejected);

      const sessionRoot = path.join(runtimeRoot, "sessions", status.session_id);
      await fs.mkdir(path.join(sessionRoot, "pending"), { recursive: true });
      await fs.writeFile(
        path.join(sessionRoot, "pending", "PreToolUse-event-9.json"),
        JSON.stringify({ tool_name: "Bash" }),
      );
      await invoke(handlers, "claude_tmux_answer_pre_tool_use", {
        tabId,
        environmentId: environment.id,
        eventId: "event-9",
        decision: "block",
        reason: "not this time",
      });
      await expect(
        fs.readFile(path.join(sessionRoot, "response", "PreToolUse-event-9.json"), "utf8").then(JSON.parse),
      ).resolves.toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "not this time",
        },
      });
      await expect(fs.stat(path.join(sessionRoot, "pending", "PreToolUse-event-9.json"))).rejects.toThrow();

      await invoke(handlers, "claude_tmux_stop", { tabId, environmentId: environment.id }, context);
    });
  });

  // Model and effort switches are typed as slash commands into the running TUI
  // — the CLI flags only apply at launch — and each one then waits out the
  // no-hook settle window, so this needs more than the default per-test budget.
  test("switches model and effort as slash commands in the live TUI", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, alive }) => {
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };
      const tabId = "tab-switches";
      await invoke(handlers, "claude_tmux_start", { tabId, environmentId: environment.id }, context);
      const session = tmuxSessionName(environment.id, tabId);
      const inputBuffer = path.join(alive, `buffer-claude-tmux-input-${session}`);

      await invoke(handlers, "claude_tmux_switch_model", { tabId, environmentId: environment.id, model: "opus" });
      await expect(fs.readFile(inputBuffer, "utf8")).resolves.toBe("/model opus");

      await invoke(handlers, "claude_tmux_switch_effort", { tabId, environmentId: environment.id, effort: "high" });
      await expect(fs.readFile(inputBuffer, "utf8")).resolves.toBe("/effort high");

      await invoke(handlers, "claude_tmux_stop", { tabId, environmentId: environment.id }, context);
    });
  }, 20_000);

  test("starts with installed hooks, reads transcripts, replies to hooks, and maps interactive input", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ worktree, home, log, environment, runtimeRoot }) => {
      const emitted: Array<{ event: string; payload: unknown }> = [];
      const context = {
        storage: {
          getEnvironment: async () => environment,
        },
        emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
        appRoot: "",
        resourceRoot: "",
      };

      const status = await invoke(
        handlers,
        "claude_tmux_start",
        {
          tabId: "tab-1",
          environmentId: environment.id,
          model: "sonnet",
          effort: "medium",
          // Legacy callers may still send this launch-time field. It must not
          // override the invariant that Claude starts in bypass mode.
          planMode: true,
        },
        context,
      ) as { session_id: string; running: boolean };
      expect(status.running).toBe(true);
      expect(status.session_id).toBeTruthy();

      const launchLog = await fs.readFile(log, "utf8");
      expect(launchLog).toContain(" --dangerously-skip-permissions");
      expect(launchLog).not.toContain("--permission-mode plan");
      // Without this the CLI defaults thinking display to "omitted" on recent
      // models, and every thinking block reaches the transcript with empty text.
      expect(launchLog).toContain(" --thinking adaptive --thinking-display summarized");

      await expect(invoke(
        handlers,
        "claude_tmux_switch_plan_mode",
        { tabId: "tab-1", environmentId: environment.id, planMode: true },
        context,
      )).resolves.toBe("plan");
      await expect(invoke(
        handlers,
        "claude_tmux_status",
        { tabId: "tab-1", environmentId: environment.id },
        context,
      )).resolves.toEqual(expect.objectContaining({ permission_mode: "plan" }));
      await expect(invoke(
        handlers,
        "claude_tmux_switch_plan_mode",
        { tabId: "tab-1", environmentId: environment.id, planMode: false },
        context,
      )).resolves.toBe("bypassPermissions");
      await expect(invoke(
        handlers,
        "claude_tmux_status",
        { tabId: "tab-1", environmentId: environment.id },
        context,
      )).resolves.toEqual(expect.objectContaining({ permission_mode: "bypassPermissions" }));

      const switchedLog = await fs.readFile(log, "utf8");
      expect(switchedLog).toContain("send-keys -t");
      expect(switchedLog).toContain("-- BTab");

      const sessionRoot = path.join(runtimeRoot, "sessions", status.session_id);
      const pendingDir = path.join(sessionRoot, "pending");
      const responseDir = path.join(sessionRoot, "response");
      const timingDir = path.join(sessionRoot, "timing");
      await fs.mkdir(pendingDir, { recursive: true });
      const hookEventId = "1700000000-event-1";
      await fs.writeFile(path.join(pendingDir, `PreToolUse-${hookEventId}.json`), JSON.stringify({ tool_name: "Edit" }));
      await fs.writeFile(
        path.join(timingDir, `PreToolUse-${hookEventId}.json`),
        JSON.stringify({ requestedAt: 1_700_000_000_123, expiresAt: 1_700_000_300_123 }),
      );
      const invalidTimingEventIds = [
        "event-legacy",
        "1700000000oops-malformed",
        "0-zero",
        "-1-negative",
        "9007199254740992-unsafe-seconds",
        "9007199254740-unsafe-milliseconds",
      ];
      await Promise.all(invalidTimingEventIds.map((eventId) =>
        fs.writeFile(
          path.join(pendingDir, `PermissionRequest-${eventId}.json`),
          JSON.stringify({ tool_name: "Edit" }),
        )
      ));

      const pendingHooks = await invoke(
        handlers,
        "claude_tmux_pending_hooks",
        { tabId: "tab-1", environmentId: environment.id },
      ) as Array<Record<string, unknown>>;
      expect(pendingHooks).toContainEqual({
        id: hookEventId,
        kind: "PreToolUse",
        payload: { tool_name: "Edit" },
        requestedAt: 1_700_000_000_123,
        expiresAt: 1_700_000_300_123,
      });
      for (const eventId of invalidTimingEventIds) {
        expect(pendingHooks).toContainEqual({
          id: eventId,
          kind: "PermissionRequest",
          payload: { tool_name: "Edit" },
        });
        const pending = pendingHooks.find((hook) => hook.id === eventId);
        expect(pending).not.toHaveProperty("requestedAt");
        expect(pending).not.toHaveProperty("expiresAt");
      }

      await invoke(
        handlers,
        "claude_tmux_reply_hook",
        { tabId: "tab-1", environmentId: environment.id, eventKind: "PreToolUse", eventId: hookEventId, response: { ok: true } },
      );
      await expect(fs.readFile(path.join(responseDir, `PreToolUse-${hookEventId}.json`), "utf8")).resolves.toBe(JSON.stringify({ ok: true }));
      await expect(fs.stat(path.join(pendingDir, `PreToolUse-${hookEventId}.json`))).rejects.toThrow();
      await expect(fs.stat(path.join(timingDir, `PreToolUse-${hookEventId}.json`))).rejects.toThrow();
      await expect(invoke(
        handlers,
        "claude_tmux_reply_hook",
        { tabId: "tab-1", environmentId: environment.id, eventKind: "PreToolUse", eventId: "../bad", response: {} },
      )).rejects.toThrow("invalid hook event id");

      const transcriptDir = path.join(home, ".claude", "projects", encodeCwd(worktree));
      await fs.mkdir(transcriptDir, { recursive: true });
      await fs.writeFile(
        path.join(transcriptDir, `${status.session_id}.jsonl`),
        `${JSON.stringify({ type: "user", message: { role: "user", content: "Hello" } })}\nnot-json\n${JSON.stringify({ type: "assistant", message: { role: "assistant", content: "Hi" } })}\n`,
      );
      await expect(invoke(handlers, "claude_tmux_transcript", { tabId: "tab-1", environmentId: environment.id })).resolves.toEqual([
        { type: "user", message: { role: "user", content: "Hello" } },
        { type: "assistant", message: { role: "assistant", content: "Hi" } },
      ]);
      await expect(invoke(handlers, "claude_tmux_list_previous_sessions", { environmentId: environment.id }, context)).resolves.toEqual([
        expect.objectContaining({
          session_id: status.session_id,
          title: "Hello",
          message_count: 3,
        }),
      ]);

      const terminalSessionId = await invoke(
        handlers,
        "claude_tmux_create_interactive_terminal",
        { tabId: "tab-1", environmentId: environment.id, cols: 120, rows: 40 },
        context,
      ) as string;
      await invoke(handlers, "claude_tmux_start_interactive_terminal", { terminalSessionId }, context);
      await invoke(handlers, "claude_tmux_write_interactive_terminal", { terminalSessionId, data: "abc\r\u001b[A\u007f" });
      await invoke(handlers, "claude_tmux_resize_interactive_terminal", { terminalSessionId, cols: 100, rows: 30 });
      await invoke(handlers, "claude_tmux_detach_interactive_terminal", { terminalSessionId });
      await invoke(handlers, "claude_tmux_stop", { tabId: "tab-1", environmentId: environment.id }, context);

      const tmuxLog = await fs.readFile(log, "utf8");
      expect(tmuxLog).toContain("resize-window");
      expect(tmuxLog).toContain("capture-pane");
      expect(tmuxLog).toContain("send-keys -t");
      expect(tmuxLog).toContain("-l abc");
      expect(tmuxLog).toContain("-- Enter");
      expect(tmuxLog).toContain("-- Up");
      expect(tmuxLog).toContain("-- BSpace");
      expect(emitted.some((item) => item.event === "claude-tmux:event")).toBe(true);
      const terminalOutput = emitted.find((item) => item.event === `terminal-output-${terminalSessionId}`);
      expect(terminalOutput).toBeDefined();
      // Pins the current plain UTF-8 shape and exact-repaint marker.
      const terminalPayload = terminalOutput!.payload as Record<string, unknown>;
      expect(Object.keys(terminalPayload)).toEqual(["text", "full"]);
      expect(terminalPayload.full).toBe(true);
      expect(terminalPayload.text).toBe("\u001b[H\u001b[2Jbypass permissions on");
    });
  });

  test("generated blocking hooks use an integer timeout and fail closed on expiry", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, runtimeRoot }) => {
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };
      const status = await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-hook-timeout", environmentId: environment.id },
        context,
      ) as { session_id: string };

      const installedScript = await fs.readFile(path.join(runtimeRoot, "hook.sh"), "utf8");
      const timeout = installedScript.match(/^TIMEOUT_SECS=(\d+)$/m);
      expect(timeout?.[1]).toBe("300");
      expect(installedScript).toContain("REQUESTED_AT_MS=\"$(epoch_millis)\"");
      expect(installedScript).toContain("EXPIRES_AT_MS=$((REQUESTED_AT_MS + TIMEOUT_SECS * 1000))");
      expect(installedScript).toContain("sleep \"$TIMEOUT_SECS\" &");
      expect(installedScript).not.toContain("TIMEOUT_SECS * 4");

      // Exercise the real generated shell branches without waiting five
      // minutes. Only this disposable test copy receives a zero timeout.
      const immediateScript = installedScript.replace(/^TIMEOUT_SECS=\d+$/m, "TIMEOUT_SECS=0");
      const immediateScriptPath = path.join(runtimeRoot, "hook-immediate-timeout.sh");
      await fs.writeFile(immediateScriptPath, immediateScript);

      const runHook = (kind: "PreToolUse" | "PermissionRequest" | "Elicitation") => {
        const result = spawnSync("bash", [immediateScriptPath, kind], {
          encoding: "utf8",
          input: JSON.stringify({ session_id: status.session_id }),
        });
        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        return JSON.parse(result.stdout) as unknown;
      };

      expect(runHook("PreToolUse")).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "Approval timed out without a user response.",
        },
      });
      expect(runHook("PermissionRequest")).toEqual({
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: {
            behavior: "deny",
            message: "Permission request timed out without a user response.",
          },
        },
      });
      expect(runHook("Elicitation")).toEqual({
        hookSpecificOutput: {
          hookEventName: "Elicitation",
          action: "cancel",
        },
      });

      const sessionRoot = path.join(runtimeRoot, "sessions", status.session_id);
      expect(await fs.readdir(path.join(sessionRoot, "pending"))).toEqual([]);
      expect(await fs.readdir(path.join(sessionRoot, "timing"))).toEqual([]);
      expect(await fs.readdir(path.join(sessionRoot, "timeout"))).toHaveLength(3);

      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: "tab-hook-timeout", environmentId: environment.id },
        context,
      );
    });
  });

  test("validates planMode strictly without sending input for malformed requests", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, log }) => {
      const context = {
        storage: {
          getEnvironment: async () => environment,
        },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };
      await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-plan-validation", environmentId: environment.id },
        context,
      );
      const before = await fs.readFile(log, "utf8");

      for (const planMode of [undefined, null, "true", 0]) {
        await expect(invoke(
          handlers,
          "claude_tmux_switch_plan_mode",
          { tabId: "tab-plan-validation", environmentId: environment.id, planMode },
          context,
        )).rejects.toThrow("Expected planMode to be a boolean");
      }

      expect(await fs.readFile(log, "utf8")).toBe(before);
      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: "tab-plan-validation", environmentId: environment.id },
        context,
      );
    });
  });

  test("enters plan directly from every supported pane mode without triggering Auto opt-in", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, log, alive }) => {
      const context = {
        storage: {
          getEnvironment: async () => environment,
        },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };
      const status = await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-plan-modes", environmentId: environment.id },
        context,
      ) as { tmux_session: string };
      const modePath = path.join(alive, `${status.tmux_session}.mode`);
      await fs.writeFile(path.join(alive, `${status.tmux_session}.auto-prompt-on-btab`), "");

      for (const sourceMode of ["bypassPermissions", "default", "acceptEdits", "auto", "dontAsk"]) {
        await fs.writeFile(modePath, sourceMode);
        await expect(invoke(
          handlers,
          "claude_tmux_switch_plan_mode",
          { tabId: "tab-plan-modes", environmentId: environment.id, planMode: true },
          context,
        )).resolves.toBe("plan");
        await expect(fs.readFile(modePath, "utf8")).resolves.toBe("plan");
      }

      const beforeBuild = await fs.readFile(log, "utf8");
      expect(beforeBuild).not.toContain("-- BTab");

      await expect(invoke(
        handlers,
        "claude_tmux_switch_plan_mode",
        { tabId: "tab-plan-modes", environmentId: environment.id, planMode: false },
        context,
      )).resolves.toBe("bypassPermissions");
      await expect(fs.readFile(modePath, "utf8")).resolves.toBe("bypassPermissions");
      expect(await fs.readFile(log, "utf8")).toContain("-- BTab");

      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: "tab-plan-modes", environmentId: environment.id },
        context,
      );
    });
  });

  test("reports prompt, exit, capture, send, and transition failures", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, alive }) => {
      const context = {
        storage: {
          getEnvironment: async () => environment,
        },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };
      const status = await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-plan-errors", environmentId: environment.id },
        context,
      ) as { tmux_session: string };
      const prefix = path.join(alive, status.tmux_session);
      const modePath = `${prefix}.mode`;
      const switchToPlan = () => invoke(
        handlers,
        "claude_tmux_switch_plan_mode",
        { tabId: "tab-plan-errors", environmentId: environment.id, planMode: true },
        context,
      );

      await fs.writeFile(modePath, "selection");
      await expect(switchToPlan()).rejects.toThrow("Finish the active Claude prompt");

      await fs.writeFile(modePath, "exited");
      await expect(switchToPlan()).rejects.toThrow("Claude exited before its mode could be changed");

      await fs.writeFile(modePath, "bypassPermissions");
      await fs.writeFile(`${prefix}.fail-capture`, "");
      await expect(switchToPlan()).rejects.toThrow("capture failed");
      await fs.rm(`${prefix}.fail-capture`);

      await fs.writeFile(`${prefix}.fail-send`, "");
      await expect(switchToPlan()).rejects.toThrow("send failed");
      await fs.rm(`${prefix}.fail-send`);
      await fs.rm(`${prefix}.input`, { force: true });

      await fs.writeFile(`${prefix}.ignore-plan`, "");
      await expect(switchToPlan()).rejects.toThrow("Claude did not enter plan; observed bypassPermissions");
      await fs.rm(`${prefix}.ignore-plan`);

      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: "tab-plan-errors", environmentId: environment.id },
        context,
      );
    });
  });

  test("serializes interactive input and interrupts behind a mode transition", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, alive, log }) => {
      const context = {
        storage: {
          getEnvironment: async () => environment,
        },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };
      const status = await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-plan-lock", environmentId: environment.id },
        context,
      ) as { tmux_session: string };
      await fs.writeFile(path.join(alive, `${status.tmux_session}.delay-plan`), "");
      const terminalSessionId = await invoke(
        handlers,
        "claude_tmux_create_interactive_terminal",
        { tabId: "tab-plan-lock", environmentId: environment.id, cols: 100, rows: 30 },
        context,
      ) as string;

      const switching = invoke(
        handlers,
        "claude_tmux_switch_plan_mode",
        { tabId: "tab-plan-lock", environmentId: environment.id, planMode: true },
        context,
      );
      await waitFor(async () => (await fs.readFile(log, "utf8")).includes("-- Enter"));

      const writing = invoke(
        handlers,
        "claude_tmux_write_interactive_terminal",
        { terminalSessionId, data: "serialized-input" },
        context,
      );
      const interrupting = invoke(
        handlers,
        "claude_tmux_interrupt",
        { tabId: "tab-plan-lock", environmentId: environment.id },
        context,
      );

      await delay(50);
      const whileSwitching = await fs.readFile(log, "utf8");
      expect(whileSwitching).not.toContain("-l serialized-input");
      expect(whileSwitching).not.toContain("-- Escape");

      await expect(switching).resolves.toBe("plan");
      await expect(writing).resolves.toBeUndefined();
      await expect(interrupting).resolves.toBeUndefined();
      const after = await fs.readFile(log, "utf8");
      expect(after.indexOf("-l serialized-input")).toBeGreaterThan(after.indexOf("-- Enter"));
      expect(after.indexOf("-- Escape")).toBeGreaterThan(after.indexOf("-l serialized-input"));

      const submitting = invoke(
        handlers,
        "claude_tmux_submit",
        { tabId: "tab-plan-lock", environmentId: environment.id, text: "Run the checks" },
        context,
      );
      const switchingDuringSubmit = invoke(
        handlers,
        "claude_tmux_switch_plan_mode",
        { tabId: "tab-plan-lock", environmentId: environment.id, planMode: false },
        context,
      );
      const switchingExpectation = expect(switchingDuringSubmit).rejects.toThrow(
        "Cannot switch Claude mode while a turn is running",
      );
      await expect(submitting).resolves.toBeUndefined();
      await switchingExpectation;
      await invoke(
        handlers,
        "claude_tmux_interrupt",
        { tabId: "tab-plan-lock", environmentId: environment.id },
        context,
      );

      await invoke(
        handlers,
        "claude_tmux_detach_interactive_terminal",
        { terminalSessionId },
        context,
      );
      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: "tab-plan-lock", environmentId: environment.id },
        context,
      );
    });
  });

  test("marks a session busy after the backend submits an initial prompt", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, log }) => {
      const context = {
        storage: {
          getEnvironment: async () => environment,
        },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };

      await invoke(
        handlers,
        "claude_tmux_start",
        {
          tabId: "tab-initial",
          environmentId: environment.id,
          initialPrompt: "Run the audit",
        },
        context,
      );

      await waitFor(async () => {
        const status = await invoke(
          handlers,
          "claude_tmux_status",
          { tabId: "tab-initial", environmentId: environment.id },
          context,
        ) as { busy: boolean } | null;
        return status?.busy === true;
      }, 3_000);

      try {
        const beforeSwitch = await fs.readFile(log, "utf8");
        await expect(invoke(
          handlers,
          "claude_tmux_switch_plan_mode",
          { tabId: "tab-initial", environmentId: environment.id, planMode: true },
          context,
        )).rejects.toThrow("Cannot switch Claude mode while a turn is running");
        expect(await fs.readFile(log, "utf8")).toBe(beforeSwitch);

        await invoke(
          handlers,
          "claude_tmux_stop",
          { tabId: "tab-initial", environmentId: environment.id },
          context,
        );
      } finally {
        // After stop the session is removed from the manager; status returns null.
        const after = await invoke(
          handlers,
          "claude_tmux_status",
          { tabId: "tab-initial", environmentId: environment.id },
          context,
        );
        expect(after).toBeNull();
      }
    });
  });

  test("falls back to the newest current-session transcript when Claude writes a different JSONL filename", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ worktree, home, environment }) => {
      const context = {
        storage: {
          getEnvironment: async () => environment,
        },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };

      const status = await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-fallback", environmentId: environment.id },
        context,
      ) as { session_id: string; running: boolean };
      expect(status.running).toBe(true);

      const transcriptDir = path.join(home, ".claude", "projects", encodeCwd(worktree));
      await fs.mkdir(transcriptDir, { recursive: true });

      const oldPath = path.join(transcriptDir, "old-session.jsonl");
      await fs.writeFile(oldPath, `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: "Old" } })}\n`);
      await fs.utimes(oldPath, new Date(0), new Date(0));

      const fallbackPath = path.join(transcriptDir, "claude-owned-session.jsonl");
      await fs.writeFile(
        fallbackPath,
        `${JSON.stringify({ sessionId: status.session_id, type: "assistant", message: { role: "assistant", content: "Visible" } })}\n`,
      );

      await expect(invoke(
        handlers,
        "claude_tmux_transcript",
        { tabId: "tab-fallback", environmentId: environment.id },
      )).resolves.toEqual([
        { sessionId: status.session_id, type: "assistant", message: { role: "assistant", content: "Visible" } },
      ]);

      await invoke(handlers, "claude_tmux_stop", { tabId: "tab-fallback", environmentId: environment.id }, context);
    });
  });

  test("does not bind a fresh tab to another active tab's transcript fallback", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ worktree, home, environment }) => {
      const context = {
        storage: {
          getEnvironment: async () => environment,
        },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };

      const reviewStatus = await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "review-tab", environmentId: environment.id, initialPrompt: "Review this" },
        context,
      ) as { session_id: string; running: boolean };
      expect(reviewStatus.running).toBe(true);

      const transcriptDir = path.join(home, ".claude", "projects", encodeCwd(worktree));
      await fs.mkdir(transcriptDir, { recursive: true });
      await fs.writeFile(
        path.join(transcriptDir, "review-owned-session.jsonl"),
        `${JSON.stringify({ sessionId: reviewStatus.session_id, type: "assistant", message: { role: "assistant", content: "Review transcript" } })}\n`,
      );

      const freshStatus = await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "fresh-tab", environmentId: environment.id },
        context,
      ) as { session_id: string; running: boolean };
      expect(freshStatus.running).toBe(true);
      expect(freshStatus.session_id).not.toBe(reviewStatus.session_id);

      await expect(invoke(
        handlers,
        "claude_tmux_transcript",
        { tabId: "fresh-tab", environmentId: environment.id },
      )).resolves.toEqual([]);

      await fs.writeFile(
        path.join(transcriptDir, "fresh-owned-session.jsonl"),
        `${JSON.stringify({ sessionId: freshStatus.session_id, type: "assistant", message: { role: "assistant", content: "Fresh transcript" } })}\n`,
      );

      await expect(invoke(
        handlers,
        "claude_tmux_transcript",
        { tabId: "fresh-tab", environmentId: environment.id },
      )).resolves.toEqual([
        { sessionId: freshStatus.session_id, type: "assistant", message: { role: "assistant", content: "Fresh transcript" } },
      ]);

      await invoke(handlers, "claude_tmux_stop", { tabId: "review-tab", environmentId: environment.id }, context);
      await invoke(handlers, "claude_tmux_stop", { tabId: "fresh-tab", environmentId: environment.id }, context);
    });
  });

  test("does not use transcript fallback when fresh candidates are ambiguous", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ worktree, home, environment }) => {
      const context = {
        storage: {
          getEnvironment: async () => environment,
        },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };

      const status = await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-ambiguous", environmentId: environment.id },
        context,
      ) as { running: boolean };
      expect(status.running).toBe(true);

      const transcriptDir = path.join(home, ".claude", "projects", encodeCwd(worktree));
      await fs.mkdir(transcriptDir, { recursive: true });
      await fs.writeFile(
        path.join(transcriptDir, "first-fresh.jsonl"),
        `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: "First" } })}\n`,
      );
      await fs.writeFile(
        path.join(transcriptDir, "second-fresh.jsonl"),
        `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: "Second" } })}\n`,
      );

      await expect(invoke(
        handlers,
        "claude_tmux_transcript",
        { tabId: "tab-ambiguous", environmentId: environment.id },
      )).resolves.toEqual([]);

      await invoke(handlers, "claude_tmux_stop", { tabId: "tab-ambiguous", environmentId: environment.id }, context);
    });
  });

  test("continues tailing live transcript lines after non-ASCII content", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ worktree, home, environment }) => {
      const emitted: Array<{ event: string; payload: unknown }> = [];
      const context = {
        storage: {
          getEnvironment: async () => environment,
        },
        emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
        appRoot: "",
        resourceRoot: "",
      };

      const status = await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-tail", environmentId: environment.id },
        context,
      ) as { session_id: string; running: boolean };
      expect(status.running).toBe(true);

      const transcriptDir = path.join(home, ".claude", "projects", encodeCwd(worktree));
      await fs.mkdir(transcriptDir, { recursive: true });
      const transcriptPath = path.join(transcriptDir, `${status.session_id}.jsonl`);
      await fs.writeFile(
        transcriptPath,
        `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: "Hello £" } })}\n`,
      );

      await waitFor(() => emitted.some((item) =>
        item.event === "claude-tmux:event" &&
        (item.payload as { kind?: string; line?: { message?: { content?: string } } }).kind === "transcript-line" &&
        (item.payload as { line?: { message?: { content?: string } } }).line?.message?.content === "Hello £"
      ));

      await fs.appendFile(
        transcriptPath,
        `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: "Second message" } })}\n`,
      );

      await waitFor(() => emitted.some((item) =>
        item.event === "claude-tmux:event" &&
        (item.payload as { kind?: string; line?: { message?: { content?: string } } }).kind === "transcript-line" &&
        (item.payload as { line?: { message?: { content?: string } } }).line?.message?.content === "Second message"
      ));

      await fs.appendFile(
        transcriptPath,
        `${JSON.stringify({ type: "permission-mode", permissionMode: "plan" })}\n`,
      );
      await waitFor(() => emitted.some((item) =>
        item.event === "claude-tmux:event" &&
        (item.payload as { kind?: string; permission_mode?: string }).kind === "permission-mode-changed" &&
        (item.payload as { permission_mode?: string }).permission_mode === "plan"
      ));
      await expect(invoke(
        handlers,
        "claude_tmux_status",
        { tabId: "tab-tail", environmentId: environment.id },
        context,
      )).resolves.toEqual(expect.objectContaining({ permission_mode: "plan" }));

      await invoke(handlers, "claude_tmux_stop", { tabId: "tab-tail", environmentId: environment.id }, context);
    });
  });

  test("stamps the derived task list onto transcript lines and serves it on demand", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ worktree, home, environment }) => {
      const emitted: Array<{ event: string; payload: unknown }> = [];
      const context = {
        storage: {
          getEnvironment: async () => environment,
        },
        emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
        appRoot: "",
        resourceRoot: "",
      };

      const status = await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-tasks", environmentId: environment.id },
        context,
      ) as { session_id: string; running: boolean };
      expect(status.running).toBe(true);

      const transcriptDir = path.join(home, ".claude", "projects", encodeCwd(worktree));
      await fs.mkdir(transcriptDir, { recursive: true });
      const transcriptPath = path.join(transcriptDir, `${status.session_id}.jsonl`);
      const jsonl = (line: unknown) => `${JSON.stringify(line)}\n`;

      // A complete task tool call spans two lines: the use carries the args,
      // the result carries the assigned id.
      await fs.writeFile(
        transcriptPath,
        jsonl({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tu-task-1",
                name: "TaskCreate",
                input: { subject: "Derived in the backend" },
              },
            ],
          },
        }) +
          jsonl({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "tu-task-1",
                  content: "Task #1 created successfully: Derived in the backend",
                },
              ],
            },
          }),
      );

      // A full read stamps each line with the list as it stood at that line.
      const lines = await invoke(
        handlers,
        "claude_tmux_transcript",
        { tabId: "tab-tasks", environmentId: environment.id },
      ) as Array<{ taskSnapshots?: Record<string, unknown> }>;

      expect(lines).toHaveLength(2);
      // The tool_use line changed nothing; the result line carries the list,
      // keyed by the tool call it belongs to.
      expect(lines[0]?.taskSnapshots).toBeUndefined();
      expect(lines[1]?.taskSnapshots).toEqual({
        "tu-task-1": {
          items: [{ id: "1", subject: "Derived in the backend", status: "pending" }],
          complete: true,
          changedTaskId: "1",
        },
      });

      // ...and the same state is available without replaying the transcript,
      // which is how a tab that was unmounted catches up.
      await expect(invoke(
        handlers,
        "claude_tmux_tasks",
        { tabId: "tab-tasks", environmentId: environment.id },
      )).resolves.toEqual({
        items: [{ id: "1", subject: "Derived in the backend", status: "pending" }],
        complete: true,
      });

      // Live tail lines are stamped the same way.
      await fs.appendFile(
        transcriptPath,
        jsonl({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tu-task-2",
                name: "TaskUpdate",
                input: { taskId: "1", status: "completed" },
              },
            ],
          },
        }) +
          jsonl({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "tu-task-2",
                  content: "Updated task #1 status",
                },
              ],
            },
          }),
      );

      await waitFor(() => emitted.some((item) =>
        item.event === "claude-tmux:event" &&
        (item.payload as { kind?: string }).kind === "transcript-line" &&
        (item.payload as { line?: { taskSnapshots?: Record<string, unknown> } })
          .line?.taskSnapshots?.["tu-task-2"] !== undefined
      ));

      const tailed = emitted
        .map((item) => item.payload as {
          line?: { taskSnapshots?: Record<string, { items?: unknown; changedTaskId?: string }> };
        })
        .filter((payload) => payload.line?.taskSnapshots)
        .at(-1);
      expect(tailed?.line?.taskSnapshots?.["tu-task-2"]).toEqual({
        items: [{ id: "1", subject: "Derived in the backend", status: "completed" }],
        complete: true,
        changedTaskId: "1",
      });

      await invoke(handlers, "claude_tmux_stop", { tabId: "tab-tasks", environmentId: environment.id }, context);
    });
  });
});

describe("ClaudeStatePollManager", () => {
  function createPollHarness(options: {
    states?: string[];
    readState?: (containerId: string) => Promise<string>;
    environments?: Environment[];
    loadEnvironments?: () => Promise<Environment[]>;
    nowMs?: () => number;
    persist?: (
      environmentId: string,
      state: "idle" | "working" | "waiting",
      occurredAt: string,
      source: "frontend" | "claude-terminal",
    ) => Promise<Environment>;
  } = {}) {
    const scheduled: Array<() => void> = [];
    const cancelled = new Set<unknown>();
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const persisted: Array<{
      environmentId: string;
      state: string;
      occurredAt: string;
      source: string;
    }> = [];
    const states = [...(options.states ?? [])];
    const environment = createEnvironment("/worktree", "env-poll");
    environment.containerId = "container-poll";
    const environments = options.environments ?? [environment];
    const fixedNow = "2026-07-27T12:00:00.000Z";
    const context = {
      storage: {
        loadEnvironments: options.loadEnvironments ?? (async () => environments),
        setEnvironmentAgentActivity: async (
          environmentId: string,
          state: "idle" | "working" | "waiting",
          occurredAt: string,
          source: "frontend" | "claude-terminal",
        ) => {
          persisted.push({ environmentId, state, occurredAt, source });
          if (options.persist) {
            return options.persist(environmentId, state, occurredAt, source);
          }
          return {
            ...environment,
            agentActivityState: state,
            agentActivityUpdatedAt: "2026-07-27T12:00:00.001Z",
            agentActivitySources: {
              "claude-terminal": {
                state,
                updatedAt: occurredAt,
              },
            },
          };
        },
      },
      emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
      appRoot: "",
      resourceRoot: "",
    } as unknown as CommandContext;
    const manager = new ClaudeStatePollManager({
      readState: options.readState ?? (async () => states.shift() ?? ""),
      schedule: (callback) => {
        scheduled.push(callback);
        return callback;
      },
      cancel: (timer) => {
        cancelled.add(timer);
      },
      now: () => fixedNow,
      nowMs: options.nowMs,
    });
    return {
      manager,
      context,
      scheduled,
      cancelled,
      emitted,
      persisted,
      environment,
    };
  }

  test("persists a changed terminal state before emitting its authoritative timestamp", async () => {
    const harness = createPollHarness({ states: ["working", "working"] });

    harness.manager.start("container-poll", harness.context);
    await waitFor(() => harness.emitted.length === 1);

    expect(harness.persisted).toEqual([{
      environmentId: "env-poll",
      state: "working",
      occurredAt: "2026-07-27T12:00:00.000Z",
      source: "claude-terminal",
    }]);
    expect(harness.emitted).toEqual([{
      event: "claude-state-container-poll",
      payload: {
        container_id: "container-poll",
        state: "working",
        occurred_at: "2026-07-27T12:00:00.000Z",
      },
    }]);

    harness.scheduled[0]!();
    await delay(0);
    expect(harness.persisted).toHaveLength(1);
    expect(harness.emitted).toHaveLength(1);
    harness.manager.shutdown("container-poll");
  });

  test("notifies backend reconciliation for production working-to-waiting completion", async () => {
    const harness = createPollHarness({ states: ["working", "waiting", "idle"] });
    harness.environment.prRecheckAfterAgentCompletionArmedAt = "2026-08-01T12:00:00.000Z";
    const notifyAgentTurnCompleted = mock(async () => undefined);
    harness.context.notifyAgentTurnCompleted = notifyAgentTurnCompleted;

    harness.manager.start("container-poll", harness.context);
    await waitFor(() => harness.emitted.length === 1);
    harness.scheduled[0]!();
    await waitFor(() => notifyAgentTurnCompleted.mock.calls.length === 1);

    expect(notifyAgentTurnCompleted).toHaveBeenCalledWith("env-poll");
    harness.scheduled[0]!();
    await waitFor(() => harness.emitted.length === 3);
    expect(notifyAgentTurnCompleted).toHaveBeenCalledTimes(1);
    harness.manager.shutdown("container-poll");
  });

  test("notifies backend reconciliation for an armed working-to-idle recovery", async () => {
    const harness = createPollHarness({ states: ["working", "idle"] });
    harness.environment.prRecheckAfterAgentCompletionArmedAt = "2026-08-01T12:00:00.000Z";
    const notifyAgentTurnCompleted = mock(async () => undefined);
    harness.context.notifyAgentTurnCompleted = notifyAgentTurnCompleted;

    harness.manager.start("container-poll", harness.context);
    await waitFor(() => harness.emitted.length === 1);
    harness.scheduled[0]!();
    await waitFor(() => notifyAgentTurnCompleted.mock.calls.length === 1);

    expect(notifyAgentTurnCompleted).toHaveBeenCalledWith("env-poll");
    harness.manager.shutdown("container-poll");
  });

  test("recovers an initially waiting or idle armed turn without notifying for an unarmed poll", async () => {
    for (const initialState of ["waiting", "idle"] as const) {
      const armed = createPollHarness({ states: [initialState] });
      armed.environment.prRecheckAfterAgentCompletionArmedAt = "2026-08-01T12:00:00.000Z";
      const armedNotification = mock(async () => undefined);
      armed.context.notifyAgentTurnCompleted = armedNotification;

      armed.manager.start("container-poll", armed.context);
      await waitFor(() => armedNotification.mock.calls.length === 1);
      expect(armedNotification).toHaveBeenCalledWith("env-poll");
      armed.manager.shutdown("container-poll");
    }

    const unarmed = createPollHarness({ states: ["working", "waiting", "idle"] });
    const unarmedNotification = mock(async () => undefined);
    unarmed.context.notifyAgentTurnCompleted = unarmedNotification;
    unarmed.manager.start("container-poll", unarmed.context);
    await waitFor(() => unarmed.emitted.length === 1);
    for (let expectedEmits = 2; expectedEmits <= 3; expectedEmits += 1) {
      unarmed.scheduled[0]!();
      await waitFor(() => unarmed.emitted.length === expectedEmits);
    }
    expect(unarmedNotification).not.toHaveBeenCalled();
    unarmed.manager.shutdown("container-poll");
  });

  test("continues polling after a terminal completion notification rejects", async () => {
    const harness = createPollHarness({ states: ["working", "waiting", "working", "waiting"] });
    harness.environment.prRecheckAfterAgentCompletionArmedAt = "2026-08-01T12:00:00.000Z";
    let attempts = 0;
    const notifyAgentTurnCompleted = mock(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary notification failure");
    });
    harness.context.notifyAgentTurnCompleted = notifyAgentTurnCompleted;

    harness.manager.start("container-poll", harness.context);
    await waitFor(() => harness.emitted.length === 1);
    for (let expectedEmits = 2; expectedEmits <= 4; expectedEmits += 1) {
      harness.scheduled[0]!();
      await waitFor(() => harness.emitted.length === expectedEmits);
    }

    await waitFor(() => notifyAgentTurnCompleted.mock.calls.length === 2);
    expect(attempts).toBe(2);
    harness.manager.shutdown("container-poll");
  });

  test("emits the terminal source token when another source owns the aggregate timestamp", async () => {
    let persistenceCount = 0;
    const harness = createPollHarness({
      states: ["working", "idle"],
      persist: async (_environmentId, state) => {
        const sourceUpdatedAt = persistenceCount++ === 0
          ? "2026-07-27T12:00:00.000Z"
          : "2026-07-27T12:00:00.001Z";
        return {
          ...createEnvironment("/worktree", "env-poll"),
          containerId: "container-poll",
          agentActivityState: "working",
          agentActivityUpdatedAt: "2026-07-27T12:00:10.000Z",
          agentActivitySources: {
            frontend: {
              state: "working",
              updatedAt: "2026-07-27T12:00:10.000Z",
            },
            "claude-terminal": {
              state,
              updatedAt: sourceUpdatedAt,
            },
          },
        };
      },
    });

    harness.manager.start("container-poll", harness.context);
    await waitFor(() => harness.emitted.length === 1);
    harness.scheduled[0]!();
    await waitFor(() => harness.emitted.length === 2);

    expect(harness.emitted.map(({ payload }) => (
      payload as { occurred_at: string }
    ).occurred_at)).toEqual([
      "2026-07-27T12:00:00.000Z",
      "2026-07-27T12:00:00.001Z",
    ]);
    harness.manager.shutdown("container-poll");
  });

  test("keeps polling across idempotent subscriber leases until the environment stops", async () => {
    const harness = createPollHarness({
      states: ["working", "idle", "working"],
    });

    harness.manager.start("container-poll", harness.context, "client-a");
    harness.manager.start("container-poll", harness.context, "client-a");
    harness.manager.start("container-poll", harness.context, "client-b");
    await waitFor(() => harness.emitted.length === 1);

    await harness.manager.stop("container-poll", "client-a");
    await harness.manager.stop("container-poll", "client-a");
    expect(harness.cancelled.size).toBe(0);
    harness.scheduled[0]!();
    await waitFor(() => harness.emitted.length === 2);
    expect(harness.persisted.map((entry) => entry.state)).toEqual([
      "working",
      "idle",
    ]);

    await harness.manager.stop("container-poll", "client-b");
    expect(harness.cancelled.size).toBe(0);
    harness.environment.status = "stopped";
    harness.scheduled[0]!();
    await waitFor(() => harness.cancelled.size === 1);
    expect(harness.cancelled.size).toBe(1);
    harness.scheduled[0]!();
    await delay(0);
    expect(harness.persisted).toHaveLength(2);
  });

  test("serializes timer ticks and runs one trailing poll instead of overlapping reads", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const reads: Array<ReturnType<typeof deferred<string>>> = [first, second];
    let readCount = 0;
    const harness = createPollHarness({
      readState: async () => {
        const read = reads[readCount++];
        if (!read) return "";
        return read.promise;
      },
    });

    harness.manager.start("container-poll", harness.context);
    harness.scheduled[0]!();
    harness.scheduled[0]!();
    expect(readCount).toBe(1);

    first.resolve("working");
    await waitFor(() => readCount === 2);
    expect(harness.persisted.map((entry) => entry.state)).toEqual(["working"]);

    second.resolve("idle");
    await waitFor(() => harness.persisted.length === 2);
    expect(harness.persisted.map((entry) => entry.state)).toEqual([
      "working",
      "idle",
    ]);
    harness.manager.shutdown("container-poll");
  });

  test("discards an in-flight read after the environment stops", async () => {
    const state = deferred<string>();
    const harness = createPollHarness({
      readState: async () => state.promise,
    });

    harness.manager.start("container-poll", harness.context, "client-a");
    harness.environment.status = "stopped";
    await harness.manager.stop("container-poll", "client-a");
    state.resolve("working");
    await delay(0);

    expect(harness.persisted).toHaveLength(0);
    expect(harness.emitted).toHaveLength(0);
  });

  test("retries read and persistence failures without emitting stale state", async () => {
    let readCount = 0;
    let persistCount = 0;
    const harness = createPollHarness({
      readState: async () => {
        readCount += 1;
        if (readCount === 1) throw new Error("docker unavailable");
        return "waiting";
      },
      persist: async () => {
        persistCount += 1;
        if (persistCount === 1) throw new Error("disk unavailable");
        return {
          ...createEnvironment("/worktree", "env-poll"),
          containerId: "container-poll",
          agentActivityState: "waiting",
          agentActivityUpdatedAt: "2026-07-27T12:00:00.002Z",
          agentActivitySources: {
            "claude-terminal": {
              state: "waiting",
              updatedAt: "2026-07-27T12:00:00.002Z",
            },
          },
        };
      },
    });

    harness.manager.start("container-poll", harness.context);
    await delay(0);
    expect(harness.emitted).toHaveLength(0);

    harness.scheduled[0]!();
    await waitFor(() => persistCount === 1);
    expect(harness.emitted).toHaveLength(0);

    harness.scheduled[0]!();
    await waitFor(() => harness.emitted.length === 1);
    expect(persistCount).toBe(2);
    harness.manager.shutdown("container-poll");
  });

  test("ignores invalid states and retries an environment-load failure", async () => {
    let loadCount = 0;
    const environment = createEnvironment("/worktree", "env-poll");
    environment.containerId = "container-poll";
    const harness = createPollHarness({
      states: ["busy", "waiting", "waiting"],
      loadEnvironments: async () => {
        loadCount += 1;
        if (loadCount === 2) throw new Error("storage unavailable");
        return [environment];
      },
    });

    harness.manager.start("container-poll", harness.context);
    await delay(0);
    expect(loadCount).toBe(1);
    expect(harness.emitted).toHaveLength(0);

    harness.scheduled[0]!();
    await waitFor(() => loadCount === 2);
    expect(harness.persisted).toHaveLength(0);
    expect(harness.emitted).toHaveLength(0);

    harness.scheduled[0]!();
    await waitFor(() => harness.emitted.length === 1);
    expect(harness.persisted.map((entry) => entry.state)).toEqual(["waiting"]);
    harness.manager.shutdown("container-poll");
  });

  test("stops polling when no environment owns the container", async () => {
    const harness = createPollHarness({
      states: ["idle"],
      environments: [],
    });

    harness.manager.start("container-poll", harness.context);
    await waitFor(() => harness.cancelled.size === 1);

    expect(harness.persisted).toHaveLength(0);
    expect(harness.emitted).toHaveLength(0);
  });

  test("does not emit a state storage refused to record", async () => {
    // Storage rejects tokens older than the one it holds. Emitting anyway would
    // hand the renderer a state the backend does not believe, and advancing
    // lastState would mean the transition is never retried.
    let persistCount = 0;
    const harness = createPollHarness({
      states: ["working", "working", "working"],
      persist: async (_environmentId, state, occurredAt) => {
        persistCount += 1;
        return {
          ...createEnvironment("/worktree", "env-poll"),
          containerId: "container-poll",
          agentActivityState: "idle",
          agentActivityUpdatedAt: "2026-07-27T12:00:05.000Z",
          agentActivitySources: persistCount === 1
            // Rejected: storage kept its own newer observation for this source.
            ? {
              "claude-terminal": {
                state: "idle" as const,
                updatedAt: "2026-07-27T12:00:05.000Z",
              },
            }
            // A response that lost the source entirely is equally unusable.
            : persistCount === 2
              ? {}
              : {
                "claude-terminal": { state, updatedAt: occurredAt },
              },
        };
      },
    });

    harness.manager.start("container-poll", harness.context);
    await waitFor(() => persistCount === 1);
    expect(harness.emitted).toHaveLength(0);

    harness.scheduled[0]!();
    await waitFor(() => persistCount === 2);
    expect(harness.emitted).toHaveLength(0);

    // lastState was never advanced, so the same observation is retried and
    // lands as soon as storage accepts it.
    harness.scheduled[0]!();
    await waitFor(() => harness.emitted.length === 1);
    expect(persistCount).toBe(3);
    expect(harness.emitted[0]).toMatchObject({
      payload: { state: "working" },
    });
    harness.manager.shutdown("container-poll");
  });

  test("keeps polling when releasing a lease cannot read the environment", async () => {
    // Storage being unreadable says nothing about whether the container is
    // still running. Retiring the poll on that guess would silently stop
    // detecting activity; keeping it costs one read per second.
    const harness = createPollHarness({
      states: ["working"],
      loadEnvironments: async () => {
        throw new Error("storage unavailable");
      },
    });

    harness.manager.start("container-poll", harness.context, "client-a");
    await expect(harness.manager.stop("container-poll", "client-a"))
      .resolves.toBeUndefined();
    expect(harness.cancelled.size).toBe(0);
  });

  test("releasing an unknown container is a no-op", async () => {
    const harness = createPollHarness();
    await expect(harness.manager.stop("container-never-started", "client-a"))
      .resolves.toBeUndefined();
    expect(harness.cancelled.size).toBe(0);
  });

  test("adopts the newest caller's context for a poll already running", async () => {
    // The first registrant's connection may be gone by the time a later state
    // change is emitted; a later registrant's is at least as live.
    const harness = createPollHarness({ states: ["working"] });
    const secondEmitted: Array<{ event: string; payload: unknown }> = [];
    const secondContext = {
      ...harness.context,
      emit: (event: string, payload: unknown) =>
        secondEmitted.push({ event, payload }),
    } as unknown as CommandContext;

    harness.manager.start("container-poll", harness.context, "client-a");
    harness.manager.start("container-poll", secondContext, "client-b");
    await waitFor(() => secondEmitted.length === 1);

    expect(harness.emitted).toHaveLength(0);
    expect(secondEmitted[0]).toMatchObject({
      event: "claude-state-container-poll",
      payload: { state: "working" },
    });
    harness.manager.shutdown("container-poll");
  });

  test("retires a poll for a still-running environment when the container goes away", async () => {
    // stop_environment / delete_environment call this: the next read would exec
    // into a container that is already being torn down.
    const harness = createPollHarness({ states: ["working", "idle"] });

    harness.manager.start("container-poll", harness.context, "client-a");
    await waitFor(() => harness.emitted.length === 1);
    expect(harness.environment.status).toBe("running");

    harness.manager.shutdown("container-poll");
    expect(harness.cancelled.size).toBe(1);

    harness.scheduled[0]!();
    await delay(0);
    expect(harness.persisted).toHaveLength(1);
    expect(harness.emitted).toHaveLength(1);

    // Shutting down an already-retired poll is safe.
    expect(() => harness.manager.shutdown("container-poll")).not.toThrow();
  });

  test("coalesces any number of ticks behind one in-flight read into a single trailing poll", async () => {
    const reads: Array<ReturnType<typeof deferred<string>>> = [];
    const harness = createPollHarness({
      readState: async () => {
        const read = deferred<string>();
        reads.push(read);
        return read.promise;
      },
    });

    harness.manager.start("container-poll", harness.context);
    for (let tick = 0; tick < 5; tick += 1) harness.scheduled[0]!();
    expect(reads).toHaveLength(1);

    reads[0]!.resolve("working");
    await waitFor(() => reads.length === 2);
    // Five queued ticks collapse to exactly one trailing read, not five.
    expect(reads).toHaveLength(2);

    reads[1]!.resolve("idle");
    await waitFor(() => harness.persisted.length === 2);
    expect(reads).toHaveLength(2);
    harness.manager.shutdown("container-poll");
  });

  test("reads no storage at all on a tick that observed no change", async () => {
    // The read is a full parse of the environments file, once per second per
    // running container. A tick whose state matches the last one has nothing to
    // persist and nothing to emit, so it must not pay for it.
    let loadCount = 0;
    let readCount = 0;
    const environment = createEnvironment("/worktree", "env-poll");
    environment.containerId = "container-poll";
    const harness = createPollHarness({
      readState: async () => {
        readCount += 1;
        return readCount >= 4 ? "idle" : "working";
      },
      loadEnvironments: async () => {
        loadCount += 1;
        return [environment];
      },
    });

    harness.manager.start("container-poll", harness.context);
    await waitFor(() => harness.emitted.length === 1);
    // The first tick is a change, and it also establishes that the environment
    // is running.
    expect(loadCount).toBe(1);

    for (const expectedReads of [2, 3]) {
      harness.scheduled[0]!();
      await waitFor(() => readCount === expectedReads);
      await delay(5);
      expect(loadCount).toBe(1);
      expect(harness.emitted).toHaveLength(1);
    }

    // A real transition still consults storage immediately.
    harness.scheduled[0]!();
    await waitFor(() => harness.emitted.length === 2);
    expect(loadCount).toBe(2);
    expect(harness.persisted.map((entry) => entry.state)).toEqual(["working", "idle"]);
    harness.manager.shutdown("container-poll");
  });

  test("rechecks and retires an unchanged poll after fifteen seconds", async () => {
    let currentMs = 10_000;
    let loadCount = 0;
    const environment = createEnvironment("/worktree", "env-poll");
    environment.containerId = "container-poll";
    const harness = createPollHarness({
      readState: async () => "working",
      nowMs: () => currentMs,
      loadEnvironments: async () => {
        loadCount += 1;
        return [environment];
      },
    });

    harness.manager.start("container-poll", harness.context);
    await waitFor(() => harness.emitted.length === 1);
    expect(loadCount).toBe(1);

    currentMs += 14_999;
    harness.scheduled[0]!();
    await delay(0);
    expect(loadCount).toBe(1);

    environment.status = "stopped";
    currentMs += 1;
    harness.scheduled[0]!();
    await waitFor(() => harness.cancelled.size === 1);
    expect(loadCount).toBe(2);
    expect(harness.persisted).toHaveLength(1);
  });

  test("still retires a poll whose container never reports a usable state", async () => {
    // The storage read the unchanged path skips is also the retirement check.
    // A container that answers with nothing at all never takes the changed
    // branch, so the first tick has to check anyway — otherwise a container
    // that is already gone would be polled forever with nothing to notice it.
    const harness = createPollHarness({
      readState: async () => "",
      environments: [],
    });

    harness.manager.start("container-poll", harness.context);
    await waitFor(() => harness.cancelled.size === 1);
    expect(harness.persisted).toHaveLength(0);
    expect(harness.emitted).toHaveLength(0);
  });

  test("reads container state with a bounded docker exec", () => {
    // Every test above injects readState, so without this the real argv and
    // timeout are unverified — and a typo there degrades to "always idle".
    expect(claudeStateReadCommand("container-abc")).toEqual({
      command: "docker",
      args: ["exec", "container-abc", "cat", "/tmp/.claude-state"],
      options: { timeoutMs: CLAUDE_STATE_READ_TIMEOUT_MS },
    });
    expect(CLAUDE_STATE_READ_TIMEOUT_MS).toBe(5_000);
    expect(CLAUDE_STATE_POLL_INTERVAL_MS).toBe(1_000);
  });

  test("drives itself on a real interval when no scheduler is injected", async () => {
    // Covers the default schedule/cancel wiring: a broken clearInterval here
    // would leak a docker exec per second for the life of the process.
    const environment = createEnvironment("/worktree", "env-default-timer");
    environment.containerId = "container-default-timer";
    let readCount = 0;
    const manager = new ClaudeStatePollManager({
      readState: async () => {
        readCount += 1;
        return "working";
      },
    });
    const emitted: unknown[] = [];
    const context = {
      storage: {
        loadEnvironments: async () => [environment],
        setEnvironmentAgentActivity: async (
          _environmentId: string,
          state: "idle" | "working" | "waiting",
          occurredAt: string,
        ) => ({
          ...environment,
          agentActivitySources: {
            "claude-terminal": { state, updatedAt: occurredAt },
          },
        }),
      },
      emit: (_event: string, payload: unknown) => emitted.push(payload),
      appRoot: "",
      resourceRoot: "",
    } as unknown as CommandContext;

    manager.start("container-default-timer", context);
    await waitFor(() => emitted.length === 1);
    await waitFor(
      () => readCount >= 2,
      CLAUDE_STATE_POLL_INTERVAL_MS * 4,
    );

    manager.shutdown("container-default-timer");
    const readsAtShutdown = readCount;
    await delay(CLAUDE_STATE_POLL_INTERVAL_MS * 1.5);
    expect(readCount).toBe(readsAtShutdown);
  }, 10_000);

  test("the exported lifecycle shutdown is idempotent for an unknown container", () => {
    expect(() => shutdownClaudeStatePolling("container-never-started")).not.toThrow();
    expect(() => shutdownClaudeStatePolling("container-never-started")).not.toThrow();
  });
});

describe("container transcript discovery helpers", () => {
  test("builds a GNU find query scoped to fresh jsonl files in the project dir", () => {
    const command = newestJsonlFindCommand("/home/node/.claude/projects/-workspace", 1_700_000_000);
    expect(command).toContain("'/home/node/.claude/projects/-workspace'/");
    expect(command).toContain("-name '*.jsonl'");
    expect(command).toContain("-newermt @1700000000");
    expect(command).toContain("-printf '%T@ %p\\0'");
    expect(command).toContain("sort -z -rn");
  });

  test("parses a single NUL-framed find record into a path/mtime record", () => {
    const output = "1700000002.5 /home/node/.claude/projects/p/new.jsonl\0";
    expect(parseFreshJsonlFindOutput(output)).toEqual([
      { path: "/home/node/.claude/projects/p/new.jsonl", mtime: 1700000002.5 },
    ]);
  });

  test("returns no records for empty, legacy newline, or unterminated output", () => {
    expect(parseFreshJsonlFindOutput("")).toEqual([]);
    expect(parseFreshJsonlFindOutput("\n  \n")).toEqual([]);
    expect(parseFreshJsonlFindOutput(
      "1700000002 /home/node/.claude/projects/p/new.jsonl",
    )).toEqual([]);
  });

  test("parses every candidate when output contains multiple NUL records", () => {
    const output = `${[
      "1700000003 /home/node/.claude/projects/p/b.jsonl",
      "1700000002 /home/node/.claude/projects/p/a.jsonl",
    ].join("\0")}\0`;
    expect(parseFreshJsonlFindOutput(output)).toEqual([
      { path: "/home/node/.claude/projects/p/b.jsonl", mtime: 1700000003 },
      { path: "/home/node/.claude/projects/p/a.jsonl", mtime: 1700000002 },
    ]);
  });

  test("preserves spaces in the parsed path", () => {
    const output = "1700000002 /home/node/.claude/projects/p/with space.jsonl\0";
    expect(parseFreshJsonlFindOutput(output)).toEqual([
      { path: "/home/node/.claude/projects/p/with space.jsonl", mtime: 1700000002 },
    ]);
  });

  test("preserves newlines inside a filename rather than forging another record", () => {
    const pathWithNewline =
      "/home/node/.claude/projects/p/real.jsonl\n1700000999 outside.jsonl";
    expect(parseFreshJsonlFindOutput(`1700000002 ${pathWithNewline}\0`)).toEqual([
      { path: pathWithNewline, mtime: 1700000002 },
    ]);
  });

  test("skips records lacking a path field or with a non-finite mtime", () => {
    expect(parseFreshJsonlFindOutput("1700000002\0")).toEqual([]);
    expect(parseFreshJsonlFindOutput("notanumber /home/node/.claude/projects/p/x.jsonl\0")).toEqual([]);
    const mixed = `${[
      "1700000003 /home/node/.claude/projects/p/good.jsonl",
      "1700000002", // no path
      "bad /home/node/.claude/projects/p/skip.jsonl", // non-finite mtime
    ].join("\0")}\0`;
    expect(parseFreshJsonlFindOutput(mixed)).toEqual([
      { path: "/home/node/.claude/projects/p/good.jsonl", mtime: 1700000003 },
    ]);
  });

  test("accepts only normalized direct jsonl children", () => {
    const dir = "/home/node/.claude/projects/p";
    expect(isDirectJsonlChild(dir, `${dir}/session.jsonl`)).toBe(true);
    expect(isDirectJsonlChild(dir, `${dir}/with\nnewline.jsonl`)).toBe(true);
    expect(isDirectJsonlChild(dir, `${dir}/nested/session.jsonl`)).toBe(false);
    expect(isDirectJsonlChild(dir, `${dir}/../outside.jsonl`)).toBe(false);
    expect(isDirectJsonlChild(dir, "outside.jsonl")).toBe(false);
    expect(isDirectJsonlChild(dir, `${dir}/session.txt`)).toBe(false);
  });

  test("bounds local stat concurrency and returns only the newest fifty jsonl files", async () => {
    const names = Array.from({ length: 100 }, (_, index) => `session-${index}.jsonl`);
    names.push("ignore.txt");
    let inFlight = 0;
    let maxInFlight = 0;
    const entries = await listLocalJsonlByMtime(
      "/tmp/transcripts",
      names,
      async (filePath) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await delay(1);
        inFlight -= 1;
        return Number(filePath.match(/(\d+)\.jsonl$/)?.[1] ?? 0);
      },
    );

    expect(maxInFlight).toBeLessThanOrEqual(PREVIOUS_SESSION_STAT_CONCURRENCY);
    expect(entries).toHaveLength(50);
    expect(entries[0]?.path).toEndWith("session-99.jsonl");
    expect(entries.at(-1)?.path).toEndWith("session-50.jsonl");
  });
});

describe("transcriptContainsSessionId", () => {
  test("matches a top-level camelCase sessionId", () => {
    const content = `${JSON.stringify({ sessionId: "abc-123", type: "assistant" })}\n`;
    expect(transcriptContainsSessionId(content, "abc-123")).toBe(true);
  });

  test("matches a top-level snake_case session_id", () => {
    const content = `${JSON.stringify({ session_id: "abc-123", type: "user" })}\n`;
    expect(transcriptContainsSessionId(content, "abc-123")).toBe(true);
  });

  test("matches a session id nested inside objects and arrays", () => {
    const content = `${JSON.stringify({
      type: "assistant",
      message: { meta: [{ session_id: "deep-999" }] },
    })}\n`;
    expect(transcriptContainsSessionId(content, "deep-999")).toBe(true);
  });

  test("does not match a different session id", () => {
    const content = `${JSON.stringify({ sessionId: "other-session", type: "assistant" })}\n`;
    expect(transcriptContainsSessionId(content, "abc-123")).toBe(false);
  });

  test("scans later lines and skips malformed JSON lines", () => {
    const content = [
      "not json at all",
      "{ still not: valid",
      JSON.stringify({ sessionId: "abc-123", type: "assistant" }),
    ].join("\n");
    expect(transcriptContainsSessionId(content, "abc-123")).toBe(true);
  });

  test("returns false for empty content or empty session id", () => {
    expect(transcriptContainsSessionId("", "abc-123")).toBe(false);
    expect(transcriptContainsSessionId(`${JSON.stringify({ sessionId: "abc-123" })}\n`, "")).toBe(false);
  });

  test("parses each line of a non-matching transcript exactly once", () => {
    // The miss is the hot case: discovery re-reads every candidate transcript
    // in the project directory on each 250ms poll tick until one binds. A
    // shallow pre-pass over the whole file can only ever win on a *match*,
    // because the deep walk tests the same top-level keys before it recurses —
    // so running both doubled the JSON.parse cost of every file that does not
    // own the session.
    const content = Array.from(
      { length: 20 },
      (_, index) => JSON.stringify({ sessionId: `other-${index}`, message: { role: "user" } }),
    ).join("\n");

    const realParse = JSON.parse;
    let parses = 0;
    JSON.parse = ((text: string) => {
      parses += 1;
      return realParse(text);
    }) as typeof JSON.parse;
    try {
      expect(transcriptContainsSessionId(content, "wanted-session")).toBe(false);
    } finally {
      JSON.parse = realParse;
    }

    expect(parses).toBe(20);
  });
});

describe("newestJsonlInDir container backend", () => {
  type Backend = Parameters<typeof newestJsonlInDir>[0];

  function makeContainerBackend(
    findStdout: string,
    files: Record<string, string>,
  ): { backend: Backend; readPaths: string[] } {
    const readPaths: string[] = [];
    const backend = {
      kind: "container",
      async exec(_args: string[]) {
        return { stdout: findStdout, stderr: "", exitCode: 0 };
      },
      async readFile(filePath: string) {
        readPaths.push(filePath);
        return files[filePath];
      },
    } as unknown as Backend;
    return { backend, readPaths };
  }

  test("resolves the single container jsonl owned by the session", async () => {
    const findStdout = `${[
      "1700000003 /home/node/.claude/projects/p/other.jsonl",
      "1700000002 /home/node/.claude/projects/p/owned.jsonl",
    ].join("\0")}\0`;
    const { backend } = makeContainerBackend(findStdout, {
      "/home/node/.claude/projects/p/other.jsonl": `${JSON.stringify({ sessionId: "other" })}\n`,
      "/home/node/.claude/projects/p/owned.jsonl": `${JSON.stringify({ sessionId: "mine" })}\n`,
    });
    await expect(
      newestJsonlInDir(backend, "/home/node/.claude/projects/p", 1700000000, "mine"),
    ).resolves.toBe("/home/node/.claude/projects/p/owned.jsonl");
  });

  test("returns undefined when no container jsonl claims the session", async () => {
    const findStdout = "1700000003 /home/node/.claude/projects/p/other.jsonl\0";
    const { backend } = makeContainerBackend(findStdout, {
      "/home/node/.claude/projects/p/other.jsonl": `${JSON.stringify({ sessionId: "other" })}\n`,
    });
    await expect(
      newestJsonlInDir(backend, "/home/node/.claude/projects/p", 1700000000, "mine"),
    ).resolves.toBeUndefined();
  });

  test("returns undefined when multiple container jsonls claim the same session", async () => {
    const findStdout = `${[
      "1700000003 /home/node/.claude/projects/p/a.jsonl",
      "1700000002 /home/node/.claude/projects/p/b.jsonl",
    ].join("\0")}\0`;
    const { backend } = makeContainerBackend(findStdout, {
      "/home/node/.claude/projects/p/a.jsonl": `${JSON.stringify({ sessionId: "mine" })}\n`,
      "/home/node/.claude/projects/p/b.jsonl": `${JSON.stringify({ sessionId: "mine" })}\n`,
    });
    await expect(
      newestJsonlInDir(backend, "/home/node/.claude/projects/p", 1700000000, "mine"),
    ).resolves.toBeUndefined();
  });

  test("never turns a newline filename into an out-of-directory read", async () => {
    const dir = "/home/node/.claude/projects/p";
    const findStdout = `${[
      `1700000005 ${dir}/safe.jsonl\n1700000999 outside.jsonl`,
      `1700000004 ${dir}/nested/owned.jsonl`,
      `1700000003 ${dir}/../outside.jsonl`,
      "1700000002 relative.jsonl",
      `1700000001 ${dir}/owned.txt`,
      `1700000000 ${dir}/owned.jsonl`,
    ].join("\0")}\0`;
    const { backend, readPaths } = makeContainerBackend(findStdout, {
      [`${dir}/owned.jsonl`]: `${JSON.stringify({ sessionId: "mine" })}\n`,
    });

    await expect(
      newestJsonlInDir(backend, dir, 1700000000, "mine"),
    ).resolves.toBe(`${dir}/owned.jsonl`);
    expect(readPaths).toEqual([
      `${dir}/safe.jsonl\n1700000999 outside.jsonl`,
      `${dir}/owned.jsonl`,
    ]);
    expect(readPaths).not.toContain("outside.jsonl");
    expect(readPaths.every((readPath) => path.posix.dirname(readPath) === dir)).toBe(true);
  });
});

describe("thinking display capability probe", () => {
  function result(overrides: Partial<ExecOutput>): ExecOutput {
    return { status: 0, stdout: "", stderr: "", ...overrides };
  }

  const invalidDisplayArgument =
    "error: option '--thinking-display <display>' argument '__orkestrator_probe__' is invalid."
    + " Allowed choices are summarized, omitted.";

  test("probes both launch flags at once and stays off the API path", () => {
    expect(thinkingDisplayProbeArgs("/opt/toolchains/claude")).toEqual([
      "/opt/toolchains/claude",
      "--thinking",
      "adaptive",
      "--thinking-display",
      "__orkestrator_probe__",
      "--version",
    ]);
  });

  test("reads an argument-validation failure that names the flag as support", () => {
    expect(thinkingDisplayProbeIndicatesSupport(result({ status: 1, stderr: invalidDisplayArgument }))).toBe(true);
    // Some CLIs report usage errors on stdout.
    expect(thinkingDisplayProbeIndicatesSupport(result({ status: 1, stdout: invalidDisplayArgument }))).toBe(true);
  });

  test("rejects a CLI that does not know --thinking", () => {
    expect(thinkingDisplayProbeIndicatesSupport(
      result({ status: 1, stderr: "error: unknown option '--thinking'" }),
    )).toBe(false);
  });

  test("rejects a CLI that does not know --thinking-display", () => {
    expect(thinkingDisplayProbeIndicatesSupport(
      result({ status: 1, stderr: "error: unknown option '--thinking-display'" }),
    )).toBe(false);
  });

  test("rejects an unknown-option report whatever its casing", () => {
    expect(thinkingDisplayProbeIndicatesSupport(
      result({ status: 2, stderr: "Unknown option: --thinking-display" }),
    )).toBe(false);
  });

  test("rejects a CLI that ignores the flags and exits 0", () => {
    expect(thinkingDisplayProbeIndicatesSupport(
      result({ status: 0, stdout: "2.1.2", stderr: "ignoring --thinking-display" }),
    )).toBe(false);
  });

  test("rejects a probe that failed without naming the flag", () => {
    expect(thinkingDisplayProbeIndicatesSupport(result({ status: 1, stderr: "boom" }))).toBe(false);
    // A killed probe: execWithOutput reports -1 and appends this to stderr.
    expect(thinkingDisplayProbeIndicatesSupport(result({ status: -1, stderr: "Command timed out" }))).toBe(false);
  });

  test("bounds the probe so a hung CLI cannot stall session start", async () => {
    const calls: Array<{ args: string[]; stdin?: string; timeoutMs?: number }> = [];
    const supported = await probeThinkingDisplaySupport(async (args, stdin, timeoutMs) => {
      calls.push({ args, stdin, timeoutMs });
      return result({ status: 1, stderr: invalidDisplayArgument });
    }, "claude");

    expect(supported).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(thinkingDisplayProbeArgs("claude"));
    expect(calls[0]!.stdin).toBeUndefined();
    expect(calls[0]!.timeoutMs).toBeGreaterThan(0);
    expect(calls[0]!.timeoutMs).toBeLessThanOrEqual(15_000);
  });

  test("survives the container wrapper unchanged", () => {
    // Container environments run the same probe through `docker exec`; a
    // rewritten or re-ordered argv would change what the CLI validates.
    expect(containerExecArgs("container-1", thinkingDisplayProbeArgs("claude"), false)).toEqual([
      "exec",
      "-u",
      "node",
      "-w",
      "/workspace",
      "container-1",
      "claude",
      "--thinking",
      "adaptive",
      "--thinking-display",
      "__orkestrator_probe__",
      "--version",
    ]);
    // `-i` is attached only when the caller actually pipes stdin.
    expect(containerExecArgs("container-1", ["cat"], true).slice(0, 7)).toEqual([
      "exec",
      "-u",
      "node",
      "-w",
      "/workspace",
      "-i",
      "container-1",
    ]);
  });

  test("fails closed when the probe cannot be spawned at all", async () => {
    const missingBinary = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    await expect(probeThinkingDisplaySupport(async () => {
      throw missingBinary;
    }, "claude")).resolves.toBe(false);
  });
});

describe("TranscriptTail incremental reads", () => {
  type Backend = Parameters<TranscriptTail["readNew"]>[0];

  /**
   * A backend whose file can be replaced between reads, recording the offset of
   * every read so "only the appended bytes were fetched" is assertable.
   */
  function fakeBackend(file: { bytes: Buffer }): {
    backend: Backend;
    reads: Array<{ offset: number; length: number }>;
  } {
    const reads: Array<{ offset: number; length: number }> = [];
    const backend = {
      async fileSize() {
        return file.bytes.length;
      },
      async readFileBytesFrom(_filePath: string, offset: number) {
        const slice = Buffer.from(file.bytes.subarray(offset));
        reads.push({ offset, length: slice.length });
        return slice;
      },
      async readFile() {
        throw new Error("the tail must never read the whole transcript");
      },
    } as unknown as Backend;
    return { backend, reads };
  }

  const jsonl = (value: unknown) => `${JSON.stringify(value)}\n`;

  test("fetches only what was appended since the previous read", async () => {
    const first = jsonl({ n: 1 });
    const second = jsonl({ n: 2 });
    const file = { bytes: Buffer.from(first, "utf8") };
    const { backend, reads } = fakeBackend(file);
    const tail = new TranscriptTail("/transcript.jsonl");

    await expect(tail.readNew(backend)).resolves.toEqual([{ n: 1 }]);
    expect(reads).toEqual([{ offset: 0, length: Buffer.byteLength(first) }]);

    file.bytes = Buffer.from(first + second, "utf8");
    await expect(tail.readNew(backend)).resolves.toEqual([{ n: 2 }]);
    expect(reads[1]).toEqual({
      offset: Buffer.byteLength(first),
      length: Buffer.byteLength(second),
    });
  });

  test("does not read at all when the known size says nothing was appended", async () => {
    const line = jsonl({ n: 1 });
    const file = { bytes: Buffer.from(line, "utf8") };
    const { backend, reads } = fakeBackend(file);
    const tail = new TranscriptTail("/transcript.jsonl");

    await tail.readNew(backend, Buffer.byteLength(line));
    expect(reads).toHaveLength(1);
    // The poll loop already stat'd the file in its snapshot; an unchanged size
    // must cost neither a second stat nor a read.
    await expect(tail.readNew(backend, Buffer.byteLength(line))).resolves.toEqual([]);
    expect(reads).toHaveLength(1);
  });

  test("keeps its byte offset when the size read fails transiently", async () => {
    const first = jsonl({ n: 1 });
    const second = jsonl({ n: 2 });
    const file = { bytes: Buffer.from(first, "utf8") };
    const { backend, reads } = fakeBackend(file);
    const tail = new TranscriptTail("/transcript.jsonl");

    await expect(tail.readNew(backend)).resolves.toEqual([{ n: 1 }]);
    const unavailable = {
      ...backend,
      fileSize: async () => {
        throw new Error("combined poll unavailable");
      },
    } as Backend;
    await expect(tail.readNew(unavailable)).rejects.toThrow("combined poll unavailable");

    file.bytes = Buffer.from(first + second, "utf8");
    await expect(tail.readNew(backend)).resolves.toEqual([{ n: 2 }]);
    expect(reads.at(-1)).toEqual({
      offset: Buffer.byteLength(first),
      length: Buffer.byteLength(second),
    });
  });

  test("rejoins a multi-byte character split across two reads", async () => {
    // Reading from an offset means a chunk can end in the middle of a UTF-8
    // sequence. Decoding each chunk on its own would turn the split character
    // into two U+FFFD replacements and the line would no longer parse.
    const full = Buffer.from(jsonl({ text: "£100 — done" }), "utf8");
    const poundStart = full.indexOf(0xc2);
    expect(poundStart).toBeGreaterThan(0);
    const splitAt = poundStart + 1;

    const file = { bytes: Buffer.from(full.subarray(0, splitAt)) };
    const { backend, reads } = fakeBackend(file);
    const tail = new TranscriptTail("/transcript.jsonl");

    // No newline yet, so nothing is emitted and the half character is carried.
    await expect(tail.readNew(backend)).resolves.toEqual([]);

    file.bytes = full;
    await expect(tail.readNew(backend)).resolves.toEqual([{ text: "£100 — done" }]);
    expect(reads[1]!.offset).toBe(splitAt);
  });

  test("carries an unterminated line until its newline arrives", async () => {
    const line = jsonl({ n: 7 });
    const partialAt = line.length - 3;
    const file = { bytes: Buffer.from(line.slice(0, partialAt), "utf8") };
    const { backend } = fakeBackend(file);
    const tail = new TranscriptTail("/transcript.jsonl");

    await expect(tail.readNew(backend)).resolves.toEqual([]);
    file.bytes = Buffer.from(line, "utf8");
    await expect(tail.readNew(backend)).resolves.toEqual([{ n: 7 }]);
  });

  test("restarts from byte zero and discards stale partial data after truncation or rotation", async () => {
    const original = `${jsonl({ old: 1 })}${JSON.stringify({ stale: true }).slice(0, 8)}`;
    const file = { bytes: Buffer.from(original, "utf8") };
    const { backend, reads } = fakeBackend(file);
    const tail = new TranscriptTail("/transcript.jsonl");

    await expect(tail.readNew(backend)).resolves.toEqual([{ old: 1 }]);

    const replacement = jsonl({ fresh: 2 });
    expect(Buffer.byteLength(replacement)).toBeLessThan(Buffer.byteLength(original));
    file.bytes = Buffer.from(replacement, "utf8");
    await expect(tail.readNew(backend)).resolves.toEqual([{ fresh: 2 }]);
    expect(reads.at(-1)).toEqual({ offset: 0, length: Buffer.byteLength(replacement) });
  });

  test("skips malformed lines without losing the ones around them", async () => {
    const content = `${JSON.stringify({ n: 1 })}\nnot json\n${JSON.stringify({ n: 2 })}\n`;
    const file = { bytes: Buffer.from(content, "utf8") };
    const { backend } = fakeBackend(file);

    await expect(new TranscriptTail("/transcript.jsonl").readNew(backend))
      .resolves.toEqual([{ n: 1 }, { n: 2 }]);
  });

  test("reads from the byte after the offset in container mode", () => {
    // `tail -c +N` is 1-based: +1 is the whole file, so the first unread byte
    // of a 40-byte prefix is +41. An off-by-one here duplicates or drops a byte
    // of every append.
    expect(tailFromOffsetCommand("/home/node/.claude/t.jsonl", 0))
      .toContain("tail -c +1 '/home/node/.claude/t.jsonl'");
    expect(tailFromOffsetCommand("/home/node/.claude/t.jsonl", 40))
      .toContain("tail -c +41 '/home/node/.claude/t.jsonl'");
  });
});

describe("interactive tmux terminal snapshots", () => {
  test("emits line patches and falls back for resize-shaped redraws", () => {
    expect(buildTmuxPaneUpdate("one\ntwo\nthree", "one\nTWO\nthree")).toEqual({
      text: "\u001b[2;1H\u001b[2KTWO",
      full: false,
    });
    expect(buildTmuxPaneUpdate(
      "one\ntwo\nthree",
      "one\n\u001b[31mTWO\u001b[0m\nthree",
    )).toEqual({
      text: "\u001b[2;1H\u001b[2K\u001b[31mTWO\u001b[0m",
      full: false,
    });
    expect(buildTmuxPaneUpdate("one\ntwo", "one\ntwo\nthree")).toEqual({
      text: "\u001b[H\u001b[2Jone\r\ntwo\r\nthree",
      full: true,
    });
    expect(buildTmuxPaneUpdate("one\ntwo", "\n")).toEqual({
      text: "\u001b[H\u001b[2J",
      full: true,
    });
    expect(buildTmuxPaneUpdate("same", "same")).toEqual({
      text: "",
      full: false,
    });
    expect(buildTmuxPaneUpdate("same", "same", true)).toEqual({
      text: "\u001b[H\u001b[2Jsame",
      full: true,
    });
  });
  /**
   * `tmux capture-pane -p` terminates *every* row, so a capture of an N-row
   * pane contains N newlines. Replaying that verbatim issues a line feed with
   * the cursor already on the bottom row, which scrolls the viewport by one and
   * leaves every later line address naming the wrong row. Verified against tmux
   * 3.6a: a 6-row pane showing two lines captures as "line1\nline2\n\n\n\n\n".
   */
  test("keeps repaint and patch row addressing agreed on a real capture", () => {
    const before = "line1\nline2\n\n\n\n\n";
    const after = "line1\nLINE2\n\n\n\n\n";

    const repaint = buildTmuxPaneUpdate(undefined, before);
    expect(repaint.full).toBe(true);
    // Six rows written with five separators: the cursor finishes on the last
    // row without ever scrolling, so row R keeps displaying capture line R.
    expect(repaint.text).toBe(
      "\u001b[H\u001b[2Jline1\r\nline2\r\n\r\n\r\n\r\n",
    );
    expect(repaint.text.split("\r\n")).toHaveLength(6);

    // `line2` is capture line 2, so it must be patched at row 2.
    expect(buildTmuxPaneUpdate(before, after)).toEqual({
      text: "\u001b[2;1H\u001b[2KLINE2",
      full: false,
    });
  });

  test("treats a terminated and an unterminated capture as the same pane", () => {
    expect(buildTmuxPaneUpdate("one\ntwo\nthree\n", "one\nTWO\nthree\n")).toEqual({
      text: "\u001b[2;1H\u001b[2KTWO",
      full: false,
    });
    // Row count is what forces a repaint, so a terminator present on only one
    // side must not read as an extra row.
    expect(buildTmuxPaneUpdate("one\ntwo\nthree", "one\nTWO\nthree\n")).toEqual({
      text: "\u001b[2;1H\u001b[2KTWO",
      full: false,
    });
    expect(buildTmuxPaneUpdate("one\ntwo\n", "one\ntwo\nthree\n")).toEqual({
      text: "\u001b[H\u001b[2Jone\r\ntwo\r\nthree",
      full: true,
    });
  });

  test("repaints blank and empty captures without a trailing feed", () => {
    expect(buildTmuxPaneUpdate(undefined, "\n\n\n")).toEqual({
      text: "\u001b[H\u001b[2J\r\n\r\n",
      full: true,
    });
    expect(buildTmuxPaneUpdate(undefined, "")).toEqual({
      text: "\u001b[H\u001b[2J",
      full: true,
    });
  });

  function createInteractiveHarness(
    captures: Array<string | Promise<string>>,
    resizes: Array<void | Promise<void>> = [],
  ) {
    const scheduled: Array<{ callback: () => void; delayMs: number; timer: object }> = [];
    const cancelled = new Set<unknown>();
    const emitted: Array<{ event: string; payload: unknown }> = [];
    let captureIndex = 0;
    let resizeIndex = 0;
    const resizeCalls: Array<{ cols: number; rows: number }> = [];
    let writes = 0;
    const tmux = {
      environmentId: "env-interactive",
      tabId: "tab-interactive",
      resize: async (cols: number, rows: number) => {
        resizeCalls.push({ cols, rows });
        const resize = resizes[resizeIndex++];
        if (resize) await resize;
      },
      writeInteractive: async () => {
        writes += 1;
      },
      capturePane: async () => {
        const capture = captures[captureIndex++];
        if (capture === undefined) throw new Error("unexpected capture");
        return await capture;
      },
    };
    const manager = new InteractiveTmuxTerminalManager({
      schedule: (callback, delayMs) => {
        const timer = {};
        scheduled.push({ callback, delayMs, timer });
        return timer;
      },
      cancel: (timer) => {
        cancelled.add(timer);
      },
    });
    const id = manager.create(tmux as never, 120, 40);
    const context = {
      emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
    } as unknown as CommandContext;
    return {
      manager,
      id,
      context,
      scheduled,
      cancelled,
      emitted,
      resizeCalls,
      captureCount: () => captureIndex,
      writeCount: () => writes,
    };
  }

  test("backs off on unchanged panes and resets on output or input", async () => {
    const harness = createInteractiveHarness(["same", "same", "changed"]);
    await harness.manager.start(harness.id, harness.context);

    expect(harness.emitted).toHaveLength(1);
    expect(harness.scheduled[0]?.delayMs).toBe(INTERACTIVE_SNAPSHOT_MIN_MS);

    harness.scheduled[0]!.callback();
    await waitFor(() => harness.scheduled.length === 2);
    expect(harness.emitted).toHaveLength(1);
    expect(harness.scheduled[1]?.delayMs).toBe(
      Math.min(INTERACTIVE_SNAPSHOT_MAX_MS, INTERACTIVE_SNAPSHOT_MIN_MS * 2),
    );

    harness.scheduled[1]!.callback();
    await waitFor(() => harness.scheduled.length === 3);
    expect(harness.emitted).toHaveLength(2);
    expect(harness.scheduled[2]?.delayMs).toBe(INTERACTIVE_SNAPSHOT_MIN_MS);

    await harness.manager.write(harness.id, "x");
    expect(harness.writeCount()).toBe(1);
    expect(harness.scheduled.at(-1)?.delayMs).toBe(INTERACTIVE_SNAPSHOT_MIN_MS);
  });

  test("sustained typing cannot push the pending capture out", async () => {
    // The renderer sends one write per keystroke. Anything faster than one
    // character per INTERACTIVE_SNAPSHOT_MIN_MS — ordinary typing, or OS key
    // auto-repeat — used to cancel and re-arm the capture on every keystroke,
    // so the pane emitted nothing at all until the user stopped typing.
    const harness = createInteractiveHarness(["initial", "typed"]);
    await harness.manager.start(harness.id, harness.context);
    const armed = harness.scheduled[0]!;

    for (const char of "hello world") await harness.manager.write(harness.id, char);

    expect(harness.writeCount()).toBe(11);
    expect(harness.cancelled).not.toContain(armed.timer);
    expect(harness.scheduled).toHaveLength(1);

    armed.callback();
    await waitFor(() => harness.emitted.length === 2);
  });

  test("input pulls a backed-off capture forward", async () => {
    const harness = createInteractiveHarness(["same", "same", "same"]);
    await harness.manager.start(harness.id, harness.context);

    harness.scheduled[0]!.callback();
    await waitFor(() => harness.scheduled.length === 2);
    harness.scheduled[1]!.callback();
    await waitFor(() => harness.scheduled.length === 3);
    const backedOff = harness.scheduled[2]!;
    expect(backedOff.delayMs).toBeGreaterThan(INTERACTIVE_SNAPSHOT_MIN_MS);

    await harness.manager.write(harness.id, "x");

    expect(harness.cancelled).toContain(backedOff.timer);
    expect(harness.scheduled.at(-1)?.delayMs).toBe(INTERACTIVE_SNAPSHOT_MIN_MS);
  });

  test("a failed capture does not stop the interactive pane polling", async () => {
    // One transient `tmux capture-pane` failure — a resize race, a momentarily
    // busy server — must not leave the terminal permanently frozen.
    const failing = deferred<string>();
    const harness = createInteractiveHarness(["initial", failing.promise, "recovered"]);
    await harness.manager.start(harness.id, harness.context);

    harness.scheduled[0]!.callback();
    await waitFor(() => harness.captureCount() === 2);
    failing.reject(new Error("tmux capture-pane failed"));

    await waitFor(() => harness.scheduled.length === 2);
    harness.scheduled[1]!.callback();
    await waitFor(() => harness.emitted.length === 2);
  });

  test("detach suppresses an in-flight capture and prevents rescheduling", async () => {
    const pending = deferred<string>();
    const harness = createInteractiveHarness(["initial", pending.promise]);
    await harness.manager.start(harness.id, harness.context);

    harness.scheduled[0]!.callback();
    await waitFor(() => harness.captureCount() === 2);
    harness.manager.detach(harness.id);
    expect(harness.cancelled).toContain(harness.scheduled[0]!.timer);

    pending.resolve("too late");
    await delay(0);
    expect(harness.emitted).toHaveLength(1);
    expect(harness.scheduled).toHaveLength(1);
  });

  test("forced recovery invalidates an older in-flight capture", async () => {
    const stale = deferred<string>();
    const harness = createInteractiveHarness(["initial", stale.promise, "recovered"]);
    await harness.manager.start(harness.id, harness.context);

    harness.scheduled[0]!.callback();
    await waitFor(() => harness.captureCount() === 2);

    const recovery = harness.manager.start(harness.id, harness.context);
    await waitFor(() => harness.captureCount() === 3);
    await recovery;

    expect(harness.emitted).toHaveLength(2);
    expect(harness.emitted[1]).toEqual({
      event: `terminal-output-${harness.id}`,
      payload: expect.objectContaining({ text: expect.stringContaining("recovered"), full: true }),
    });

    stale.resolve("stale capture");
    await delay(0);
    expect(harness.emitted).toHaveLength(2);
  });

  test("resize discards an in-flight capture and makes the next frame full", async () => {
    const stale = deferred<string>();
    const harness = createInteractiveHarness(["initial", stale.promise, "resized pane"]);
    await harness.manager.start(harness.id, harness.context);

    harness.scheduled[0]!.callback();
    await waitFor(() => harness.captureCount() === 2);
    await harness.manager.resize(harness.id, 90, 24);

    stale.resolve("old geometry");
    await waitFor(() => harness.scheduled.length === 2);
    expect(harness.emitted).toHaveLength(1);

    harness.scheduled[1]!.callback();
    await waitFor(() => harness.emitted.length === 2);
    expect(harness.emitted[1]).toEqual({
      event: `terminal-output-${harness.id}`,
      payload: expect.objectContaining({ text: expect.stringContaining("resized pane"), full: true }),
    });
  });

  test("serializes overlapping geometry changes in request order", async () => {
    const firstResize = deferred<void>();
    const secondResize = deferred<void>();
    const harness = createInteractiveHarness(
      ["initial"],
      [undefined, firstResize.promise, secondResize.promise],
    );
    await harness.manager.start(harness.id, harness.context);

    const first = harness.manager.resize(harness.id, 100, 30);
    await waitFor(() => harness.resizeCalls.length === 2);
    const second = harness.manager.resize(harness.id, 80, 20);
    await delay(0);
    expect(harness.resizeCalls).toHaveLength(2);

    firstResize.resolve(undefined);
    await first;
    await waitFor(() => harness.resizeCalls.length === 3);
    secondResize.resolve(undefined);
    await second;

    expect(harness.resizeCalls).toEqual([
      { cols: 120, rows: 40 },
      { cols: 100, rows: 30 },
      { cols: 80, rows: 20 },
    ]);
  });

  test("resumes captures after a failed resize instead of staying suspended", async () => {
    const failedResize = deferred<void>();
    const harness = createInteractiveHarness(
      ["initial", "after failed resize"],
      [undefined, failedResize.promise],
    );
    await harness.manager.start(harness.id, harness.context);

    const resize = harness.manager.resize(harness.id, 90, 24);
    await waitFor(() => harness.resizeCalls.length === 2);
    failedResize.reject(new Error("tmux resize-window failed"));
    // The caller still sees the failure, but capture suspension must not outlive
    // it — the pane would otherwise emit nothing for the rest of the session.
    await expect(resize).rejects.toThrow("tmux resize-window failed");

    harness.scheduled[0]!.callback();
    await waitFor(() => harness.emitted.length === 2);
    expect(harness.emitted[1]).toEqual({
      event: `terminal-output-${harness.id}`,
      payload: expect.objectContaining({
        text: expect.stringContaining("after failed resize"),
        full: true,
      }),
    });
  });

  test("does not resurrect a detached terminal from a late geometry change", async () => {
    const harness = createInteractiveHarness(["initial"]);
    await harness.manager.start(harness.id, harness.context);
    harness.manager.detach(harness.id);

    await expect(harness.manager.resize(harness.id, 80, 20)).rejects.toThrow();
    expect(harness.captureCount()).toBe(1);
    expect(harness.emitted).toHaveLength(1);
  });
});

describe("poll snapshot", () => {
  const paths = { pendingDir: "/tmp/run/pending", timeoutDir: "/tmp/run/timeout" };

  test("asks for both hook listings and the transcript size in one script", () => {
    const script = pollSnapshotScript(paths.pendingDir, paths.timeoutDir, "/home/node/t.jsonl");
    expect(script).toContain(`ls -1 '${paths.pendingDir}'`);
    expect(script).toContain(`ls -1 '${paths.timeoutDir}'`);
    expect(script).toContain("stat -c %s '/home/node/t.jsonl'");
  });

  test("reports a zero size before the transcript has been discovered", () => {
    const script = pollSnapshotScript(paths.pendingDir, paths.timeoutDir, undefined);
    expect(script).not.toContain("stat -c %s");
    expect(parsePollSnapshotOutput("__ork_pending__\n__ork_timeout__\n__ork_size__\n0\n"))
      .toEqual({ pending: [], timeouts: [], transcriptSize: 0 });
  });

  test("partitions the combined output back into its three sections", () => {
    expect(parsePollSnapshotOutput([
      "__ork_pending__",
      "PreToolUse-1.json",
      "Stop-2.json",
      "__ork_timeout__",
      "PermissionRequest-3.json",
      "__ork_size__",
      "4096",
      "",
    ].join("\n"))).toEqual({
      pending: ["PreToolUse-1.json", "Stop-2.json"],
      timeouts: ["PermissionRequest-3.json"],
      transcriptSize: 4096,
    });
  });

  test("rejects malformed or incomplete output instead of inventing an empty snapshot", () => {
    expect(() => parsePollSnapshotOutput(
      "__ork_pending__\n__ork_timeout__\n__ork_size__\nnot-a-number\n",
    )).toThrow("Malformed tmux poll snapshot transcript size");
    expect(() => parsePollSnapshotOutput("")).toThrow("Incomplete tmux poll snapshot");
    expect(() => parsePollSnapshotOutput(
      "__ork_pending__\n__ork_timeout__\n__ork_size__\n",
    )).toThrow("Incomplete tmux poll snapshot");
  });

  test("rejects a failed combined poll before its empty stdout can reset a tail", () => {
    expect(() => parsePollSnapshotExecOutput({
      status: 1,
      stdout: "",
      stderr: "docker exec failed",
    })).toThrow("docker exec failed");
  });

  test("checks liveness on a slower cadence than the hook and transcript reads", () => {
    // Every check is its own process spawn (a `docker exec` in container mode)
    // and can only report a session that has already ended.
    expect(LIVENESS_CHECK_EVERY_TICKS).toBe(8);
  });
});

describe("previous-session metadata reads", () => {
  test("asks for the line count and only the head of a transcript", () => {
    const command = transcriptHeadCommand("/home/node/.claude/projects/p/a.jsonl", 65536);
    expect(command).toContain("wc -l < '/home/node/.claude/projects/p/a.jsonl'");
    expect(command).toContain("head -c 65536 '/home/node/.claude/projects/p/a.jsonl'");
    expect(command).not.toContain("cat ");
  });

  test("parses the count and head back out of the combined output", () => {
    expect(parseTranscriptHeadOutput("  12 \n__ork_head__\n{\"a\":1}\n{\"b\":2}\n")).toEqual({
      lineCount: 12,
      head: "{\"a\":1}\n{\"b\":2}\n",
    });
  });

  test("degrades to empty rather than guessing when the marker is missing", () => {
    expect(parseTranscriptHeadOutput("")).toEqual({ lineCount: 0, head: "" });
  });

  test("lists jsonl files newest-first without reading any of them", () => {
    const command = jsonlByMtimeFindCommand("/home/node/.claude/projects/p");
    expect(command).toContain("-name '*.jsonl'");
    expect(command).toContain("-printf '%T@ %p\\0'");
    expect(command).toContain("sort -z -rn");
  });
});

describe("live session read paths", () => {
  test("coalesces rapid pane captures and answers an unchanged pane with a marker", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, log }) => {
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };
      const tabId = "tab-capture-cache";
      await invoke(handlers, "claude_tmux_start", { tabId, environmentId: environment.id }, context);

      const captureCount = async () => (await fs.readFile(log, "utf8"))
        .split("\n")
        .filter((line) => line.startsWith("capture-pane"))
        .length;
      const before = await captureCount();

      // Two renderers polling the same session inside one window share a spawn.
      const [first, second] = await Promise.all([
        invoke(handlers, "claude_tmux_capture_pane", { tabId, environmentId: environment.id }),
        invoke(handlers, "claude_tmux_capture_pane", { tabId, environmentId: environment.id }),
      ]) as [string, string];
      expect(typeof first).toBe("string");
      expect(second).toBe(first);
      expect(await captureCount()).toBe(before + 1);

      // A caller that supplies no hash keeps getting the plain pane text, which
      // is what the renderer does today.
      await delay(CAPTURE_PANE_CACHE_MS + 50);
      await expect(invoke(
        handlers,
        "claude_tmux_capture_pane",
        { tabId, environmentId: environment.id },
      )).resolves.toBe(first);

      await delay(CAPTURE_PANE_CACHE_MS + 50);
      await expect(invoke(
        handlers,
        "claude_tmux_capture_pane",
        { tabId, environmentId: environment.id, knownHash: paneHash(first) },
      )).resolves.toEqual({ unchanged: true, hash: paneHash(first) });

      await delay(CAPTURE_PANE_CACHE_MS + 50);
      await expect(invoke(
        handlers,
        "claude_tmux_capture_pane",
        { tabId, environmentId: environment.id, knownHash: "stale" },
      )).resolves.toEqual({ unchanged: false, hash: paneHash(first), text: first });

      await invoke(handlers, "claude_tmux_stop", { tabId, environmentId: environment.id }, context);
    });
  }, 15_000);

  test("a failed pane capture does not wedge every later request", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, alive }) => {
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };
      const tabId = "tab-capture-failure";
      await invoke(handlers, "claude_tmux_start", { tabId, environmentId: environment.id }, context);
      const marker = path.join(alive, `${tmuxSessionName(environment.id, tabId)}.fail-capture`);

      // Concurrent callers join one in-flight capture. A rejected capture left
      // in that slot — or written into the cache — would be handed to every
      // later request, so one bad spawn would blank the pane permanently.
      await fs.writeFile(marker, "");
      await expect(invoke(
        handlers,
        "claude_tmux_capture_pane",
        { tabId, environmentId: environment.id },
      )).rejects.toThrow("capture failed");

      await fs.rm(marker, { force: true });
      await expect(invoke(
        handlers,
        "claude_tmux_capture_pane",
        { tabId, environmentId: environment.id },
      )).resolves.toContain("bypass permissions on");

      await invoke(handlers, "claude_tmux_stop", { tabId, environmentId: environment.id }, context);
    });
  }, 15_000);

  test("a failed poll snapshot skips the tick without ending the loop", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, runtimeRoot }) => {
      const emitted: Array<{ event: string; payload: unknown }> = [];
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
        appRoot: "",
        resourceRoot: "",
      };
      const tabId = "tab-poll-failure";
      const status = await invoke(
        handlers,
        "claude_tmux_start",
        { tabId, environmentId: environment.id },
        context,
      ) as { session_id: string };
      const pendingDir = path.join(runtimeRoot, "sessions", status.session_id, "pending");
      await fs.mkdir(pendingDir, { recursive: true });

      // An unreadable hook directory is what a transient snapshot failure looks
      // like from the loop's side. A throw that escapes the tick ends the poll
      // for the whole session, and the tab silently stops receiving hooks and
      // transcript lines with nothing reporting an error.
      await fs.chmod(pendingDir, 0o000);
      try {
        await delay(750);
      } finally {
        await fs.chmod(pendingDir, 0o755);
      }

      await fs.writeFile(path.join(pendingDir, "Stop-after-failure.json"), JSON.stringify({ ok: true }));
      await waitFor(() => emitted.some((item) => item.event === "claude-tmux:event"
        && (item.payload as { kind?: string }).kind === "hook"
        && (item.payload as { event_id?: string }).event_id === "after-failure"), 5_000);

      await invoke(handlers, "claude_tmux_stop", { tabId, environmentId: environment.id }, context);
    });
  }, 20_000);

  test("notifies once for each armed UserPromptSubmit-to-Stop turn", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, runtimeRoot }) => {
      environment.prRecheckAfterAgentCompletionArmedAt = "2026-08-01T12:00:00.000Z";
      const notifyAgentTurnCompleted = mock(async () => undefined);
      const emitted: Array<{ event: string; payload: unknown }> = [];
      const context = {
        storage: { getEnvironment: async () => environment },
        notifyAgentTurnCompleted,
        emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
        appRoot: "",
        resourceRoot: "",
      };
      const args = { tabId: "tab-completion", environmentId: environment.id };
      const status = await invoke(handlers, "claude_tmux_start", args, context) as {
        session_id: string;
      };
      const pendingDir = path.join(runtimeRoot, "sessions", status.session_id, "pending");
      const writeHook = async (kind: "UserPromptSubmit" | "Stop", id: string) => {
        await fs.writeFile(path.join(pendingDir, `${kind}-${id}.json`), "{}");
        await waitFor(() => emitted.some((entry) =>
          entry.event === "claude-tmux:event"
          && (entry.payload as { event_id?: string }).event_id === id
        ));
      };

      await writeHook("UserPromptSubmit", "turn-1-start");
      await writeHook("Stop", "turn-1-stop");
      await waitFor(() => notifyAgentTurnCompleted.mock.calls.length === 1);
      await writeHook("Stop", "turn-1-duplicate-stop");
      await delay(25);
      expect(notifyAgentTurnCompleted).toHaveBeenCalledTimes(1);

      await writeHook("UserPromptSubmit", "turn-2-start");
      await writeHook("Stop", "turn-2-stop");
      await waitFor(() => notifyAgentTurnCompleted.mock.calls.length === 2);
      expect(notifyAgentTurnCompleted.mock.calls).toEqual([
        [environment.id],
        [environment.id],
      ]);

      await invoke(handlers, "claude_tmux_stop", args, context);
    });
  }, 20_000);

  test("uses the durable arm to recover a Stop after backend reattach", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, runtimeRoot }) => {
      environment.prRecheckAfterAgentCompletionArmedAt = "2026-08-01T12:00:00.000Z";
      const notifyAgentTurnCompleted = mock(async () => undefined);
      const emitted: Array<{ event: string; payload: unknown }> = [];
      const context = {
        storage: { getEnvironment: async () => environment },
        notifyAgentTurnCompleted,
        emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
        appRoot: "",
        resourceRoot: "",
      };
      const args = { tabId: "tab-reattached", environmentId: environment.id };
      const status = await invoke(handlers, "claude_tmux_start", args, context) as {
        session_id: string;
      };
      const pendingDir = path.join(runtimeRoot, "sessions", status.session_id, "pending");

      // No UserPromptSubmit reaches this TmuxSession instance. This is the
      // observable state after the backend restarts while Claude is working.
      await fs.writeFile(path.join(pendingDir, "Stop-after-reattach.json"), "{}");
      await waitFor(() => notifyAgentTurnCompleted.mock.calls.length === 1);
      expect(notifyAgentTurnCompleted).toHaveBeenCalledWith(environment.id);

      await invoke(handlers, "claude_tmux_stop", args, context);
    });
  }, 20_000);

  test("does not drop a back-to-back turn while the prior notification is pending", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, runtimeRoot }) => {
      environment.prRecheckAfterAgentCompletionArmedAt = "2026-08-01T12:00:00.000Z";
      const gate = deferred<void>();
      const notifyAgentTurnCompleted = mock(() => gate.promise);
      const emitted: Array<{ event: string; payload: unknown }> = [];
      const context = {
        storage: { getEnvironment: async () => environment },
        notifyAgentTurnCompleted,
        emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
        appRoot: "",
        resourceRoot: "",
      };
      const args = { tabId: "tab-overlap", environmentId: environment.id };
      const status = await invoke(handlers, "claude_tmux_start", args, context) as {
        session_id: string;
      };
      const pendingDir = path.join(runtimeRoot, "sessions", status.session_id, "pending");
      const writeAndObserve = async (kind: "UserPromptSubmit" | "Stop", id: string) => {
        await fs.writeFile(path.join(pendingDir, `${kind}-${id}.json`), "{}");
        await waitFor(() => emitted.some((entry) =>
          (entry.payload as { event_id?: string }).event_id === id
        ));
      };

      await writeAndObserve("UserPromptSubmit", "overlap-start-1");
      await writeAndObserve("Stop", "overlap-stop-1");
      await waitFor(() => notifyAgentTurnCompleted.mock.calls.length === 1);
      await writeAndObserve("UserPromptSubmit", "overlap-start-2");
      await writeAndObserve("Stop", "overlap-stop-2");
      await waitFor(() => notifyAgentTurnCompleted.mock.calls.length === 2);

      gate.resolve();
      await invoke(handlers, "claude_tmux_stop", args, context);
    });
  }, 20_000);

  test("does not reopen a newer turn when an older completion notification rejects", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, runtimeRoot }) => {
      environment.prRecheckAfterAgentCompletionArmedAt = "2026-08-01T12:00:00.000Z";
      let rejectFirst!: (error: Error) => void;
      const first = new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
      let resolveSecond!: () => void;
      const second = new Promise<void>((resolve) => { resolveSecond = resolve; });
      const notifyAgentTurnCompleted = mock(() =>
        notifyAgentTurnCompleted.mock.calls.length === 1 ? first : second
      );
      const emitted: Array<{ event: string; payload: unknown }> = [];
      const context = {
        storage: { getEnvironment: async () => environment },
        notifyAgentTurnCompleted,
        emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
        appRoot: "",
        resourceRoot: "",
      };
      const args = { tabId: "tab-generation-rejection", environmentId: environment.id };
      const status = await invoke(handlers, "claude_tmux_start", args, context) as {
        session_id: string;
      };
      const pendingDir = path.join(runtimeRoot, "sessions", status.session_id, "pending");
      const writeAndObserve = async (kind: "UserPromptSubmit" | "Stop", id: string) => {
        await fs.writeFile(path.join(pendingDir, `${kind}-${id}.json`), "{}");
        await waitFor(() => emitted.some((entry) =>
          (entry.payload as { event_id?: string }).event_id === id
        ));
      };

      await writeAndObserve("UserPromptSubmit", "generation-1-start");
      await writeAndObserve("Stop", "generation-1-stop");
      await waitFor(() => notifyAgentTurnCompleted.mock.calls.length === 1);
      await writeAndObserve("UserPromptSubmit", "generation-2-start");
      await writeAndObserve("Stop", "generation-2-stop");
      await waitFor(() => notifyAgentTurnCompleted.mock.calls.length === 2);
      rejectFirst(new Error("late failure from generation one"));
      await delay(25);
      await writeAndObserve("Stop", "generation-2-duplicate");
      await delay(25);

      expect(notifyAgentTurnCompleted).toHaveBeenCalledTimes(2);
      resolveSecond();
      await invoke(handlers, "claude_tmux_stop", args, context);
    });
  }, 20_000);

  test("retries a failed durable-arm read and treats a missing environment as terminal", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, runtimeRoot }) => {
      environment.prRecheckAfterAgentCompletionArmedAt = "2026-08-01T12:00:00.000Z";
      let observeCompletionReads = false;
      let completionReads = 0;
      const getEnvironment = mock(async () => {
        if (!observeCompletionReads) return environment;
        completionReads += 1;
        if (completionReads === 1) throw new Error("storage unavailable");
        if (completionReads === 2) return undefined;
        return environment;
      });
      const notifyAgentTurnCompleted = mock(async () => undefined);
      const emitted: Array<{ event: string; payload: unknown }> = [];
      const context = {
        storage: { getEnvironment },
        notifyAgentTurnCompleted,
        emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
        appRoot: "",
        resourceRoot: "",
      };
      const args = { tabId: "tab-arm-read-retry", environmentId: environment.id };
      const status = await invoke(handlers, "claude_tmux_start", args, context) as {
        session_id: string;
      };
      observeCompletionReads = true;
      const pendingDir = path.join(runtimeRoot, "sessions", status.session_id, "pending");
      for (const id of ["failed-read", "missing-read", "successful-read"]) {
        await fs.writeFile(path.join(pendingDir, `Stop-${id}.json`), "{}");
        await waitFor(() => emitted.some((entry) =>
          (entry.payload as { event_id?: string }).event_id === id
        ));
        await delay(25);
      }

      expect(completionReads).toBe(2);
      expect(notifyAgentTurnCompleted).not.toHaveBeenCalled();
      await invoke(handlers, "claude_tmux_stop", args, context);
    });
  }, 20_000);

  test("ignores an unarmed Stop and retries a rejected armed notification", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, runtimeRoot }) => {
      const notifyAgentTurnCompleted = mock(async () => undefined);
      const emitted: Array<{ event: string; payload: unknown }> = [];
      const context = {
        storage: { getEnvironment: async () => environment },
        notifyAgentTurnCompleted,
        emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
        appRoot: "",
        resourceRoot: "",
      };
      const unarmedArgs = { tabId: "tab-unarmed", environmentId: environment.id };
      const unarmed = await invoke(handlers, "claude_tmux_start", unarmedArgs, context) as {
        session_id: string;
      };
      const unarmedPending = path.join(runtimeRoot, "sessions", unarmed.session_id, "pending");
      await fs.writeFile(path.join(unarmedPending, "Stop-unarmed.json"), "{}");
      await waitFor(() => emitted.some((entry) =>
        (entry.payload as { event_id?: string }).event_id === "unarmed"
      ));
      await delay(25);
      expect(notifyAgentTurnCompleted).not.toHaveBeenCalled();
      await invoke(handlers, "claude_tmux_stop", unarmedArgs, context);

      environment.prRecheckAfterAgentCompletionArmedAt = "2026-08-01T12:00:00.000Z";
      let attempts = 0;
      notifyAgentTurnCompleted.mockImplementation(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary reconciliation failure");
      });
      const retryArgs = { tabId: "tab-retry", environmentId: environment.id };
      const retry = await invoke(handlers, "claude_tmux_start", retryArgs, context) as {
        session_id: string;
      };
      const retryPending = path.join(runtimeRoot, "sessions", retry.session_id, "pending");
      await fs.writeFile(path.join(retryPending, "Stop-rejected.json"), "{}");
      await waitFor(() => notifyAgentTurnCompleted.mock.calls.length === 1);
      await delay(25);
      await fs.writeFile(path.join(retryPending, "Stop-retry.json"), "{}");
      await waitFor(() => notifyAgentTurnCompleted.mock.calls.length === 2);
      expect(attempts).toBe(2);

      await invoke(handlers, "claude_tmux_stop", retryArgs, context);
    });
  }, 20_000);

  test("spawns far fewer liveness checks than poll ticks for a live session", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, log }) => {
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };
      const tabId = "tab-liveness-cadence";
      await invoke(handlers, "claude_tmux_start", { tabId, environmentId: environment.id }, context);
      const session = tmuxSessionName(environment.id, tabId);

      const livenessChecks = async () => (await fs.readFile(log, "utf8"))
        .split("\n")
        .filter((line) => line.startsWith(`has-session -t ${session}`))
        .length;
      const before = await livenessChecks();

      // The loop ticks every POLL_INTERVAL_MS (250ms), so this window covers
      // roughly a dozen ticks. Each liveness check is its own process spawn — a
      // `docker exec` in container mode — and can only report a session that
      // has already ended, which is why it must not run per tick.
      await delay(3_000);
      const spawned = await livenessChecks() - before;

      expect(spawned).toBeGreaterThanOrEqual(1);
      expect(spawned).toBeLessThanOrEqual(3);

      await invoke(handlers, "claude_tmux_stop", { tabId, environmentId: environment.id }, context);
    });
  }, 20_000);

  test("still reports a tmux session that ended, on the slower liveness cadence", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, alive }) => {
      const emitted: Array<{ event: string; payload: unknown }> = [];
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
        appRoot: "",
        resourceRoot: "",
      };
      const tabId = "tab-liveness";
      await invoke(handlers, "claude_tmux_start", { tabId, environmentId: environment.id }, context);

      // Claude exits and tmux tears the session down; nothing else tells the
      // poll loop, so the periodic has-session check is the only signal.
      await fs.rm(path.join(alive, tmuxSessionName(environment.id, tabId)), { force: true });

      await waitFor(() => emitted.some((item) =>
        item.event === "claude-tmux:event"
        && (item.payload as { kind?: string }).kind === "stopped"
      ), 8_000);

      await invoke(handlers, "claude_tmux_stop", { tabId, environmentId: environment.id }, context);
    });
  }, 15_000);

  test("lists previous sessions without reading whole transcripts", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ worktree, home, environment }) => {
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };
      const transcriptDir = path.join(home, ".claude", "projects", encodeCwd(worktree));
      await fs.mkdir(transcriptDir, { recursive: true });
      const jsonl = (value: unknown) => `${JSON.stringify(value)}\n`;

      // The title lives in the first line; the bulk of the file is well past
      // the head the listing is allowed to read.
      await fs.writeFile(
        path.join(transcriptDir, "session-a.jsonl"),
        jsonl({ type: "user", message: { role: "user", content: "First prompt" } })
          + jsonl({ type: "assistant", message: { role: "assistant", content: "x".repeat(200_000) } }),
      );
      await fs.writeFile(
        path.join(transcriptDir, "session-b.jsonl"),
        jsonl({ type: "summary", summary: "no user message" }),
      );

      const sessions = await invoke(
        handlers,
        "claude_tmux_list_previous_sessions",
        { environmentId: environment.id },
        context,
      ) as Array<{ session_id: string; title: string | null; message_count: number; transcript_path: string }>;

      const byId = new Map(sessions.map((session) => [session.session_id, session]));
      expect(byId.get("session-a")).toMatchObject({
        title: "First prompt",
        message_count: 2,
        transcript_path: path.join(transcriptDir, "session-a.jsonl"),
      });
      expect(byId.get("session-b")).toMatchObject({ title: null, message_count: 1 });
    });
  });
});
