import { describe, expect, test } from "bun:test";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs } from "node:fs";

import {
  AGENT_INTERACTION_DEFAULT_TIMEOUT_MS,
  AGENT_INTERACTION_HOLD_CEILING_MS,
} from "@orkestrator/protocol/agent-interactions";
import {
  blockingHookHold,
  drainPending,
  hooksBlock,
  parseBlockingHookTiming,
  requestHookHold,
} from "../src/core/tmux-hooks.js";
import {
  HOOK_COMMAND_TIMEOUT_SECS,
  HOOK_HOLD_PROTOCOL,
  HOOK_LIMIT_MARGIN_SECS,
  type SessionHookPaths,
} from "../src/core/tmux-shared.js";
import type { TmuxBackend } from "../src/core/tmux-backend.js";
import {
  createHandlers,
  deferred,
  invoke,
  waitFor,
  withFakeTmuxRuntime,
} from "./tmux-test-harness.js";

const WINDOW = AGENT_INTERACTION_DEFAULT_TIMEOUT_MS;
const CEILING = AGENT_INTERACTION_HOLD_CEILING_MS;
const R = 1_700_000_000_000;
const LIMIT = R + (HOOK_COMMAND_TIMEOUT_SECS - HOOK_LIMIT_MARGIN_SECS) * 1_000;

describe("tmux hook timing sidecar", () => {
  test("keeps the original shape readable but unpausable", () => {
    const timing = parseBlockingHookTiming(
      JSON.stringify({ requestedAt: R, expiresAt: R + WINDOW }),
    );
    expect(timing).toEqual({ requestedAt: R, expiresAt: R + WINDOW });
    expect(blockingHookHold("PreToolUse", timing!)).toEqual({
      available: false,
      reason: "hook-outdated",
    });
  });

  test("accepts a moved deadline only when it adds up", () => {
    const fresh = {
      version: 2,
      requestedAt: R,
      startedAt: R,
      expiresAt: R + WINDOW,
      limitAt: LIMIT,
    };
    expect(parseBlockingHookTiming(JSON.stringify(fresh))).toEqual({
      requestedAt: R,
      expiresAt: R + WINDOW,
      pause: { startedAt: R, limitAt: LIMIT },
    });
    const held = { ...fresh, heldAt: R + 1_000, expiresAt: R + 1_000 + CEILING };
    expect(parseBlockingHookTiming(JSON.stringify(held))?.pause?.heldAt).toBe(R + 1_000);
    const resumed = { ...fresh, startedAt: R + 60_000, expiresAt: R + 60_000 + WINDOW };
    expect(parseBlockingHookTiming(JSON.stringify(resumed))?.expiresAt).toBe(R + 60_000 + WINDOW);
    // Held near the hook's limit: the limit is the ceiling.
    const nearLimit = {
      ...fresh,
      heldAt: LIMIT - 10_000,
      startedAt: LIMIT - 20_000,
      expiresAt: LIMIT,
    };
    expect(parseBlockingHookTiming(JSON.stringify(nearLimit))?.expiresAt).toBe(LIMIT);

    for (const bad of [
      { ...fresh, expiresAt: R + WINDOW + 1 },
      { ...fresh, version: 3 },
      { ...fresh, startedAt: R - 1 },
      { ...fresh, expiresAt: LIMIT + 1, startedAt: LIMIT + 1 - WINDOW },
      { ...held, expiresAt: held.expiresAt + 1 },
      { ...held, heldAt: R - 1 },
      { ...fresh, limitAt: "soon" },
      { requestedAt: R, expiresAt: R + 2 * WINDOW },
    ]) {
      expect(parseBlockingHookTiming(JSON.stringify(bad))).toBeNull();
    }
    expect(parseBlockingHookTiming("not json")).toBeNull();
  });

  test("publishes the hold the way InteractionDeadline does", () => {
    const pause = { startedAt: R, limitAt: LIMIT };
    expect(
      blockingHookHold("PreToolUse", { requestedAt: R, expiresAt: R + WINDOW, pause }, R),
    ).toEqual({ available: true });
    expect(
      blockingHookHold("Elicitation", { requestedAt: R, expiresAt: R + WINDOW, pause }, R),
    ).toEqual({ available: true, reason: "upstream-may-expire" });
    expect(
      blockingHookHold(
        "PreToolUse",
        { requestedAt: R, expiresAt: R + 1_000 + CEILING, pause: { ...pause, heldAt: R + 1_000 } },
        R + 2_000,
      ),
    ).toEqual({ available: true, heldAt: R + 1_000 });
    // Past the first day the hook's own timeout cuts the pause short.
    const late = LIMIT - CEILING / 2;
    expect(
      blockingHookHold(
        "PreToolUse",
        { requestedAt: R, expiresAt: late + WINDOW, pause: { startedAt: late, limitAt: LIMIT } },
        late,
      ),
    ).toEqual({ available: true, reason: "provider-limit" });
    expect(
      blockingHookHold(
        "PreToolUse",
        { requestedAt: R, expiresAt: LIMIT, pause: { startedAt: LIMIT - 1_000, limitAt: LIMIT } },
        LIMIT - 1_000,
      ),
    ).toEqual({ available: false, reason: "no-extension" });
  });

  test("installs the blocking hooks with the hold protocol and a timeout above the ceiling", () => {
    const block = hooksBlock("/run/hook.sh") as Record<
      string,
      Array<{ hooks: Array<{ type?: string; command: string; timeout?: number }> }>
    >;
    expect(HOOK_COMMAND_TIMEOUT_SECS * 1_000).toBeGreaterThan(CEILING + WINDOW);
    for (const kind of ["PreToolUse", "PermissionRequest", "Elicitation"]) {
      for (const entry of block[kind]!) {
        expect(entry.hooks[0]).toEqual({
          type: "command",
          command: `bash "/run/hook.sh" ${kind} ${HOOK_HOLD_PROTOCOL}`,
          timeout: HOOK_COMMAND_TIMEOUT_SECS,
        });
      }
    }
    expect(block.Stop![0]!.hooks[0]).toEqual({
      type: "command",
      command: 'bash "/run/hook.sh" Stop',
    });
    expect(block.StopFailure![0]!.hooks[0]).toEqual({
      type: "command",
      command: 'bash "/run/hook.sh" StopFailure',
    });
  });
});

describe("requestHookHold", () => {
  const paths: SessionHookPaths = {
    sessionDir: "/s",
    pendingDir: "/s/pending",
    responseDir: "/s/response",
    timeoutDir: "/s/timeout",
    timingDir: "/s/timing",
    holdDir: "/s/hold",
  };
  const name = "PreToolUse-1700000000-1-2-3.json";
  const id = "1700000000-1-2-3";

  function fakeBackend(files: Map<string, string>): TmuxBackend {
    return {
      readFile: async (file: string) => files.get(file),
      readBoundedFile: async (file: string) => {
        const content = files.get(file);
        return content === undefined ? undefined : { content, truncated: false };
      },
      writeFile: async (file: string, content: string) => void files.set(file, content),
      removeFile: async (file: string) => void files.delete(file),
    } as unknown as TmuxBackend;
  }

  function timing(extra: Record<string, unknown> = {}): string {
    return JSON.stringify({
      version: 2,
      requestedAt: R,
      startedAt: R,
      expiresAt: R + WINDOW,
      limitAt: LIMIT,
      ...extra,
    });
  }

  test("refuses a hook that predates pausing without writing a request", async () => {
    const files = new Map([
      [`/s/pending/${name}`, "{}"],
      [`/s/timing/${name}`, JSON.stringify({ requestedAt: R, expiresAt: R + WINDOW })],
    ]);
    const outcome = await requestHookHold(fakeBackend(files), paths, "PreToolUse", id, true);
    expect(outcome.result).toBe("unavailable");
    expect(outcome.hook?.hold).toEqual({ available: false, reason: "hook-outdated" });
    expect(files.has(`/s/hold/${name}`)).toBe(false);
  });

  test("reports an answered hook as settled and a repeated request as unchanged", async () => {
    const files = new Map([[`/s/timing/${name}`, timing()]]);
    expect((await requestHookHold(fakeBackend(files), paths, "PreToolUse", id, true)).result).toBe(
      "settled",
    );
    files.set(`/s/pending/${name}`, "{}");
    expect((await requestHookHold(fakeBackend(files), paths, "PreToolUse", id, false)).result).toBe(
      "unchanged",
    );
    await expect(requestHookHold(fakeBackend(files), paths, "Stop", id, true)).rejects.toThrow(
      "cannot be paused",
    );
  });

  test("withdraws a request the script never takes and fails", async () => {
    const files = new Map([
      [`/s/pending/${name}`, "{}"],
      [`/s/timing/${name}`, timing()],
    ]);
    let clock = R;
    await expect(
      requestHookHold(fakeBackend(files), paths, "PreToolUse", id, true, {
        now: () => clock,
        sleep: async (ms) => void (clock += ms),
        ackTimeoutMs: 1_000,
      }),
    ).rejects.toThrow("did not take the pause");
    expect(files.has(`/s/hold/${name}`)).toBe(false);
    // The deadline the script published is untouched.
    expect(files.get(`/s/timing/${name}`)).toBe(timing());
  });

  test("returns the moved deadline once the script rewrites the sidecar", async () => {
    const files = new Map([
      [`/s/pending/${name}`, JSON.stringify({ tool_name: "AskUserQuestion" })],
      [`/s/timing/${name}`, timing()],
    ]);
    let clock = R + 1_000;
    const outcome = await requestHookHold(fakeBackend(files), paths, "PreToolUse", id, true, {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        if (files.get(`/s/hold/${name}`) === "hold") {
          files.delete(`/s/hold/${name}`);
          files.set(
            `/s/timing/${name}`,
            timing({ heldAt: R + 1_000, expiresAt: R + 1_000 + CEILING }),
          );
        }
      },
    });
    expect(outcome.result).toBe("applied");
    expect(outcome.hook).toEqual({
      id,
      kind: "PreToolUse",
      payload: { tool_name: "AskUserQuestion" },
      requestedAt: R,
      expiresAt: R + 1_000 + CEILING,
      hold: { available: true, heldAt: R + 1_000 },
    });
  });
});

describe("generated hook script pause", () => {
  function runHook(
    scriptPath: string,
    sessionId: string,
    args: string[],
  ): { child: ChildProcessWithoutNullStreams; result: Promise<unknown> } {
    const child = spawn("bash", [scriptPath, ...args]);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.stdin.end(JSON.stringify({ session_id: sessionId, tool_name: "AskUserQuestion" }));
    const result = new Promise<unknown>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        if (code !== 0 || stderr !== "") reject(new Error(`hook exited ${code}: ${stderr}`));
        else resolve(JSON.parse(stdout));
      });
    });
    return { child, result };
  }

  test("pauses, resumes and answers through the backend command, re-emitting the hook", async () => {
    const pollLoopHeld = deferred<void>();
    const handlers = createHandlers({ sessionTiming: { pollTick: () => pollLoopHeld.promise } });

    await withFakeTmuxRuntime(async ({ environment, runtimeRoot, worktree }) => {
      const emitted: Array<Record<string, unknown>> = [];
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: (_event: string, payload: unknown) =>
          emitted.push(payload as Record<string, unknown>),
        appRoot: "",
        resourceRoot: "",
      };
      const tab = { tabId: "tab-hold", environmentId: environment.id };
      const status = (await invoke(handlers, "claude_tmux_start", tab, context)) as {
        session_id: string;
      };
      const settings = JSON.parse(
        await fs.readFile(path.join(worktree, ".claude", "settings.local.json"), "utf8"),
      ) as {
        hooks: Record<
          string,
          Array<{ hooks: Array<{ type?: string; command: string; timeout?: number }> }>
        >;
      };
      expect(settings.hooks.PreToolUse![0]!.hooks[0]!.timeout).toBe(HOOK_COMMAND_TIMEOUT_SECS);

      const scriptPath = path.join(runtimeRoot, "hook.sh");
      const sessionRoot = path.join(runtimeRoot, "sessions", status.session_id);
      const { result } = runHook(scriptPath, status.session_id, ["PreToolUse", HOOK_HOLD_PROTOCOL]);
      let pendingName = "";
      await waitFor(async () => {
        const names = await fs.readdir(path.join(sessionRoot, "pending")).catch(() => []);
        pendingName = names[0] ?? "";
        return pendingName !== "";
      });
      const eventId = pendingName.slice("PreToolUse-".length, -".json".length);

      const [pending] = (await invoke(
        handlers,
        "claude_tmux_pending_hooks",
        tab,
        context,
      )) as Array<{
        requestedAt: number;
        expiresAt: number;
        hold: unknown;
      }>;
      expect(pending!.expiresAt - pending!.requestedAt).toBe(WINDOW);
      expect(pending!.hold).toEqual({ available: true });

      const paused = (await invoke(
        handlers,
        "claude_tmux_hold_hook",
        { ...tab, eventKind: "PreToolUse", eventId, held: true },
        context,
      )) as { result: string; hook: { expiresAt: number; hold: { heldAt?: number } } };
      expect(paused.result).toBe("applied");
      expect(paused.hook.hold.heldAt).toBeNumber();
      expect(paused.hook.expiresAt).toBe(paused.hook.hold.heldAt! + CEILING);
      expect(emitted.at(-1)).toEqual(
        expect.objectContaining({
          kind: "hook",
          event_id: eventId,
          expires_at: paused.hook.expiresAt,
          hold: paused.hook.hold,
        }),
      );
      // Rehydration sees the pause too.
      const [rehydrated] = (await invoke(
        handlers,
        "claude_tmux_pending_hooks",
        tab,
        context,
      )) as Array<{
        hold: unknown;
      }>;
      expect(rehydrated!.hold).toEqual(paused.hook.hold);

      await expect(
        invoke(
          handlers,
          "claude_tmux_hold_hook",
          { ...tab, eventKind: "PreToolUse", eventId, held: true },
          context,
        ),
      ).resolves.toEqual(expect.objectContaining({ result: "unchanged" }));

      const resumed = (await invoke(
        handlers,
        "claude_tmux_hold_hook",
        { ...tab, eventKind: "PreToolUse", eventId, held: false },
        context,
      )) as { result: string; hook: { expiresAt: number; hold: unknown } };
      expect(resumed.result).toBe("applied");
      expect(resumed.hook.hold).toEqual({ available: true });
      const resumedTiming = JSON.parse(
        await fs.readFile(path.join(sessionRoot, "timing", pendingName), "utf8"),
      ) as { startedAt: number; expiresAt: number };
      expect(resumedTiming.expiresAt - resumedTiming.startedAt).toBe(WINDOW);

      await invoke(
        handlers,
        "claude_tmux_reply_hook",
        { ...tab, eventKind: "PreToolUse", eventId, response: { answered: true } },
        context,
      );
      await expect(result).resolves.toEqual({ answered: true });
      expect(await fs.readdir(path.join(sessionRoot, "hold"))).toEqual([]);
      expect(await fs.readdir(path.join(sessionRoot, "timing"))).toEqual([]);

      await invoke(handlers, "claude_tmux_stop", tab, context);
      pollLoopHeld.resolve();
    });
  });

  test("a resumed countdown still denies on expiry, and a hook without the protocol stays unpausable", async () => {
    const pollLoopHeld = deferred<void>();
    const handlers = createHandlers({ sessionTiming: { pollTick: () => pollLoopHeld.promise } });

    await withFakeTmuxRuntime(async ({ environment, runtimeRoot }) => {
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };
      const tab = { tabId: "tab-hold-expiry", environmentId: environment.id };
      const status = (await invoke(handlers, "claude_tmux_start", tab, context)) as {
        session_id: string;
      };
      const sessionRoot = path.join(runtimeRoot, "sessions", status.session_id);
      const installed = await fs.readFile(path.join(runtimeRoot, "hook.sh"), "utf8");
      // A disposable copy with a short window, so expiry is observable.
      const shortScript = path.join(runtimeRoot, "hook-short.sh");
      await fs.writeFile(shortScript, installed.replace(/^TIMEOUT_SECS=\d+$/m, "TIMEOUT_SECS=4"));

      const legacy = runHook(shortScript, status.session_id, ["PermissionRequest"]);
      const pausable = runHook(shortScript, status.session_id, ["PreToolUse", HOOK_HOLD_PROTOCOL]);
      const names: Record<string, string> = {};
      await waitFor(async () => {
        for (const name of await fs.readdir(path.join(sessionRoot, "pending")).catch(() => [])) {
          names[name.split("-", 1)[0]!] = name;
        }
        return names.PermissionRequest !== undefined && names.PreToolUse !== undefined;
      });

      const legacyId = names.PermissionRequest!.slice("PermissionRequest-".length, -".json".length);
      const legacyOutcome = (await invoke(
        handlers,
        "claude_tmux_hold_hook",
        { ...tab, eventKind: "PermissionRequest", eventId: legacyId, held: true },
        context,
      )) as { result: string };
      expect(legacyOutcome.result).toBe("unavailable");

      // Pause and resume through the script's own request file, then let the
      // fresh window run out: the answer is still a deny the script wrote.
      const holdFile = path.join(sessionRoot, "hold", names.PreToolUse!);
      await fs.writeFile(holdFile, "hold");
      await waitFor(async () => {
        const raw = await fs.readFile(path.join(sessionRoot, "timing", names.PreToolUse!), "utf8");
        return (JSON.parse(raw) as { heldAt?: number }).heldAt !== undefined;
      });
      await fs.writeFile(holdFile, "resume");
      await waitFor(async () => {
        const raw = await fs
          .readFile(path.join(sessionRoot, "timing", names.PreToolUse!), "utf8")
          .catch(() => "{}");
        const parsed = JSON.parse(raw) as {
          heldAt?: number;
          startedAt?: number;
          requestedAt?: number;
        };
        return parsed.heldAt === undefined && parsed.startedAt !== parsed.requestedAt;
      });

      await expect(pausable.result).resolves.toEqual(
        expect.objectContaining({
          hookSpecificOutput: expect.objectContaining({ permissionDecision: "deny" }),
        }),
      );
      await expect(legacy.result).resolves.toEqual(
        expect.objectContaining({
          hookSpecificOutput: expect.objectContaining({
            decision: expect.objectContaining({ behavior: "deny" }),
          }),
        }),
      );
      expect(await fs.readdir(path.join(sessionRoot, "pending"))).toEqual([]);
      expect(await fs.readdir(path.join(sessionRoot, "hold"))).toEqual([]);

      await invoke(handlers, "claude_tmux_stop", tab, context);
      pollLoopHeld.resolve();
    });
  });
});

test("draining orders multiple turns by occurrence rather than event kind", async () => {
  const backend = {
    readBoundedFile: async () => ({ content: "{}", truncated: false }),
    removeFile: async () => undefined,
  } as unknown as TmuxBackend;
  const paths = { pendingDir: "/pending" } as SessionHookPaths;
  const events = await drainPending(
    backend,
    paths,
    [
      "UserPromptSubmit-1700000000000000003-10.json",
      "StopFailure-1700000000000000002-10.json",
      "UserPromptSubmit-1700000000000000001-10.json",
      "Stop-1700000000000000004-10.json",
    ],
    new Set(),
  );
  expect(events.map((event) => event.kind)).toEqual([
    "UserPromptSubmit",
    "StopFailure",
    "UserPromptSubmit",
    "Stop",
  ]);
});
