import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PINNED_TOOLCHAIN_VERSIONS } from "@orkestrator/toolchain/manifest";
import {
  CLAUDE_SIGN_IN_NOTICES,
  CLAUDE_SIGN_IN_NOTICE_QUIET_MS,
  CLAUDE_STATE_SETTLE_SCRIPT,
  SignInNoticeWatch,
  claudeStateSettleCommand,
  containsSignInNotice,
  normalizeTerminalText,
  terminalOutputMarks,
  type ClaudeTerminalScreens,
} from "./claude-terminal-settle.js";

/**
 * The bytes the pinned CLI (2.1.319) wrote to its PTY for the notice, recorded
 * on 2026-11-16 against a loopback fake API: a colour, the text with real
 * spaces, then a carriage return and a cursor move to the next row.
 */
const RECORDED_NOTICE =
  "\x1b[38;5;246m  ⎿  \x1b[38;5;211mNot logged in · Please run /login\r\x1b[2B\x1b[38;5;246m✻\x1b[3GCooked for 2m 59s";

describe("sign-in notice matching", () => {
  test("matches the notice as the CLI renders it", () => {
    expect(containsSignInNotice(normalizeTerminalText(RECORDED_NOTICE))).toBe(true);
  });

  test("matches cursor moves for spaces, a wrapped line and the other notice", () => {
    expect(
      containsSignInNotice(
        normalizeTerminalText("Not\x1b[1Clogged\x1b[1Cin\x1b[1C·\x1b[1CPlease run\r\n /login"),
      ),
    ).toBe(true);
    expect(
      containsSignInNotice(
        normalizeTerminalText(
          "\x1b]8;;https://x\x07Authentication required · Sign in again to continue\x1b]8;;\x07",
        ),
      ),
    ).toBe(true);
  });

  test("does not match other refusals or a partial notice", () => {
    for (const text of [
      "Invalid API key · Fix external API key",
      "Not logged in. Environment-management endpoints require the operator OAuth session",
      "Not logged in · Please run",
      "401 invalid x-api-key · Retrying in 2s · attempt 4/10",
    ]) {
      expect(containsSignInNotice(normalizeTerminalText(text))).toBe(false);
    }
  });
});

/** A container's terminals with appendable output, revisioned as `TerminalRuntime` does. */
function fakeScreens() {
  const sessions = new Map<string, Array<{ revision: number; text: string }>>();
  const screens: ClaudeTerminalScreens = {
    containerSessionIds: () => Array.from(sessions.keys()),
    outputRevision: (id) => sessions.get(id)?.at(-1)?.revision ?? 0,
    retainedOutputDeltas: (id) => sessions.get(id) ?? [],
  };
  return {
    screens,
    open: (id: string) => sessions.set(id, []),
    print: (id: string, text: string) => {
      const deltas = sessions.get(id)!;
      deltas.push({ revision: (deltas.at(-1)?.revision ?? 0) + 1, text });
    },
  };
}

describe("SignInNoticeWatch", () => {
  test("settles only once the terminal has been quiet after the notice", () => {
    const t = fakeScreens();
    t.open("a");
    t.print("a", "❯ prompt\r\n");
    const watch = new SignInNoticeWatch(3, 0, terminalOutputMarks(t.screens, "c"), 0);
    t.print("a", "\x1b[38;5;211mNot logged in · Pl");
    t.print("a", "ease run /login\r\n");
    expect(watch.refused(t.screens, "c", 1_000)).toBe(false);
    // The prompt box redraws after the notice; quiet counts from the last output.
    t.print("a", "❯ ");
    expect(watch.refused(t.screens, "c", 2_000)).toBe(false);
    expect(watch.refused(t.screens, "c", 2_000 + CLAUDE_SIGN_IN_NOTICE_QUIET_MS - 1)).toBe(false);
    expect(watch.refused(t.screens, "c", 2_000 + CLAUDE_SIGN_IN_NOTICE_QUIET_MS)).toBe(true);
  });

  test("a terminal that keeps printing, as a running turn's spinner does, never settles", () => {
    const t = fakeScreens();
    t.open("a");
    const watch = new SignInNoticeWatch(3, 0, terminalOutputMarks(t.screens, "c"), 0);
    t.print("a", "Not logged in · Please run /login");
    for (let now = 1_000; now <= 30_000; now += 1_000) {
      t.print("a", "✻ Working…");
      expect(watch.refused(t.screens, "c", now)).toBe(false);
    }
  });

  test("a notice printed before the marks belongs to an earlier prompt", () => {
    const t = fakeScreens();
    t.open("a");
    t.print("a", "Not logged in · Please run /login\r\n");
    const watch = new SignInNoticeWatch(3, 0, terminalOutputMarks(t.screens, "c"), 0);
    t.print("a", "❯ next prompt\r\n");
    expect(watch.refused(t.screens, "c", 1_000)).toBe(false);
    expect(watch.refused(t.screens, "c", 60_000)).toBe(false);
  });

  test("a terminal opened after the marks is read from its start", () => {
    const t = fakeScreens();
    const watch = new SignInNoticeWatch(3, 0, terminalOutputMarks(t.screens, "c"), 0);
    t.open("late");
    t.print("late", "Not logged in · Please run /login");
    expect(watch.refused(t.screens, "c", 1_000)).toBe(false);
    expect(watch.refused(t.screens, "c", 1_000 + CLAUDE_SIGN_IN_NOTICE_QUIET_MS)).toBe(true);
  });
});

describe("claudeStateSettleCommand", () => {
  test("passes only the observed numbers and the target word in argv", () => {
    const { command, args, options } = claudeStateSettleCommand(
      "abc",
      { revision: 7, completions: 2 },
      "failed",
    );
    expect(command).toBe("docker");
    expect(args).toEqual([
      "exec",
      "abc",
      "sh",
      "-c",
      CLAUDE_STATE_SETTLE_SCRIPT,
      "sh",
      "7",
      "2",
      "failed",
    ]);
    expect(options.timeoutMs).toBeGreaterThan(0);
    expect(() =>
      claudeStateSettleCommand("abc", { revision: -1, completions: 0 }, "idle"),
    ).toThrow();
    expect(() =>
      claudeStateSettleCommand("abc", { revision: 1.5, completions: 0 }, "idle"),
    ).toThrow();
  });
});

const hasFlock = spawnSync("sh", ["-c", "command -v flock"]).status === 0;
const HOOK = join(import.meta.dir, "../../../../docker/orkestrator-state-signal.sh");

describe.skipIf(!hasFlock)("the settle script against the hook's own files", () => {
  let dir: string;
  let stateFile: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ork-settle-"));
    stateFile = join(dir, "state");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const env = () => ({
    ...process.env,
    ORKESTRATOR_STATE_FILE: stateFile,
    ORKESTRATOR_STATE_SIGNAL_CONFIG: join(dir, "absent"),
  });
  const hook = (state: string) =>
    expect(spawnSync("sh", [HOOK, state], { env: env() }).status).toBe(0);
  const settle = (...args: string[]) => {
    const result = spawnSync("sh", ["-c", CLAUDE_STATE_SETTLE_SCRIPT, "sh", ...args], {
      env: env(),
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    return result.stdout;
  };
  const snapshot = () => readFileSync(`${stateFile}-snapshot`, "utf8").trim();

  test("rewrites exactly the observed working snapshot, and the hooks carry on from it", () => {
    hook("working");
    hook("failed");
    hook("working");
    expect(snapshot()).toBe("working 3 0");
    expect(settle("3", "0", "failed")).toBe("settled");
    expect(snapshot()).toBe("failed 4 0");
    expect(readFileSync(stateFile, "utf8").trim()).toBe("idle");
    // A second settle of the same observation finds it moved on.
    expect(settle("3", "0", "failed")).toBe("");
    hook("working");
    hook("waiting");
    expect(snapshot()).toBe("waiting 6 1");
  });

  test("an idle settle keeps the completion count", () => {
    hook("working");
    hook("waiting");
    hook("working");
    expect(settle("3", "1", "idle")).toBe("settled");
    expect(snapshot()).toBe("idle 4 1");
    hook("working");
    expect(snapshot()).toBe("working 5 1");
  });

  test("a snapshot that moved on, or a malformed request, writes nothing", () => {
    expect(settle("1", "0", "failed")).toBe("");
    expect(existsSync(`${stateFile}-snapshot`)).toBe(false);
    hook("working");
    hook("working");
    for (const args of [
      ["1", "0", "failed"],
      ["2", "1", "failed"],
      ["2", "0", "waiting"],
      ["2", "", "failed"],
      ["2;rm", "0", "failed"],
    ]) {
      expect(settle(...args)).toBe("");
    }
    expect(snapshot()).toBe("working 2 0");
    hook("waiting");
    expect(settle("3", "1", "idle")).toBe("");
    expect(snapshot()).toBe("waiting 3 1");
  });
});

/**
 * The notices are the CLI's own fixed text. Read them out of the CLI binary
 * the Claude bridge's Agent SDK bundles when it is the pinned build, so a CLI
 * bump that rewords them fails here instead of silently disabling the settle.
 */
function bundledPinnedCli(): string | undefined {
  try {
    const bridge = createRequire(
      join(import.meta.dir, "../../../../bridges/claude-bridge/package.json"),
    );
    const sdkManifest = bridge.resolve("@anthropic-ai/claude-agent-sdk/package.json");
    const sdk = JSON.parse(readFileSync(sdkManifest, "utf8")) as { claudeCodeVersion?: string };
    if (sdk.claudeCodeVersion !== PINNED_TOOLCHAIN_VERSIONS.claude) return undefined;
    const platform = createRequire(sdkManifest).resolve(
      `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`,
    );
    const binary = join(dirname(platform), process.platform === "win32" ? "claude.exe" : "claude");
    return existsSync(binary) ? binary : undefined;
  } catch {
    return undefined;
  }
}

/** Streams the file so a 300 MB binary is never held whole; a match may span chunks. */
async function fileContainsAny(path: string, needles: Buffer[]): Promise<boolean[]> {
  const found = needles.map(() => false);
  const overlap = Math.max(...needles.map((needle) => needle.length)) - 1;
  let carry = Buffer.alloc(0);
  for await (const chunk of createReadStream(path, { highWaterMark: 4 * 1024 * 1024 })) {
    const window = Buffer.concat([carry, chunk as Buffer]);
    needles.forEach((needle, index) => {
      if (!found[index] && window.includes(needle)) found[index] = true;
    });
    if (found.every(Boolean)) break;
    carry = window.subarray(Math.max(0, window.length - overlap));
  }
  return found;
}

const pinnedCli = bundledPinnedCli();

test.skipIf(!pinnedCli)("the pinned CLI still prints both sign-in notices", async () => {
  // The bundle keeps its JavaScript source; the middle dot is written escaped.
  const results = await Promise.all(
    CLAUDE_SIGN_IN_NOTICES.map(async (notice) => {
      const forms = [notice, notice.replace("·", "\\xB7"), notice.replace("·", "\\u00B7")];
      return (
        await fileContainsAny(
          pinnedCli!,
          forms.map((form) => Buffer.from(form)),
        )
      ).some(Boolean);
    }),
  );
  expect(results).toEqual(CLAUDE_SIGN_IN_NOTICES.map(() => true));
});
