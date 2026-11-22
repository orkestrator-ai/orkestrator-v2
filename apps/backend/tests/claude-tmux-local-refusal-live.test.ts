/**
 * A prompt the pinned Claude CLI refuses for its credential still ends with
 * a `StopFailure` hook, so a claude-tmux tab, which leaves working only on
 * `Stop` or `StopFailure` (`TmuxSession.updateBusyFromHookKind`), cannot
 * stick at working after it (to-do 8094, retired).
 *
 * Offline and credential-free: the CLI the Claude bridge's Agent SDK bundles
 * (the pinned build) runs interactively in a private tmux server, as a
 * claude-tmux tab runs it, with an isolated home and Orkestrator's own
 * claude-tmux hook script and settings. Its model is a loopback stand-in that
 * refuses every request with the 401 a wrong key gets, marked not retryable.
 * Skipped when the pinned CLI is not installed in this checkout or tmux is
 * missing. Nothing is billed and no terminal content is printed.
 */
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { containsSignInNotice, normalizeTerminalText } from "../src/core/claude-terminal-settle.js";
import { TmuxBackend } from "../src/core/tmux/backend.js";
import {
  drainPending,
  ensureSessionDirs,
  hookScript,
  mergeSettingsJson,
  sessionHookPaths,
  workspaceHookPaths,
  type PendingHookEvent,
} from "../src/core/tmux/hooks.js";
import { bundledPinnedClaudeCli } from "./bundled-claude-cli.js";

const cli = bundledPinnedClaudeCli();
const tmuxAvailable = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const READY_MS = 90_000;
const TURN_MS = 60_000;

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** Refuses every model request as a wrong key would, telling the CLI not to retry. */
async function refusingModel(): Promise<{ origin: string; requests: () => number }> {
  let requests = 0;
  const server: Server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      if (request.url?.startsWith("/v1/messages")) requests += 1;
      response.writeHead(401, {
        "content-type": "application/json",
        "x-should-retry": "false",
      });
      response.end(
        JSON.stringify({
          type: "error",
          error: { type: "authentication_error", message: "invalid x-api-key" },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => server.close());
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, requests: () => requests };
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await Bun.sleep(250);
  }
  return false;
}

/**
 * One claude-tmux-shaped CLI: Orkestrator's hook script and
 * `.claude/settings.local.json` in the workspace, as `installWorkspaceHooks`
 * writes them, and the CLI in a tmux server whose socket lives in the fixture.
 */
async function claudeTmuxFixture(origin: string, token: string | undefined) {
  const root = mkdtempSync(join(tmpdir(), "ork-8094-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const config = join(home, ".claude");
  const workspace = join(root, "ws");
  mkdirSync(config, { recursive: true });
  mkdirSync(join(workspace, ".claude"), { recursive: true });

  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: origin,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
    DISABLE_AUTOUPDATER: "1",
  };
  if (token) env.ANTHROPIC_AUTH_TOKEN = token;
  writeFileSync(
    join(config, "settings.json"),
    JSON.stringify({ env, skipDangerousModePermissionPrompt: true }),
  );
  // The first-run screens an interactive CLI would stop at, already answered.
  writeFileSync(
    join(config, ".claude.json"),
    JSON.stringify({
      hasCompletedOnboarding: true,
      bypassPermissionsModeAccepted: true,
      hasSeenAutoDefaultNudge: true,
      projects: { [workspace]: { hasTrustDialogAccepted: true } },
    }),
  );

  const hooks = workspaceHookPaths(join(root, "runtime"), workspace);
  mkdirSync(hooks.sessionsDir, { recursive: true });
  writeFileSync(hooks.script, hookScript(hooks), { mode: 0o755 });
  writeFileSync(hooks.claudeSettings, mergeSettingsJson(undefined, hooks.script));
  const sessionId = randomUUID();
  const paths = sessionHookPaths(hooks, sessionId);
  const backend = TmuxBackend.local(workspace);
  await ensureSessionDirs(backend, paths);

  // A private server: its socket is in the fixture, so nothing else's tmux is touched.
  const tmuxEnv = { ...process.env, TMUX_TMPDIR: root, TMUX: "" };
  const tmux = (...args: string[]) =>
    spawnSync("tmux", ["-L", "ork-8094", ...args], { encoding: "utf8", env: tmuxEnv });
  const command = [
    "exec env -i",
    `PATH='${process.env.PATH ?? "/usr/bin:/bin"}'`,
    "TERM=xterm-256color LANG=en_US.UTF-8",
    `HOME='${home}' CLAUDE_CONFIG_DIR='${config}'`,
    `'${cli}' --dangerously-skip-permissions --session-id ${sessionId}`,
  ].join(" ");
  const started = tmux(
    "new-session",
    "-d",
    "-s",
    "claude",
    "-x",
    "160",
    "-y",
    "45",
    "-c",
    workspace,
    command,
  );
  expect(started.status).toBe(0);
  cleanups.push(() => void tmux("kill-server"));
  const pane = () => tmux("capture-pane", "-p", "-t", "claude").stdout ?? "";

  const emitted = new Set<string>();
  const drain = async (): Promise<PendingHookEvent[]> => {
    const names = readdirSync(paths.pendingDir);
    return drainPending(backend, paths, names, emitted);
  };

  /** Submits one prompt and returns the hooks of its turn once it ends, or after `TURN_MS`. */
  const prompt = async (text: string) => {
    tmux("send-keys", "-t", "claude", "-l", text);
    await Bun.sleep(300);
    tmux("send-keys", "-t", "claude", "Enter");
    const events: PendingHookEvent[] = [];
    await until(async () => {
      events.push(...(await drain()));
      const kinds = events.map((event) => event.kind);
      return (
        kinds.includes("UserPromptSubmit") &&
        (kinds.includes("Stop") || kinds.includes("StopFailure"))
      );
    }, TURN_MS);
    return events;
  };

  const ready = await until(() => /bypass permissions on/i.test(pane()), READY_MS);
  expect(ready, "the CLI never reached its prompt box").toBe(true);
  await drain();
  return {
    prompt,
    noticeShown: () => containsSignInNotice(normalizeTerminalText(pane())),
  };
}

const turnKinds = (events: PendingHookEvent[]) =>
  events
    .map((event) => event.kind)
    .filter((kind) => kind === "UserPromptSubmit" || kind === "Stop" || kind === "StopFailure");

test.skipIf(!cli || !tmuxAvailable)(
  "a signed-out CLI refuses a prompt locally and still fires StopFailure",
  async () => {
    const model = await refusingModel();
    const tab = await claudeTmuxFixture(model.origin, undefined);
    for (const text of ["first prompt while signed out", "second prompt while signed out"]) {
      const events = await tab.prompt(text);
      expect(turnKinds(events)).toEqual(["UserPromptSubmit", "StopFailure"]);
      expect(tab.noticeShown()).toBe(true);
    }
    // Refused locally: the CLI never asked the model.
    expect(model.requests()).toBe(0);
  },
  READY_MS + 3 * TURN_MS,
);

test.skipIf(!cli || !tmuxAvailable)(
  "after a refused login the next prompt is sent and fires StopFailure",
  async () => {
    const model = await refusingModel();
    const tab = await claudeTmuxFixture(model.origin, "fixture-only-not-a-key");
    let before = 0;
    for (const text of ["first prompt the model refuses", "next prompt after the refusal"]) {
      const events = await tab.prompt(text);
      expect(turnKinds(events)).toEqual(["UserPromptSubmit", "StopFailure"]);
      expect(tab.noticeShown()).toBe(true);
      // Sent to the model rather than refused locally.
      expect(model.requests()).toBeGreaterThan(before);
      before = model.requests();
    }
  },
  READY_MS + 3 * TURN_MS,
);
