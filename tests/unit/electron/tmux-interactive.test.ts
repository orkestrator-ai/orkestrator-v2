import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";


import { spawnSync } from "node:child_process";


import { existsSync, promises as fs } from "node:fs";


import os from "node:os";


import path from "node:path";


import { setTimeout as delay } from "node:timers/promises";


import {
  agentMcpConfigJson,
  agentToolConnectionTarget,
  boundedInfoEventMessage,
  buildTmuxPaneUpdate,
  CLAUDE_STATE_POLL_INTERVAL_MS,
  CLAUDE_STATE_READ_TIMEOUT_MS,
  ClaudeStatePollManager,
  claudeStateReadCommand,
  cleanupEnvironmentTmux,
  containerExecArgs,
  fastModeFromPane,
  fastModeRejectionFromPane,
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
  TMUX_HOOK_PAYLOAD_MAX_BYTES,
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


import {
  tmuxSelectionPromptFingerprint,
  type TmuxSelectionPrompt,
} from "../../../packages/protocol/src/tmux-observation";



const tempDirs: string[] = [];


/** mkdtemp prefix for the fake tmux runtime; also the guard for its cleanup path. */
const RUNTIME_TEMP_PREFIX = "ork-tmux-runtime-";



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
      rm -f "$FAKE_TMUX_ALIVE/$session_name" "$FAKE_TMUX_ALIVE/$session_name.mode" "$FAKE_TMUX_ALIVE/$session_name.fast-option" "$FAKE_TMUX_ALIVE/$session_name.fast-pane"
      printf '%s\n' "can't find session: $session_name" >&2
      exit 1
    fi
    [ -n "$session_name" ] && rm -f "$FAKE_TMUX_ALIVE/$session_name" "$FAKE_TMUX_ALIVE/$session_name.mode" "$FAKE_TMUX_ALIVE/$session_name.fast-option" "$FAKE_TMUX_ALIVE/$session_name.fast-pane"
    exit 0
    ;;
  list-sessions)
    found=0
    for candidate in "$FAKE_TMUX_ALIVE"/orkestrator-*; do
      [ -f "$candidate" ] || continue
      name="$(basename "$candidate")"
      case "$name" in
        *.mode|*.input|*.fail-capture|*.fail-send|*.fast-option|*.fast-pane|*.reject-fast|*.ignore-fast|*.fail-fast-option|*.fail-fast-option-once|*.delay-fast|*.exit-fast) continue ;;
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
    if [ -n "$session_name" ] && [ -f "$FAKE_TMUX_ALIVE/$session_name.fast-pane" ]; then
      cat "$FAKE_TMUX_ALIVE/$session_name.fast-pane"
    elif [ -n "$session_name" ] && [ -f "$FAKE_TMUX_ALIVE/$session_name.mode" ]; then
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
  set-option)
    if [ -n "$session_name" ] && [ -f "$FAKE_TMUX_ALIVE/$session_name.fail-fast-option-once" ]; then
      rm -f "$FAKE_TMUX_ALIVE/$session_name.fail-fast-option-once"
      printf '%s\n' 'set option failed once' >&2
      exit 1
    fi
    if [ -n "$session_name" ] && [ -f "$FAKE_TMUX_ALIVE/$session_name.fail-fast-option" ]; then
      printf '%s\n' 'set option failed' >&2
      exit 1
    fi
    option_value="\${all_args##* }"
    printf '%s' "$option_value" > "$FAKE_TMUX_ALIVE/$session_name.fast-option"
    exit 0
    ;;
  show-options)
    if [ -n "$session_name" ] && [ -f "$FAKE_TMUX_ALIVE/$session_name.fast-option" ]; then
      cat "$FAKE_TMUX_ALIVE/$session_name.fast-option"
      exit 0
    fi
    exit 1
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
        input="$(cat "$input_file" 2>/dev/null)"
        if [ "$input" = '/plan' ]; then
          if [ -f "$FAKE_TMUX_ALIVE/$session_name.delay-plan" ]; then
            sleep 0.25
          fi
          if [ ! -f "$FAKE_TMUX_ALIVE/$session_name.ignore-plan" ]; then
            printf 'plan' > "$FAKE_TMUX_ALIVE/$session_name.mode"
          fi
        elif [ "$input" = '/fast on' ] || [ "$input" = '/fast off' ]; then
          fast_pane="$FAKE_TMUX_ALIVE/$session_name.fast-pane"
          if [ -s "$fast_pane" ]; then printf '\n' >> "$fast_pane"; fi
          printf '%s\n' "$input" >> "$fast_pane"
          if [ -f "$FAKE_TMUX_ALIVE/$session_name.delay-fast" ]; then
            sleep 0.25
          fi
          if [ -f "$FAKE_TMUX_ALIVE/$session_name.reject-fast" ]; then
            printf 'Fast mode is unavailable for this model' >> "$fast_pane"
          elif [ -f "$FAKE_TMUX_ALIVE/$session_name.exit-fast" ]; then
            printf '[claude exited]' >> "$fast_pane"
          elif [ ! -f "$FAKE_TMUX_ALIVE/$session_name.ignore-fast" ]; then
            if [ "$input" = '/fast on' ]; then
              printf 'Fast mode ON' >> "$fast_pane"
            else
              printf 'Fast mode OFF' >> "$fast_pane"
            fi
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
    printf '%s\\n' '--session-id --resume --effort --settings'
  else
    printf '%s\\n' '--session-id --resume --effort --settings --mcp-config'
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
