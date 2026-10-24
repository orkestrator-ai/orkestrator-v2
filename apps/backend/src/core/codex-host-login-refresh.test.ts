import { afterEach, beforeEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { spawn } from "node:child_process";
import type { CommandContext } from "./commands-context.js";
import { createCodexLoginRefresher, refreshHostCodexLogin } from "./codex-host-login-refresh.js";

let root: string;
let context: CommandContext;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-codex-refresh-"));
  context = {
    appRoot: root,
    resourceRoot: root,
    runtimeFlavor: "production",
    storage: { getDataDir: () => root },
  } as unknown as CommandContext;
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function auth(expiry: number) {
  const access_token = `e30.${Buffer.from(JSON.stringify({ exp: expiry / 1000 })).toString("base64url")}.sig`;
  return JSON.stringify({ tokens: { access_token, refresh_token: "owner-refresh" } });
}

test("rechecks due logins inside the home lock and backs off failed renewal", async () => {
  let now = 1_000_000;
  await fs.writeFile(path.join(root, "auth.json"), auth(now - 1_000));
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const refresh = createCodexLoginRefresher(
    context,
    async () => {
      calls++;
      await gate;
    },
    () => now,
  );
  const first = refresh(root);
  const second = refresh(path.join(root, "."));
  expect(first).toBe(second);
  release();
  await Promise.all([first, second]);
  expect(calls).toBe(1);
  await refresh(root);
  expect(calls).toBe(1);
  now += 60_000;
  await refresh(root);
  expect(calls).toBe(2);
  await fs.writeFile(path.join(root, "auth.json"), auth(now + 3600_000));
  await refresh(root);
  expect(calls).toBe(2);
  await fs.writeFile(path.join(root, "auth.json"), '{"OPENAI_API_KEY":"key"}');
  await refresh(root);
  expect(calls).toBe(2);
  const isolated = createCodexLoginRefresher(
    { ...context, runtimeFlavor: "agent-test" },
    async () => {
      throw new Error("must not refresh");
    },
  );
  await isolated(root);
});

test("uses the owner home and the managed-auth RPC, without starting any thread", async () => {
  const sent: Array<Record<string, unknown>> = [];
  let killed = 0;
  const spawnImpl = ((_binary: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    expect(args).toContain("app-server");
    expect(options.env.CODEX_HOME).toBe(root);
    expect(options.env.OPENAI_API_KEY).toBeUndefined();
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => {
        killed++;
        return true;
      },
    });
    child.stdin.on("data", (data) => {
      const request = JSON.parse(data.toString());
      sent.push(request);
      if (request.id)
        queueMicrotask(() =>
          child.stdout.write(
            `${JSON.stringify({ id: request.id, result: request.id === 1 ? {} : { account: { type: "chatgpt" } } })}\n`,
          ),
        );
    });
    return child;
  }) as unknown as typeof spawn;
  await refreshHostCodexLogin(context, root, spawnImpl);
  expect(sent.map((request) => request.method)).toEqual([
    "initialize",
    "initialized",
    "account/read",
  ]);
  expect(sent[2]?.params).toEqual({ refreshToken: true });
  expect(killed).toBe(1);
});

test("RPC errors are fixed diagnostics and the child is terminated", async () => {
  let killed = false;
  const spawnImpl = (() => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => {
        killed = true;
        return true;
      },
    });
    queueMicrotask(() => child.stdout.write('{"id":1,"error":{"message":"SECRET"}}\n'));
    return child;
  }) as unknown as typeof spawn;
  await expect(refreshHostCodexLogin(context, root, spawnImpl)).rejects.toThrow(
    "Host Codex login refresh failed",
  );
  expect(killed).toBe(true);
});
