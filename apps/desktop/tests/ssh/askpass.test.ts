import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  AskpassBroker,
  MAX_ASKPASS_ANSWER_LENGTH,
  MAX_ASKPASS_PROMPT_LENGTH,
  type SshAskpassPrompt,
} from "@orkestrator/protocol/node/ssh/askpass";
import { createFakeHarness, type FakeHarness } from "./fakes";

const harnesses: FakeHarness[] = [];
const brokers: AskpassBroker[] = [];

afterEach(async () => {
  for (const broker of brokers.splice(0)) await broker.dispose();
  for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function openBroker(
  handler: (prompt: SshAskpassPrompt) => Promise<string | null>,
  promptTimeoutMs?: number,
) {
  const harness = createFakeHarness({
    // Run the real helper with this test runtime (bun or node), not Electron.
    overrides: { askpassRuntime: { command: process.execPath, env: {} } },
  });
  harnesses.push(harness);
  const broker = await AskpassBroker.open(
    harness.context,
    handler,
    promptTimeoutMs === undefined ? {} : { promptTimeoutMs },
  );
  brokers.push(broker);
  return { harness, broker };
}

function request(socketPath: string, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let data = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(payload));
    socket.on("data", (chunk: string) => (data += chunk));
    socket.on("close", () => resolve(data));
    socket.on("error", reject);
  });
}

function runHelper(broker: AskpassBroker, prompt: string, extraEnv: Record<string, string> = {}) {
  return new Promise<{ code: number | null; stdout: string }>((resolve) => {
    const child = spawn("/bin/sh", [broker.scriptPath, prompt], {
      env: { PATH: process.env.PATH, ...broker.env(), ...extraEnv },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.on("close", (code) => resolve({ code, stdout }));
  });
}

describe("AskpassBroker", () => {
  test("creates private files and per-tunnel environment", async () => {
    const { broker } = await openBroker(async () => null);
    const env = broker.env();
    expect(env.SSH_ASKPASS).toBe(broker.scriptPath);
    expect(env.SSH_ASKPASS_REQUIRE).toBe("force");
    expect(env.ORKESTRATOR_ASKPASS_SOCKET).toBe(broker.socketPath);
    expect(env.ORKESTRATOR_ASKPASS_NONCE).toMatch(/^[0-9a-f]{64}$/);
    expect(env.DISPLAY).toBe(":0");
    expect(statSync(path.dirname(broker.scriptPath)).mode & 0o777).toBe(0o700);
    expect(statSync(broker.scriptPath).mode & 0o777).toBe(0o700);
  });

  test("the real helper round-trips an answer through ssh's askpass contract", async () => {
    const seen: SshAskpassPrompt[] = [];
    const { broker } = await openBroker(async (prompt) => {
      seen.push(prompt);
      return "correct horse";
    });
    const result = await runHelper(broker, "Enter passphrase for key '/home/a/.ssh/id':\u0007 ");
    expect(result).toEqual({ code: 0, stdout: "correct horse\n" });
    expect(seen[0]!.kind).toBe("passphrase");
    expect(seen[0]!.message).toBe("Enter passphrase for key '/home/a/.ssh/id':");
    expect(broker.promptsShown).toBe(1);
  });

  test("a cancelled prompt makes the helper exit non-zero", async () => {
    const { broker } = await openBroker(async () => null);
    const result = await runHelper(broker, "alice@h's password: ");
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(broker.promptsCancelled).toBe(1);
  });

  test("confirm prompts are classified from SSH_ASKPASS_PROMPT", async () => {
    const kinds: string[] = [];
    const { broker } = await openBroker(async (prompt) => {
      kinds.push(prompt.kind);
      return "";
    });
    await runHelper(broker, "Allow use of key?", { SSH_ASKPASS_PROMPT: "confirm" });
    expect(kinds).toEqual(["confirm"]);
  });

  test("rejects a client without the nonce and never calls the handler", async () => {
    let calls = 0;
    const { broker } = await openBroker(async () => {
      calls += 1;
      return "secret";
    });
    const reply = await request(
      broker.socketPath,
      `${JSON.stringify({ nonce: "0".repeat(64), prompt: "Password:" })}\n`,
    );
    expect(JSON.parse(reply)).toEqual({ ok: false });
    expect(broker.rejectedConnections).toBe(1);
    expect(calls).toBe(0);
  });

  test("bounds prompt and answer sizes", async () => {
    let calls = 0;
    const { broker } = await openBroker(async () => {
      calls += 1;
      return "x".repeat(MAX_ASKPASS_ANSWER_LENGTH + 1);
    });
    const nonce = broker.env().ORKESTRATOR_ASKPASS_NONCE!;
    const longPrompt = await request(
      broker.socketPath,
      `${JSON.stringify({ nonce, prompt: "p".repeat(MAX_ASKPASS_PROMPT_LENGTH + 1) })}\n`,
    );
    expect(JSON.parse(longPrompt)).toEqual({ ok: false });
    expect(calls).toBe(0);

    const oversized = await request(broker.socketPath, "x".repeat(6_000));
    expect(oversized).toContain('"ok":false');
    expect(broker.rejectedConnections).toBe(1);

    const longAnswer = await request(
      broker.socketPath,
      `${JSON.stringify({ nonce, prompt: "Password:" })}\n`,
    );
    expect(JSON.parse(longAnswer)).toEqual({ ok: false });
    expect(calls).toBe(1);
  });

  test("times out an unanswered prompt", async () => {
    let aborted = false;
    const { broker } = await openBroker(
      (prompt) =>
        new Promise((resolve) =>
          prompt.signal.addEventListener("abort", () => {
            aborted = true;
            resolve("too late");
          }),
        ),
      30,
    );
    const result = await runHelper(broker, "Password:");
    expect(result.code).not.toBe(0);
    expect(aborted).toBe(true);
  });

  test("dispose aborts outstanding prompts and removes the directory", async () => {
    let signal: AbortSignal | undefined;
    const { broker } = await openBroker(
      (prompt) =>
        new Promise((resolve) => {
          signal = prompt.signal;
          prompt.signal.addEventListener("abort", () => resolve(null));
        }),
    );
    const helper = runHelper(broker, "Password:");
    const deadline = Date.now() + 2_000;
    while (!signal && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    expect(broker.activePrompts).toBe(1);
    await broker.dispose();
    expect(signal!.aborted).toBe(true);
    expect((await helper).code).not.toBe(0);
    expect(existsSync(path.dirname(broker.scriptPath))).toBe(false);
  });
});
