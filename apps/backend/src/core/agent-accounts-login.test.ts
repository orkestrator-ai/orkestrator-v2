import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import {
  agentAccountLoginCommand,
  beginAgentAccountLogin,
  parseClaudeLoginOutput,
  parseCodexDeviceLoginOutput,
  type SpawnLike,
} from "./agent-accounts-login.js";

const CLAUDE_OUTPUT = [
  "Opening browser to sign in…",
  "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=s",
  "Paste code here if prompted > ",
].join("\n");

const CODEX_OUTPUT = [
  "Welcome to Codex [v\u001b[90m0.158.0\u001b[0m]",
  "1. Open this link in your browser and sign in to your account",
  "   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m",
  "2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m",
  "   \u001b[94mABCD-EFGH1\u001b[0m",
].join("\n");

describe("login output parsing", () => {
  test("finds Claude's authorize URL", () => {
    expect(parseClaudeLoginOutput(CLAUDE_OUTPUT).url).toBe(
      "https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=s",
    );
    expect(parseClaudeLoginOutput("Opening browser to sign in…")).toEqual({});
  });

  test("finds Codex's verification URL and one-time code through ANSI colour", () => {
    expect(parseCodexDeviceLoginOutput(CODEX_OUTPUT)).toEqual({
      url: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH1",
    });
  });
});

describe("agentAccountLoginCommand", () => {
  test("points Claude at the account and shims the browser opener", () => {
    const command = agentAccountLoginCommand({
      platform: "claude",
      executable: "/bin/claude",
      accountHome: "/data/claude/one",
      browserShimDirectory: "/data/.login-shim",
      env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "k", CLAUDE_CODE_OAUTH_TOKEN: "t" },
    });
    expect(command.args).toEqual(["auth", "login"]);
    expect(command.env.CLAUDE_CONFIG_DIR).toBe("/data/claude/one");
    expect(command.env.PATH).toBe("/data/.login-shim:/usr/bin");
    expect(command.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(command.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  test("uses Codex device auth against the account's home", () => {
    const command = agentAccountLoginCommand({
      platform: "codex",
      executable: "/bin/codex",
      accountHome: "/data/codex/one",
      browserShimDirectory: "/data/.login-shim",
      env: { OPENAI_API_KEY: "k", CODEX_HOME: "/elsewhere" },
    });
    expect(command.args).toEqual(["login", "--device-auth"]);
    expect(command.env.CODEX_HOME).toBe("/data/codex/one");
    expect(command.env.OPENAI_API_KEY).toBeUndefined();
  });
});

type FakeChild = ChildProcess & {
  stdoutStream: PassThrough;
  stdinWrites: string[];
  finish: (code: number | null, signal?: NodeJS.Signals | null) => void;
};

function fakeSpawn(): { spawnImpl: SpawnLike; child: () => FakeChild } {
  let current: FakeChild | undefined;
  const spawnImpl: SpawnLike = () => {
    const emitter = new EventEmitter() as FakeChild;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const writes: string[] = [];
    stdin.on("data", (chunk) => writes.push(chunk.toString()));
    Object.assign(emitter, {
      stdout,
      stderr,
      stdin,
      exitCode: null,
      signalCode: null,
      stdoutStream: stdout,
      stdinWrites: writes,
      kill: (signal: NodeJS.Signals = "SIGTERM") => {
        emitter.finish(null, signal);
        return true;
      },
      finish: (code: number | null, signal: NodeJS.Signals | null = null) => {
        Object.assign(emitter, { exitCode: code, signalCode: signal });
        emitter.emit("exit", code, signal);
      },
    });
    current = emitter;
    return emitter;
  };
  return { spawnImpl, child: () => current! };
}

const command = { command: "cli", args: [], env: {} };

describe("beginAgentAccountLogin", () => {
  test("Claude resolves on the URL, forwards the pasted code and completes on exit 0", async () => {
    const fake = fakeSpawn();
    const started = beginAgentAccountLogin("claude", command, { spawnImpl: fake.spawnImpl });
    fake.child().stdoutStream.write(CLAUDE_OUTPUT);
    const handle = await started;

    expect(handle.needsCode).toBe(true);
    expect(handle.url).toContain("/oauth/authorize");
    handle.submitCode("  abc#def  ");
    await Bun.sleep(0);
    expect(fake.child().stdinWrites.join("")).toBe("abc#def\n");
    expect(() => handle.submitCode("two\nlines")).toThrow();

    fake.child().finish(0);
    await expect(handle.completion).resolves.toBeUndefined();
  });

  test("Codex waits for both the URL and the code", async () => {
    const fake = fakeSpawn();
    let resolved = false;
    const started = beginAgentAccountLogin("codex", command, { spawnImpl: fake.spawnImpl }).then(
      (handle) => {
        resolved = true;
        return handle;
      },
    );
    fake.child().stdoutStream.write("   https://auth.openai.com/codex/device\n");
    await Bun.sleep(5);
    expect(resolved).toBe(false);
    fake.child().stdoutStream.write("   ABCD-EFGH1\n");
    const handle = await started;
    expect(handle).toMatchObject({ userCode: "ABCD-EFGH1", needsCode: false });

    fake.child().finish(1);
    await expect(handle.completion).rejects.toThrow("exit code 1");
  });

  test("fails when the CLI prints nothing usable in time", async () => {
    const fake = fakeSpawn();
    await expect(
      beginAgentAccountLogin("claude", command, {
        spawnImpl: fake.spawnImpl,
        startupTimeoutMs: 10,
      }),
    ).rejects.toThrow("did not start in time");
  });

  test("a cancelled sign-in never completes, even when the CLI exits 0", async () => {
    const fake = fakeSpawn();
    const started = beginAgentAccountLogin("codex", command, { spawnImpl: fake.spawnImpl });
    fake.child().stdoutStream.write(CODEX_OUTPUT);
    const handle = await started;
    // Codex traps SIGTERM and exits cleanly.
    fake.child().kill = (() => {
      fake.child().finish(0);
      return true;
    }) as FakeChild["kill"];

    handle.cancel();

    await expect(handle.completion).rejects.toThrow("cancelled");
  });

  test("an exit before the prompt rejects the start", async () => {
    const fake = fakeSpawn();
    const started = beginAgentAccountLogin("codex", command, { spawnImpl: fake.spawnImpl });
    fake.child().finish(2);
    await expect(started).rejects.toThrow("exit code 2");
  });
});
