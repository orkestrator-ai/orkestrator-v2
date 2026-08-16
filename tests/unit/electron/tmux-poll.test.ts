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

  test("probes for an agent-created PR on an unarmed terminal turn end", async () => {
    // The regression this whole path exists for: nothing is armed and no PR is
    // stored, so the monitor is not polling this environment at all. A Claude
    // tmux agent that ran `gh pr create` itself would otherwise never be seen.
    for (const endState of ["waiting", "idle"] as const) {
      const harness = createPollHarness({ states: ["working", endState] });
      const probe = mock(async () => undefined);
      const notifyAgentTurnCompleted = mock(async () => undefined);
      harness.context.probeAgentCreatedPullRequest = probe;
      harness.context.notifyAgentTurnCompleted = notifyAgentTurnCompleted;

      harness.manager.start("container-poll", harness.context);
      await waitFor(() => harness.emitted.length === 1);
      expect(probe).not.toHaveBeenCalled();

      harness.scheduled[0]!();
      await waitFor(() => probe.mock.calls.length === 1);
      expect(probe).toHaveBeenCalledWith("env-poll");
      // The armed-only notification is a separate concern and stays gated.
      expect(notifyAgentTurnCompleted).not.toHaveBeenCalled();
      harness.manager.shutdown("container-poll");
    }
  });

  test("probes once per ended terminal turn, never per poll", async () => {
    const harness = createPollHarness({
      states: ["working", "waiting", "waiting", "waiting", "working", "idle"],
    });
    const probe = mock(async () => undefined);
    harness.context.probeAgentCreatedPullRequest = probe;

    harness.manager.start("container-poll", harness.context);
    await waitFor(() => harness.emitted.length === 1);
    harness.scheduled[0]!();
    await waitFor(() => probe.mock.calls.length === 1);

    // This poll runs about once a second per container; re-reading the same
    // ended state is not a new turn and must not be a new `gh` call.
    for (let tick = 0; tick < 2; tick += 1) {
      harness.scheduled[0]!();
      await delay(0);
    }
    expect(probe).toHaveBeenCalledTimes(1);
    expect(harness.emitted).toHaveLength(2);

    // A new turn that ends is a new probe.
    harness.scheduled[0]!();
    await waitFor(() => harness.emitted.length === 3);
    harness.scheduled[0]!();
    await waitFor(() => probe.mock.calls.length === 2);
    harness.manager.shutdown("container-poll");
  });

  test("does not probe a first observation of an already-ended terminal state", async () => {
    // A poll that starts up and immediately reads `waiting` is looking at a turn
    // that ended before this backend existed. Probing it would be one `gh` call
    // per running Claude tmux container on every backend start.
    for (const initialState of ["waiting", "idle"] as const) {
      const harness = createPollHarness({ states: [initialState] });
      const probe = mock(async () => undefined);
      harness.context.probeAgentCreatedPullRequest = probe;

      harness.manager.start("container-poll", harness.context);
      await waitFor(() => harness.emitted.length === 1);
      await delay(0);
      expect(probe).not.toHaveBeenCalled();
      harness.manager.shutdown("container-poll");
    }
  });

  test("a failing PR probe neither stops the poll loop nor suppresses its state emit", async () => {
    const harness = createPollHarness({
      states: ["working", "waiting", "working", "waiting", "working", "waiting"],
    });
    let attempts = 0;
    const probe = mock((): Promise<void> => {
      attempts += 1;
      // A synchronous throw is the harsher case: it happens before any promise
      // exists to attach a rejection handler to.
      if (attempts === 1) throw new Error("probe unavailable");
      if (attempts === 2) return Promise.reject(new Error("probe rejected"));
      return Promise.resolve();
    });
    harness.context.probeAgentCreatedPullRequest = probe;

    harness.manager.start("container-poll", harness.context);
    await waitFor(() => harness.emitted.length === 1);
    for (let expectedEmits = 2; expectedEmits <= 6; expectedEmits += 1) {
      harness.scheduled[0]!();
      await waitFor(() => harness.emitted.length === expectedEmits);
    }

    await waitFor(() => probe.mock.calls.length === 3);
    expect(attempts).toBe(3);
    // The renderer still received every state frame, including the ones whose
    // probe failed.
    expect(harness.emitted.map(({ payload }) => (payload as { state: string }).state))
      .toEqual(["working", "waiting", "working", "waiting", "working", "waiting"]);
    harness.manager.shutdown("container-poll");
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

  test("keeps one backend-owned poll across idempotent starts until reconciliation retires it", async () => {
    const harness = createPollHarness({
      states: ["working", "idle"],
    });

    harness.manager.start("container-poll", harness.context);
    harness.manager.start("container-poll", harness.context);
    await waitFor(() => harness.emitted.length === 1);

    expect(harness.cancelled.size).toBe(0);
    harness.scheduled[0]!();
    await waitFor(() => harness.emitted.length === 2);
    expect(harness.persisted.map((entry) => entry.state)).toEqual([
      "working",
      "idle",
    ]);

    harness.environment.status = "stopped";
    await harness.manager.reconcile(harness.context);
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

  test("discards an in-flight read after backend shutdown", async () => {
    const state = deferred<string>();
    const harness = createPollHarness({
      readState: async () => state.promise,
    });

    harness.manager.start("container-poll", harness.context);
    harness.manager.shutdown("container-poll");
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

  test("keeps polling when backend reconciliation cannot read environments", async () => {
    // Storage being unreadable is not evidence that the container stopped.
    const harness = createPollHarness({
      states: ["working"],
      loadEnvironments: async () => {
        throw new Error("storage unavailable");
      },
    });

    harness.manager.start("container-poll", harness.context);
    await expect(harness.manager.reconcile(harness.context))
      .rejects.toThrow("storage unavailable");
    expect(harness.cancelled.size).toBe(0);
    harness.manager.shutdown("container-poll");
  });

  test("shutting down an unknown container is a no-op", () => {
    const harness = createPollHarness();
    expect(() => harness.manager.shutdown("container-never-started")).not.toThrow();
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

    harness.manager.start("container-poll", harness.context);
    harness.manager.start("container-poll", secondContext);
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

    harness.manager.start("container-poll", harness.context);
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
