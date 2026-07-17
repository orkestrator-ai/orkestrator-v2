import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  newestJsonlFindCommand,
  newestJsonlInDir,
  parseFreshJsonlFindOutput,
  registerTmuxBackendCommands,
  transcriptContainsSessionId,
  tmuxSessionName,
} from "../../../apps/backend/src/core/tmux";
import type { Environment } from "../../../apps/backend/src/core/models";

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createEnvironment(worktreePath: string): Environment {
  return {
    id: "env-tmux",
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
}) => Promise<void>): Promise<void> {
  const root = await createTempDir("ork-tmux-runtime-");
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
  await fs.writeFile(path.join(binDir, "claude"), `#!/bin/sh
if [ "$1" = "--help" ]; then
  printf '%s\\n' '--session-id --resume --effort'
  exit 0
fi
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

  try {
    await run({ worktree, home, log, alive, environment: createEnvironment(worktree) });
  } finally {
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

describe("Electron tmux backend command registration", () => {
  test("registers the tmux command surface", () => {
    const handlers = createHandlers();

    for (const name of [
      "claude_tmux_start",
      "claude_tmux_stop",
      "claude_tmux_interrupt",
      "claude_tmux_status",
      "claude_tmux_transcript",
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

  test("starts with installed hooks, reads transcripts, replies to hooks, and maps interactive input", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ worktree, home, log, environment }) => {
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

      const sessionRoot = path.join("/tmp", "orkestrator-v2-claude-tmux", environment.id, "sessions", status.session_id);
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
