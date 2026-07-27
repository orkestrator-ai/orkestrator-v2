import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  CLAUDE_STATE_POLL_INTERVAL_MS,
  CLAUDE_STATE_READ_TIMEOUT_MS,
  ClaudeStatePollManager,
  claudeStateReadCommand,
  containerExecArgs,
  newestJsonlFindCommand,
  newestJsonlInDir,
  parseFreshJsonlFindOutput,
  probeThinkingDisplaySupport,
  registerTmuxBackendCommands,
  RUNTIME_ROOT_PREFIX,
  thinkingDisplayProbeArgs,
  thinkingDisplayProbeIndicatesSupport,
  transcriptContainsSessionId,
  tmuxSessionName,
  type ExecOutput,
} from "../../../apps/backend/src/core/tmux";
import type { Environment } from "../../../apps/backend/src/core/models";
import type { CommandContext } from "../../../apps/backend/src/core/commands";

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
    mkdir -p "$FAKE_TMUX_ALIVE"
    if [ -n "$session_name" ]; then
      touch "$FAKE_TMUX_ALIVE/$session_name"
      printf 'bypassPermissions' > "$FAKE_TMUX_ALIVE/$session_name.mode"
    fi
    exit 0
    ;;
  kill-session)
    [ -n "$session_name" ] && rm -f "$FAKE_TMUX_ALIVE/$session_name" "$FAKE_TMUX_ALIVE/$session_name.mode"
    exit 0
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
  printf '%s\\n' '--session-id --resume --effort'
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
      await fs.mkdir(pendingDir, { recursive: true });
      await fs.writeFile(path.join(pendingDir, "PreToolUse-event-1.json"), JSON.stringify({ tool_name: "Edit" }));

      await expect(invoke(handlers, "claude_tmux_pending_hooks", { tabId: "tab-1", environmentId: environment.id })).resolves.toEqual([
        { id: "event-1", kind: "PreToolUse", payload: { tool_name: "Edit" } },
      ]);

      await invoke(
        handlers,
        "claude_tmux_reply_hook",
        { tabId: "tab-1", environmentId: environment.id, eventKind: "PreToolUse", eventId: "event-1", response: { ok: true } },
      );
      await expect(fs.readFile(path.join(responseDir, "PreToolUse-event-1.json"), "utf8")).resolves.toBe(JSON.stringify({ ok: true }));
      await expect(fs.stat(path.join(pendingDir, "PreToolUse-event-1.json"))).rejects.toThrow();
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
      expect(emitted.some((item) => item.event === `terminal-output-${terminalSessionId}`)).toBe(true);
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
});

describe("container transcript discovery helpers", () => {
  test("builds a GNU find query scoped to fresh jsonl files in the project dir", () => {
    const command = newestJsonlFindCommand("/home/node/.claude/projects/-workspace", 1_700_000_000);
    expect(command).toContain("'/home/node/.claude/projects/-workspace'/");
    expect(command).toContain("-name '*.jsonl'");
    expect(command).toContain("-newermt @1700000000");
    expect(command).toContain("-printf '%T@ %p\\n'");
    expect(command).toContain("sort -rn");
  });

  test("parses a single find line into a path/mtime record", () => {
    const output = "1700000002.5 /home/node/.claude/projects/p/new.jsonl\n";
    expect(parseFreshJsonlFindOutput(output)).toEqual([
      { path: "/home/node/.claude/projects/p/new.jsonl", mtime: 1700000002.5 },
    ]);
  });

  test("returns no records for empty or whitespace-only output", () => {
    expect(parseFreshJsonlFindOutput("")).toEqual([]);
    expect(parseFreshJsonlFindOutput("\n  \n")).toEqual([]);
  });

  test("parses every candidate when output is ambiguous (more than one line)", () => {
    const output = [
      "1700000003 /home/node/.claude/projects/p/b.jsonl",
      "1700000002 /home/node/.claude/projects/p/a.jsonl",
    ].join("\n");
    expect(parseFreshJsonlFindOutput(output)).toEqual([
      { path: "/home/node/.claude/projects/p/b.jsonl", mtime: 1700000003 },
      { path: "/home/node/.claude/projects/p/a.jsonl", mtime: 1700000002 },
    ]);
  });

  test("preserves spaces in the parsed path", () => {
    const output = "1700000002 /home/node/.claude/projects/p/with space.jsonl\n";
    expect(parseFreshJsonlFindOutput(output)).toEqual([
      { path: "/home/node/.claude/projects/p/with space.jsonl", mtime: 1700000002 },
    ]);
  });

  test("skips lines lacking a path field or with a non-finite mtime", () => {
    expect(parseFreshJsonlFindOutput("1700000002")).toEqual([]);
    expect(parseFreshJsonlFindOutput("notanumber /home/node/.claude/projects/p/x.jsonl")).toEqual([]);
    const mixed = [
      "1700000003 /home/node/.claude/projects/p/good.jsonl",
      "1700000002", // no path
      "bad /home/node/.claude/projects/p/skip.jsonl", // non-finite mtime
    ].join("\n");
    expect(parseFreshJsonlFindOutput(mixed)).toEqual([
      { path: "/home/node/.claude/projects/p/good.jsonl", mtime: 1700000003 },
    ]);
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
    const findStdout = [
      "1700000003 /home/node/.claude/projects/p/other.jsonl",
      "1700000002 /home/node/.claude/projects/p/owned.jsonl",
    ].join("\n");
    const { backend } = makeContainerBackend(findStdout, {
      "/home/node/.claude/projects/p/other.jsonl": `${JSON.stringify({ sessionId: "other" })}\n`,
      "/home/node/.claude/projects/p/owned.jsonl": `${JSON.stringify({ sessionId: "mine" })}\n`,
    });
    await expect(
      newestJsonlInDir(backend, "/home/node/.claude/projects/p", 1700000000, "mine"),
    ).resolves.toBe("/home/node/.claude/projects/p/owned.jsonl");
  });

  test("returns undefined when no container jsonl claims the session", async () => {
    const findStdout = "1700000003 /home/node/.claude/projects/p/other.jsonl\n";
    const { backend } = makeContainerBackend(findStdout, {
      "/home/node/.claude/projects/p/other.jsonl": `${JSON.stringify({ sessionId: "other" })}\n`,
    });
    await expect(
      newestJsonlInDir(backend, "/home/node/.claude/projects/p", 1700000000, "mine"),
    ).resolves.toBeUndefined();
  });

  test("returns undefined when multiple container jsonls claim the same session", async () => {
    const findStdout = [
      "1700000003 /home/node/.claude/projects/p/a.jsonl",
      "1700000002 /home/node/.claude/projects/p/b.jsonl",
    ].join("\n");
    const { backend } = makeContainerBackend(findStdout, {
      "/home/node/.claude/projects/p/a.jsonl": `${JSON.stringify({ sessionId: "mine" })}\n`,
      "/home/node/.claude/projects/p/b.jsonl": `${JSON.stringify({ sessionId: "mine" })}\n`,
    });
    await expect(
      newestJsonlInDir(backend, "/home/node/.claude/projects/p", 1700000000, "mine"),
    ).resolves.toBeUndefined();
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
