import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { join } from "node:path";

const fakeCodex = join(import.meta.dir, "fake-codex-app-server.mjs");

async function runOnce(args: string[]): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  const child = spawn(process.execPath, [fakeCodex, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const code = await new Promise<number | null>((resolve) => {
    child.once("close", resolve);
  });
  return {
    code,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`condition not met within ${timeoutMs}ms`));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}

describe("fake Codex app-server process", () => {
  test("reports its version and rejects unsupported invocations", async () => {
    expect(await runOnce(["--version"])).toMatchObject({
      code: 0,
      stdout: "codex-cli 0.145.0\n",
      stderr: "",
    });
    const unsupported = await runOnce(["exec"]);
    expect(unsupported.code).toBe(2);
    expect(unsupported.stderr).toContain("unsupported invocation: exec");
  });

  test("covers handshake, thread, model, turn, interrupt, and error handlers", async () => {
    const child = spawn(process.execPath, [fakeCodex, "app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const messages: Array<Record<string, unknown>> = [];
    let buffered = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) messages.push(JSON.parse(line) as Record<string, unknown>);
      }
    });

    const send = (message: unknown) => {
      child.stdin.write(`${typeof message === "string" ? message : JSON.stringify(message)}\n`);
    };
    const request = (id: number, method: string, params: unknown = {}) => {
      send({ jsonrpc: "2.0", id, method, params });
    };

    try {
      send("{malformed");
      request(1, "thread/list");
      request(2, "initialize", { clientInfo: { name: "test", version: "1" } });
      send({ jsonrpc: "2.0", method: "initialized", params: {} });
      request(3, "thread/start", { cwd: "/tmp/fake-workspace", model: "chosen-model" });
      request(4, "thread/resume", { threadId: "resumed-thread" });
      request(5, "thread/read", { threadId: "read-thread" });
      request(6, "thread/list");
      request(7, "thread/unsubscribe", { threadId: "fake-thread-1" });
      request(8, "thread/name/set", { threadId: "fake-thread-1", name: "Named" });
      request(9, "model/list");
      request(10, "turn/start", { threadId: "fake-thread-1", input: [] });
      request(11, "turn/interrupt", {
        threadId: "fake-thread-1",
        turnId: "fake-turn-1",
      });
      request(12, "unknown/method");
      send({ jsonrpc: "2.0", method: "client/notification", params: {} });

      await waitFor(() => {
        const responseIds = new Set(
          messages.filter((message) => "id" in message).map((message) => message.id),
        );
        const interrupted = messages.some(
          (message) =>
            message.method === "turn/completed" &&
            (message.params as { turn?: { status?: string } } | undefined)?.turn?.status ===
              "interrupted",
        );
        return responseIds.size === 12 && interrupted;
      });

      const response = (id: number) => messages.find((message) => message.id === id)!;
      expect(response(1).error).toMatchObject({
        code: -32600,
        message: "initialize/initialized handshake not complete",
      });
      expect(response(2).result).toMatchObject({ platformFamily: "unix" });
      expect(response(3).result).toMatchObject({
        thread: { id: "fake-thread-1", cwd: "/tmp/fake-workspace" },
        model: "chosen-model",
      });
      expect(response(4).result).toMatchObject({
        thread: { id: "resumed-thread" },
      });
      expect(response(5).result).toMatchObject({
        thread: { id: "read-thread" },
      });
      expect(response(6).result).toEqual({
        data: [],
        nextCursor: null,
        backwardsCursor: null,
      });
      expect(response(7).result).toEqual({});
      expect(response(8).result).toEqual({});
      expect(response(9).result).toMatchObject({
        data: [{ id: "fake-model" }],
        nextCursor: null,
      });
      expect(response(10).result).toMatchObject({
        turn: { id: "fake-turn-1", status: "inProgress" },
      });
      expect(response(11).result).toEqual({});
      expect(response(12).error).toMatchObject({
        code: -32601,
        message: "unknown method unknown/method",
      });
      expect(messages.some((message) => message.method === "thread/started")).toBe(true);
      expect(messages.some((message) => message.method === "turn/started")).toBe(true);
    } finally {
      child.stdin.end();
      await Promise.race([
        new Promise<void>((resolve) => child.once("close", () => resolve())),
        new Promise<void>((resolve) => {
          setTimeout(() => {
            child.kill();
            resolve();
          }, 1_000);
        }),
      ]);
    }
  });
});
