/**
 * Shared fixture harness for the `tmux-*.test.ts` suites,
 * split out of `tmux-backend.test.ts` on 2026-08-16.
 *
 * All 4 suites in the group need this same preamble. Duplicating it per file
 * left 4 copies to keep in sync, which is what CLAUDE.md > "Bun
 * `mock.module()` Rules" warns against, so it lives here and the suites import
 * what they use.
 *
 * Importing this module also registers the group's shared hooks, so it must be
 * imported before anything that depends on them. It is named `.ts`, not
 * `.test.ts`, so the runner does not collect it as a suite.
 *
 * This assumes `bun test --parallel` (which implies `--isolate`), the mode
 * AGENTS.md mandates: each test file gets a fresh module registry, so this
 * module is evaluated once per file exactly as the duplicated preambles were.
 */
import { afterEach, describe, expect, jest, mock, spyOn, test } from "bun:test";

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

export const tempDirs: string[] = [];

// These integration fixtures launch several real shim processes. A failed
// outer five-second budget used to interrupt fixture cleanup and cascade into
// missing-runtime failures in later tests from the same file.
export const TMUX_TEST_TIMEOUT_MS = 30_000;

jest.setTimeout(TMUX_TEST_TIMEOUT_MS);

/** mkdtemp prefix for the fake tmux runtime; also the guard for its cleanup path. */
export const RUNTIME_TEMP_PREFIX = "ork-tmux-runtime-";

export async function createTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export function createEnvironment(worktreePath: string, environmentId: string): Environment {
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

export function encodeCwd(cwd: string): string {
  return cwd.replace(/\/+$/, "").replaceAll("/", "-");
}

export async function withFakeTmuxRuntime(
  run: (runtime: {
    worktree: string;
    home: string;
    log: string;
    alive: string;
    environment: Environment;
    /** `${RUNTIME_ROOT_PREFIX}/<environment id>` — where the backend keeps hook state. */
    runtimeRoot: string;
  }) => Promise<void>,
): Promise<void> {
  const root = await createTempDir(RUNTIME_TEMP_PREFIX);
  const binDir = path.join(root, "bin");
  const worktree = path.join(root, "worktree");
  const home = path.join(root, "home");
  const log = path.join(root, "tmux.log");
  const alive = path.join(root, "tmux-alive");
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(worktree, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(
    path.join(binDir, "tmux"),
    `#!/bin/sh
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
`,
  );
  // Mirrors the real CLI closely enough for the launch-time capability probes:
  // `--effort` is advertised by `--help`, while the thinking flags are hidden
  // and only discoverable by having an argument rejected. Options are validated
  // in argv order, the way commander does, so a probe carrying a valid
  // `--thinking` and an invalid `--thinking-display` fails on the latter.
  await fs.writeFile(
    path.join(binDir, "claude"),
    `#!/bin/sh
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
`,
  );
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

export async function withFakeContainerTmuxRuntime(
  run: (runtime: {
    worktree: string;
    log: string;
    alive: string;
    environment: Environment;
    runtimeRoot: string;
  }) => Promise<void>,
): Promise<void> {
  const root = await createTempDir(`${RUNTIME_TEMP_PREFIX}container-`);
  const binDir = path.join(root, "bin");
  const worktree = path.join(root, "workspace");
  const log = path.join(root, "docker.log");
  const alive = path.join(root, "tmux-alive");
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(worktree, { recursive: true });
  await fs.writeFile(
    path.join(binDir, "docker"),
    `#!/usr/bin/env node
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
`,
  );
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

export function createHandlers() {
  const handlers = new Map<string, (args: Record<string, unknown>, context: unknown) => unknown>();
  registerTmuxBackendCommands((name, handler) => {
    handlers.set(name, handler as (args: Record<string, unknown>, context: unknown) => unknown);
  });
  return handlers;
}

export async function invoke(
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

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error("timed out waiting for condition");
}

export function deferred<T>(): {
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
